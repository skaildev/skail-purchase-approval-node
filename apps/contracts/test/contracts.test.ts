import { describe, expect, it } from "vitest";
import {
  Events,
  Levels,
  OrderEvent,
  OrderLimits,
  OrderResult,
  isDecision,
  isTerminalPhase,
  startState,
  type Decision,
  type PurchaseOrder,
} from "../src/index.js";

const purchase: PurchaseOrder = {
  id: "3f2a9c1e-0000-4000-8000-000000000001",
  supplier: "Papelaria Central",
  description: "A4 paper",
  amount: 18500,
};
const decision = (over: Partial<Decision> = {}): Decision => ({
  level: Levels.manager,
  approved: true,
  by: "Maria",
  reason: null,
  at: "2026-11-01T12:00:00.000Z",
  ...over,
});

describe("Levels", () => {
  it("accepts only manager and director", () => {
    expect(Levels.isValid("manager")).toBe(true);
    expect(Levels.isValid("director")).toBe(true);
    expect(Levels.isValid("ceo")).toBe(false);
    expect(Levels.isValid(undefined)).toBe(false);
  });

  it("labels the levels in English for the page", () => {
    expect(Levels.label("manager")).toBe("Manager");
    expect(Levels.label("director")).toBe("Director");
  });
});

describe("constants", () => {
  it("uses the event name shared by the function and the web app", () => {
    expect(Events.purchaseDecision).toBe("PURCHASE_DECISION");
  });

  it("has the demo defaults", () => {
    expect(OrderLimits.defaultSupplier).toBe("Papelaria Central");
    expect(OrderLimits.defaultDescription).toBe("A4 paper reams (50 boxes)");
    expect(OrderLimits.defaultAmount).toBe(18500);
    expect(OrderLimits.maxTextLength).toBe(120);
    expect(OrderLimits.defaultDeadlineSeconds).toBe(60);
  });
});

describe("isDecision", () => {
  it("recognises a decision", () => {
    expect(isDecision(decision())).toBe(true);
    expect(isDecision(decision({ approved: false, reason: "too expensive" }))).toBe(true);
  });

  it("rejects what a delay (undefined) or a bare fire body would deliver", () => {
    for (const value of [undefined, null, true, {}, "x", 1, { approved: true }]) expect(isDecision(value)).toBe(false);
  });
});

describe("OrderResult", () => {
  it("approved carries a reference derived from the id", () => {
    const r = OrderResult.approved(purchase.id, decision());
    expect(r).toMatchObject({ orderId: purchase.id, end: "Approved", reference: "PO-3F2A9C1E", reason: null });
    expect(OrderResult.approved(purchase.id, decision())).toEqual(r);
  });

  it("rejected carries the decision and its reason", () => {
    const d = decision({ approved: false, reason: "fora do orçamento" });
    expect(OrderResult.rejected(purchase.id, d)).toMatchObject({
      end: "Rejected",
      reference: null,
      decision: d,
      reason: "fora do orçamento",
    });
  });

  it("cancelled for no response is not a rejection", () => {
    expect(OrderResult.noResponse(purchase.id)).toEqual({
      orderId: purchase.id,
      end: "Cancelled",
      reference: null,
      decision: null,
      reason: "no response",
    });
  });
});

describe("OrderEvent", () => {
  it("builds each stage", () => {
    expect(OrderEvent.started(purchase)).toEqual({ orderId: purchase.id, stage: "Started", purchase });
    expect(OrderEvent.approvalRequested(purchase.id, "manager")).toEqual({
      orderId: purchase.id,
      stage: "ApprovalRequested",
      level: "manager",
    });
    expect(OrderEvent.escalated(purchase.id, "director")).toEqual({
      orderId: purchase.id,
      stage: "Escalated",
      level: "director",
    });
    const r = OrderResult.noResponse(purchase.id);
    expect(OrderEvent.cancelled(purchase.id, r)).toEqual({ orderId: purchase.id, stage: "Cancelled", result: r });
    expect(OrderEvent.failed(purchase.id, "boom")).toEqual({ orderId: purchase.id, stage: "Failed", error: "boom" });
  });

  it("survives JSON", () => {
    const evt = OrderEvent.started(purchase);
    expect(JSON.parse(JSON.stringify(evt))).toEqual(evt);
  });
});

describe("startState", () => {
  it("is available with no order or a finished one", () => {
    expect(startState(undefined)).toEqual({ label: "Request approval", enabled: true });
    for (const phase of ["Approved", "Rejected", "Cancelled", "Failed"] as const)
      expect(startState({ phase }).enabled).toBe(true);
  });

  it("is locked while an order is in progress", () => {
    for (const phase of ["Starting", "WaitingForManager", "WaitingForDirector"] as const)
      expect(startState({ phase })).toEqual({ label: "Request approval", enabled: false });
  });

  it("knows the terminal phases", () => {
    expect(isTerminalPhase("Rejected")).toBe(true);
    expect(isTerminalPhase("WaitingForDirector")).toBe(false);
  });
});
