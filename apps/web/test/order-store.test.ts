import { beforeEach, describe, expect, it } from "vitest";
import {
  OrderEvent,
  OrderResult,
  type Decision,
  type OrderState,
  type PurchaseOrder,
} from "@skail-purchase-approval/contracts";
import { OrderStore } from "../src/order-store.js";

const ID = "3f2a9c1e-0000-4000-8000-000000000001";
const purchase: PurchaseOrder = { id: ID, supplier: "F", description: "D", amount: 100 };
const decision = (level: string, approved = true, reason: string | null = null): Decision => ({
  level,
  approved,
  by: `${level} user`,
  reason,
  at: "2026-01-01T10:00:00.000Z",
});

let store: OrderStore;
let tick: number;
beforeEach(() => {
  tick = 0;
  store = new OrderStore(() => new Date(Date.UTC(2026, 0, 1, 10, 0, tick++)).toISOString());
  store.create(purchase, 60, 90);
});

const get = () => store.get(ID)!;
const requested = () => {
  store.apply(OrderEvent.started(purchase));
  store.apply(OrderEvent.approvalRequested(ID, "manager"));
};
const escalated = () => {
  requested();
  store.apply(OrderEvent.escalated(ID, "director"));
};

describe("OrderStore: creation and request", () => {
  it("starts with both levels not requested and the deadlines of each level", () => {
    expect(get()).toMatchObject({
      phase: "Starting",
      manager: { level: "manager", status: "NotRequested", deadlineSeconds: 60, requestedAt: null },
      director: { level: "director", status: "NotRequested", deadlineSeconds: 90 },
      result: null,
      error: null,
    });
  });

  it("Started moves to WaitingForManager; the request makes the manager Pending and starts its countdown", () => {
    requested();
    expect(get()).toMatchObject({
      phase: "WaitingForManager",
      manager: { status: "Pending" },
      director: { status: "NotRequested" },
    });
    expect(get().manager.requestedAt).not.toBeNull();
    expect(get().timeline.map((t) => t.kind)).toEqual(["Started", "Requested"]);
  });

  it("ignores duplicate events (same order, stage and level)", () => {
    requested();
    expect(store.apply(OrderEvent.started(purchase))).toBe(false);
    expect(store.apply(OrderEvent.approvalRequested(ID, "manager"))).toBe(false);
    expect(get().timeline).toHaveLength(2);
  });
});

describe("OrderStore: escalation", () => {
  it("marks the manager No response and the director Pending, phase WaitingForDirector", () => {
    escalated();
    expect(get()).toMatchObject({
      phase: "WaitingForDirector",
      manager: { status: "NoResponse" },
      director: { status: "Pending" },
    });
    expect(get().director.requestedAt).not.toBeNull();
    expect(store.apply(OrderEvent.escalated(ID, "director"))).toBe(false);
  });

  it("a manager decision that raced the deadline keeps its status and the director is not made Pending", () => {
    requested();
    store.tryDecide(ID, decision("manager"));
    store.apply(OrderEvent.escalated(ID, "director"));
    expect(get()).toMatchObject({
      manager: { status: "Approved" },
      director: { status: "NotRequested" },
      phase: "WaitingForManager",
    });
  });
});

