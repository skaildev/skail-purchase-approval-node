import { describe, expect, it } from "vitest";
import { Levels, type Decision, type PurchaseOrder, type OrderEvent } from "@skail-purchase-approval/contracts";
import { PurchaseOperations } from "../src/purchase-operations.js";
import type { ProgressNotifier } from "../src/web.js";

const purchase: PurchaseOrder = {
  id: "3f2a9c1e-0000-4000-8000-000000000001",
  supplier: "F",
  description: "D",
  amount: 10,
};
const decision = (approved: boolean, reason: string | null = null, level: string = Levels.manager): Decision => ({
  level,
  approved,
  by: "Maria",
  reason,
  at: "2026-01-01T10:00:00.000Z",
});

function setup(fail = false) {
  const events: OrderEvent[] = [];
  const notifier: ProgressNotifier = {
    notify: async (e) => {
      if (fail) throw new Error("web down");
      events.push(e);
    },
  };
  return { events, ops: new PurchaseOperations(notifier) };
}

describe("PurchaseOperations.requestApproval", () => {
  it("asks the manager with ApprovalRequested", async () => {
    const { ops, events } = setup();
    await ops.requestApproval(purchase, Levels.manager);
    expect(events).toEqual([{ orderId: purchase.id, stage: "ApprovalRequested", level: "manager" }]);
  });

  it("escalating to the director is the Escalated stage", async () => {
    const { ops, events } = setup();
    await ops.requestApproval(purchase, Levels.director);
    expect(events).toEqual([{ orderId: purchase.id, stage: "Escalated", level: "director" }]);
  });

  it("rejects an unknown level and throws when the delivery fails (skail retries)", async () => {
    await expect(setup().ops.requestApproval(purchase, "ceo")).rejects.toThrow(/ceo/);
    await expect(setup(true).ops.requestApproval(purchase, Levels.manager)).rejects.toThrow(/web down/);
  });
});

describe("PurchaseOperations results", () => {
  it("confirm returns a reference, notifies, and is idempotent", async () => {
    const { ops, events } = setup();
    const a = await ops.confirm(purchase, decision(true));
    const b = await ops.confirm(purchase, decision(true));
    expect(a).toMatchObject({ end: "Approved", reference: "PO-3F2A9C1E" });
    expect(b).toEqual(a);
    expect(events[0]).toMatchObject({ stage: "Approved", result: a });
  });

  it("confirm refuses a rejection", async () => {
    await expect(setup().ops.confirm(purchase, decision(false))).rejects.toThrow();
  });

  it("reject returns level and reason, notifies, and is idempotent", async () => {
    const { ops, events } = setup();
    const d = decision(false, "too expensive", Levels.director);
    const a = await ops.reject(purchase, d);
    expect(a).toMatchObject({ end: "Rejected", reason: "too expensive", decision: { level: "director" } });
    expect(await ops.reject(purchase, d)).toEqual(a);
    expect(events[0]).toMatchObject({ stage: "Rejected" });
  });

  it("reject refuses an approval", async () => {
    await expect(setup().ops.reject(purchase, decision(true))).rejects.toThrow();
  });

  it("cancelForNoResponse returns Cancelled, notifies, and is idempotent", async () => {
    const { ops, events } = setup();
    const a = await ops.cancelForNoResponse(purchase);
    expect(a).toMatchObject({ end: "Cancelled", reason: "no response", decision: null });
    expect(await ops.cancelForNoResponse(purchase)).toEqual(a);
    expect(events[0]).toMatchObject({ stage: "Cancelled" });
  });

  it("reportStatus delegates to the notifier", async () => {
    const { ops, events } = setup();
    await ops.reportStatus({ orderId: purchase.id, stage: "Started", purchase });
    expect(events).toHaveLength(1);
  });
});
