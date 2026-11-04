import { beforeEach, describe, expect, it } from "vitest";
import { OrderEvent, OrderLimits, type Decision, type PurchaseOrder } from "@skail-purchase-approval/contracts";
import { createApp } from "../src/app.js";
import { OrderStore } from "../src/order-store.js";
import { SkailGatewayError, type SkailGateway } from "../src/gateway.js";

class FakeGateway implements SkailGateway {
  triggers: Array<[PurchaseOrder, number, number]> = [];
  fires: Array<[string, Decision]> = [];
  failTrigger = false;
  failFire = false;
  async trigger(purchase: PurchaseOrder, manager: number, director: number) {
    if (this.failTrigger) throw new SkailGatewayError("skail down");
    this.triggers.push([purchase, manager, director]);
  }
  async fireDecision(id: string, d: Decision) {
    if (this.failFire) throw new SkailGatewayError("skail down");
    this.fires.push([id, d]);
  }
}

let gw: FakeGateway;
let store: OrderStore;
let app: ReturnType<typeof createApp>;
beforeEach(() => {
  gw = new FakeGateway();
  store = new OrderStore();
  app = createApp({
    store,
    gateway: gw,
    monitorUrl: "http://monitor",
    deadlines: { managerSeconds: 45, directorSeconds: 75 },
  });
});

const start = async (payload?: unknown) => {
  const res = await app.inject({ method: "POST", url: "/api/orders", payload: payload as object });
  return { res, body: res.json() };
};
const decide = (id: string, payload: object) =>
  app.inject({ method: "POST", url: `/api/orders/${id}/decision`, payload });
/** The worker's events that bring the manager to Pending. */
const requested = (id: string, purchase: PurchaseOrder) => {
  store.apply(OrderEvent.started(purchase));
  store.apply(OrderEvent.approvalRequested(id, "manager"));
};
const startRequested = async () => {
  const { body } = await start();
  requested(body.orderId, body.purchase);
  return body.orderId as string;
};

describe("web API: config and trigger", () => {
  it("serves config and healthz", async () => {
    expect((await app.inject("/healthz")).body).toBe("ok");
    expect((await app.inject("/api/config")).json()).toEqual({
      defaultSupplier: OrderLimits.defaultSupplier,
      defaultDescription: OrderLimits.defaultDescription,
      defaultAmount: OrderLimits.defaultAmount,
      managerDeadlineSeconds: 45,
      directorDeadlineSeconds: 75,
      monitorUrl: "http://monitor",
    });
  });

  it("triggers with the default data and the deadlines from the configuration", async () => {
    const { body } = await start();
    expect(body).toMatchObject({
      phase: "Starting",
      active: true,
      purchase: { supplier: "Papelaria Central", description: "A4 paper reams (50 boxes)", amount: 18500 },
      manager: { status: "NotRequested", deadlineSeconds: 45 },
      director: { deadlineSeconds: 75 },
    });
    expect(gw.triggers[0]).toEqual([body.purchase, 45, 75]);
    expect(body.orderId).toBe(body.purchase.id);
  });

  it("triggers with informed data (trimmed) and blank fields fall back to the defaults", async () => {
    const informed = (await start({ supplier: "  ACME ", description: " Cadeiras ", amount: 1200.5 })).body.purchase;
    expect(informed).toMatchObject({ supplier: "ACME", description: "Cadeiras", amount: 1200.5 });
    const blank = (await start({ supplier: "  ", description: "", amount: null })).body.purchase;
    expect(blank).toMatchObject({
      supplier: OrderLimits.defaultSupplier,
      description: OrderLimits.defaultDescription,
      amount: 18500,
    });
  });

  it("400 for amount <= 0 or text over 120 characters; 502 on a trigger failure without keeping the order", async () => {
    expect((await start({ amount: 0 })).res.statusCode).toBe(400);
    expect((await start({ amount: -5 })).res.statusCode).toBe(400);
    expect((await start({ supplier: "x".repeat(121) })).res.statusCode).toBe(400);
    expect((await start({ description: "x".repeat(121) })).res.statusCode).toBe(400);
    expect(gw.triggers).toHaveLength(0);

    gw.failTrigger = true;
    const { res } = await start();
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toMatch(/skail down/);
  });
});