describe("OrderStore.tryDecide", () => {
  it("accepts the pending level and records who, when and why", () => {
    requested();
    expect(store.tryDecide(ID, decision("manager", false, "too expensive"))).toBe("Accepted");
    expect(get().manager).toMatchObject({
      status: "Rejected",
      by: "manager user",
      reason: "too expensive",
      at: "2026-01-01T10:00:00.000Z",
    });
    expect(get().timeline.at(-1)).toMatchObject({
      kind: "Rejected",
      level: "manager",
      text: "Manager rejected (manager user): too expensive",
    });
  });

  it("rejects the wrong level: the director before the escalation, the manager after it", () => {
    requested();
    expect(store.tryDecide(ID, decision("director"))).toBe("WrongLevel");
    store.apply(OrderEvent.escalated(ID, "director"));
    expect(store.tryDecide(ID, decision("manager"))).toBe("WrongLevel");
    expect(store.tryDecide(ID, decision("director"))).toBe("Accepted");
  });

  it("rejects a second decision (first one wins), even from the other level", () => {
    requested();
    expect(store.tryDecide(ID, decision("manager"))).toBe("Accepted");
    expect(store.tryDecide(ID, decision("manager", false))).toBe("Duplicate");
    expect(store.tryDecide(ID, decision("director"))).toBe("Duplicate");
    expect(get().manager.status).toBe("Approved");
  });

  it("rejects after the order finished and for an unknown order", () => {
    requested();
    store.apply(OrderEvent.failed(ID, "x"));
    expect(store.tryDecide(ID, decision("manager"))).toBe("Finished");
    expect(store.tryDecide("nope", decision("manager"))).toBe("NotFound");
  });

  it("release undoes the decision (and its timeline entry) so the level can try again", () => {
    requested();
    store.tryDecide(ID, decision("manager"));
    store.release(ID, "manager");
    expect(get().manager).toMatchObject({ status: "Pending", by: null, reason: null, at: null });
    expect(get().timeline.map((t) => t.kind)).toEqual(["Started", "Requested"]);
    expect(store.tryDecide(ID, decision("manager"))).toBe("Accepted");
  });
});

describe("OrderStore: terminal events", () => {
  it("Approved: phase, result and timeline text with the reference", () => {
    requested();
    store.tryDecide(ID, decision("manager"));
    store.apply(OrderEvent.approved(ID, OrderResult.approved(ID, decision("manager"))));
    expect(get()).toMatchObject({ phase: "Approved", result: { end: "Approved", reference: "PO-3F2A9C1E" } });
    expect(get().timeline.at(-1)!.text).toBe("Purchase approved (PO-3F2A9C1E)");
  });

  it("Rejected: phase and text with level and reason", () => {
    requested();
    store.tryDecide(ID, decision("manager", false, "too expensive"));
    store.apply(OrderEvent.rejected(ID, OrderResult.rejected(ID, decision("manager", false, "too expensive"))));
    expect(get().phase).toBe("Rejected");
    expect(get().timeline.at(-1)!.text).toBe("Purchase rejected by the Manager (too expensive)");
  });

  it("Cancelled: whoever was still waiting is marked No response", () => {
    escalated();
    store.apply(OrderEvent.cancelled(ID, OrderResult.noResponse(ID)));
    expect(get()).toMatchObject({
      phase: "Cancelled",
      manager: { status: "NoResponse" },
      director: { status: "NoResponse" },
    });
    expect(get().timeline.at(-1)!.text).toBe("Order cancelled: no response from the Manager or the Director");
  });

  it("Failed keeps the error; events after the end are ignored", () => {
    requested();
    store.apply(OrderEvent.failed(ID, "boom"));
    expect(get()).toMatchObject({ phase: "Failed", error: "boom" });
    expect(store.apply(OrderEvent.approvalRequested(ID, "manager"))).toBe(false);
    expect(store.apply(OrderEvent.started({ ...purchase, id: "nope" }))).toBe(false);
  });
});

describe("OrderStore.subscribe", () => {
  it("publishes every change and closes at a terminal phase", () => {
    const seen: OrderState[] = [];
    let closed = 0;
    store.subscribe(
      ID,
      (s) => seen.push(s),
      () => closed++,
    );
    requested();
    store.tryDecide(ID, decision("manager"));
    store.apply(OrderEvent.failed(ID, "x"));
    expect(seen.map((s) => s.phase)).toEqual(["WaitingForManager", "WaitingForManager", "WaitingForManager", "Failed"]);
    expect(closed).toBe(1);
  });

  it("unsubscribe stops the updates and remove closes the subscribers", () => {
    const seen: OrderState[] = [];
    let closed = 0;
    const off = store.subscribe(
      ID,
      (s) => seen.push(s),
      () => closed++,
    );
    off();
    requested();
    expect(seen).toHaveLength(0);
    store.subscribe(
      ID,
      () => {},
      () => closed++,
    );
    store.remove(ID);
    expect(closed).toBe(1);
    expect(store.get(ID)).toBeUndefined();
  });
});
