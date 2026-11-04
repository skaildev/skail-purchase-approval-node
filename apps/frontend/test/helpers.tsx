import { act } from "@testing-library/react";
import { OrderResult, type Decision, type LevelView, type OrderView } from "@skail-purchase-approval/contracts";

export const ID = "3f2a9c1e-0000-4000-8000-000000000001";
export const CONFIG = {
  defaultSupplier: "Papelaria Central",
  defaultDescription: "A4 paper reams (50 boxes)",
  defaultAmount: 18500,
  managerDeadlineSeconds: 60,
  directorDeadlineSeconds: 90,
  monitorUrl: null as string | null,
};

export const level = (level: string, patch: Partial<LevelView> = {}): LevelView => ({
  level,
  status: "NotRequested",
  deadlineSeconds: level === "manager" ? 60 : 90,
  requestedAt: null,
  by: null,
  reason: null,
  at: null,
  ...patch,
});

export const decision = (level: string, approved = true, reason: string | null = null): Decision => ({
  level,
  approved,
  by: "Maria",
  reason,
  at: "2026-01-01T10:00:20.000Z",
});

export const view = (patch: Partial<OrderView> = {}): OrderView => {
  const o = {
    orderId: ID,
    purchase: { id: ID, supplier: "ACME", description: "Cadeiras", amount: 1200.5 },
    phase: "WaitingForManager" as OrderView["phase"],
    manager: level("manager", { status: "Pending", requestedAt: "2026-01-01T10:00:00.000Z" }),
    director: level("director"),
    timeline: [{ kind: "Started", level: null, text: "Order sent for approval", at: "2026-01-01T10:00:00.000Z" }],
    result: null as OrderResult | null,
    error: null as string | null,
    ...patch,
  };
  return { ...o, active: !["Approved", "Rejected", "Cancelled", "Failed"].includes(o.phase) };
};

export const escalated = (): OrderView =>
  view({
    phase: "WaitingForDirector",
    manager: level("manager", { status: "NoResponse", requestedAt: "2026-01-01T10:00:00.000Z" }),
    director: level("director", { status: "Pending", requestedAt: "2026-01-01T10:01:00.000Z" }),
  });

export class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onmessage: ((e: MessageEvent) => void) | null = null;
  closed = false;
  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }
  close() {
    this.closed = true;
  }
  emit(data: OrderView) {
    act(() => this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent));
  }
}

export const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