describe("web API: decisions", () => {
  it("fires the manager's decision with the level, the time stamped by the web and the default approver name", async () => {
    const id = await startRequested();
    const res = await decide(id, { level: "manager", approved: true });
    expect(res.statusCode).toBe(200);
    expect(gw.fires[0]![0]).toBe(id);
    expect(gw.fires[0]![1]).toMatchObject({ level: "manager", approved: true, by: "Manager team", reason: null });
    expect(Date.parse(gw.fires[0]![1].at)).not.toBeNaN();
    expect(res.json().manager.status).toBe("Approved");
  });

  it("fires the director's rejection with the reason, after the escalation", async () => {
    const id = await startRequested();
    store.apply(OrderEvent.escalated(id, "director"));
    const res = await decide(id, { level: "director", approved: false, by: " Dora ", reason: " too expensive " });
    expect(res.statusCode).toBe(200);
    expect(gw.fires[0]![1]).toMatchObject({ level: "director", approved: false, by: "Dora", reason: "too expensive" });
  });

  it("drops the reason of an approval", async () => {
    const id = await startRequested();
    await decide(id, { level: "manager", approved: true, reason: "ignored" });
    expect(gw.fires[0]![1].reason).toBeNull();
  });

  it("400 for an invalid level, 404 for an unknown order", async () => {
    const id = await startRequested();
    expect((await decide(id, { level: "ceo" })).statusCode).toBe(400);
    expect((await decide(id, {})).statusCode).toBe(400);
    expect((await decide("nope", { level: "manager" })).statusCode).toBe(404);
  });

  it("409 for the wrong level (the director before the escalation, the manager after it), with no fire", async () => {
    const id = await startRequested();
    expect((await decide(id, { level: "director" })).statusCode).toBe(409);
    store.apply(OrderEvent.escalated(id, "director"));
    expect((await decide(id, { level: "manager" })).statusCode).toBe(409);
    expect(gw.fires).toHaveLength(0);
  });

  it("409 on a second decision (no second fire) and after the order ended", async () => {
    const id = await startRequested();
    await decide(id, { level: "manager", approved: true });
    expect((await decide(id, { level: "manager", approved: false })).statusCode).toBe(409);
    expect(gw.fires).toHaveLength(1);
    store.apply(OrderEvent.failed(id, "x"));
    expect((await decide(id, { level: "director", approved: true })).statusCode).toBe(409);
    expect(gw.fires).toHaveLength(1);
  });

  it("a failed fire (502) leaves the decision unmarked so the level can try again", async () => {
    const id = await startRequested();
    gw.failFire = true;
    expect((await decide(id, { level: "manager", approved: true })).statusCode).toBe(502);
    gw.failFire = false;
    expect((await decide(id, { level: "manager", approved: true })).statusCode).toBe(200);
  });
});

describe("web API: worker events and stream", () => {
  it("accepts worker events and returns the state", async () => {
    const { body } = await start();
    const res = await app.inject({
      method: "POST",
      url: `/internal/orders/${body.orderId}/events`,
      payload: OrderEvent.started(body.purchase),
    });
    expect(res.statusCode).toBe(204);
    expect((await app.inject(`/api/orders/${body.orderId}`)).json().phase).toBe("WaitingForManager");
    expect((await app.inject("/api/orders/nope")).statusCode).toBe(404);
  });

  it("uses the id of the route, not the one in the event body", async () => {
    const { body } = await start();
    await app.inject({
      method: "POST",
      url: `/internal/orders/${body.orderId}/events`,
      payload: { ...OrderEvent.started(body.purchase), orderId: "other" },
    });
    expect((await app.inject(`/api/orders/${body.orderId}`)).json().phase).toBe("WaitingForManager");
  });

  it("streams the current state first and ends at a terminal phase", async () => {
    const { body } = await start();
    store.apply(OrderEvent.failed(body.orderId, "x"));
    await app.listen({ port: 0, host: "127.0.0.1" });
    const { port } = app.server.address() as { port: number };
    const res = await fetch(`http://127.0.0.1:${port}/api/orders/${body.orderId}/stream`);
    const text = await res.text();
    expect(text).toMatch(/^data: /);
    expect(JSON.parse(text.slice(6))).toMatchObject({ phase: "Failed", active: false });
    await app.close();
  });

  it("404 on the stream of an unknown order", async () => {
    expect((await app.inject("/api/orders/nope/stream")).statusCode).toBe(404);
  });
});
