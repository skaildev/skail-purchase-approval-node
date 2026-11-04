// Shared by web, worker and front end. It also goes into the skail bundle, so it holds only types, constants and
// pure functions: `skail build` rejects Node I/O imports.

/** The two approval levels. Plain strings (not an enum): Decision is the payload of an external event. */
export const Levels = {
  manager: "manager",
  director: "director",
  isValid: (level: unknown): level is string => level === "manager" || level === "director",
  /** Label used by the page and by the default approver name. */
  label: (level: string): string => (level === "manager" ? "Manager" : "Director"),
} as const;

/** External event name, shared by the function (waitForEvent) and the web app (fire). */
export const Events = {
  purchaseDecision: "PURCHASE_DECISION",
} as const;

export const OrderLimits = {
  defaultSupplier: "Papelaria Central",
  defaultDescription: "A4 paper reams (50 boxes)",
  defaultAmount: 18500,
  maxTextLength: 120,
  /** Deadline of each level in the demo; the original use case is 48 hours. */
  defaultDeadlineSeconds: 60,
} as const;

/** The purchase order that goes into the function's history: no sensitive data. */
export interface PurchaseOrder {
  id: string;
  supplier: string;
  description: string;
  amount: number;
}

/**
 * One level's answer: the payload of the external event. It only carries what the decision needs. `at`
 * (ISO 8601) is stamped by the web app, since the function cannot read the clock. It is never undefined,
 * null, true or {}: the function tells it from the delay (which completes with undefined) by its shape.
 */
export interface Decision {
  level: string;
  approved: boolean;
  by: string;
  reason: string | null;
  at: string;
}

/** Tells the winner of whenAny: the decision (event) from undefined (the deadline's delay). */
export function isDecision(value: unknown): value is Decision {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.level === "string" &&
    typeof v.approved === "boolean" &&
    typeof v.by === "string" &&
    typeof v.at === "string"
  );
}

export type OrderEnd = "Approved" | "Rejected" | "Cancelled";

export interface OrderResult {
  orderId: string;
  end: OrderEnd;
  reference: string | null;
  decision: Decision | null;
  reason: string | null;
}

export const OrderResult = {
  noResponseReason: "no response",

  /** The reference derives from the id, so a retried command returns the same one. */
  approved: (orderId: string, decision: Decision): OrderResult => ({
    orderId,
    end: "Approved",
    reference: `PO-${orderId.slice(0, 8).toUpperCase()}`,
    decision,
    reason: null,
  }),

  rejected: (orderId: string, decision: Decision): OrderResult => ({
    orderId,
    end: "Rejected",
    reference: null,
    decision,
    reason: decision.reason,
  }),

  /** Nobody answered before the second deadline (different from an explicit rejection). */
  noResponse: (orderId: string): OrderResult => ({
    orderId,
    end: "Cancelled",
    reference: null,
    decision: null,
    reason: OrderResult.noResponseReason,
  }),
};

export type OrderStage =
  "Started" | "ApprovalRequested" | "Escalated" | "Approved" | "Rejected" | "Cancelled" | "Failed";

/** Progress reported by the worker to the web app. The decisions themselves go straight to skail. */
export interface OrderEvent {
  orderId: string;
  stage: OrderStage;
  purchase?: PurchaseOrder | null;
  level?: string | null;
  result?: OrderResult | null;
  error?: string | null;
}

export const OrderEvent = {
  started: (purchase: PurchaseOrder): OrderEvent => ({ orderId: purchase.id, stage: "Started", purchase }),
  approvalRequested: (orderId: string, level: string): OrderEvent => ({ orderId, stage: "ApprovalRequested", level }),
  escalated: (orderId: string, level: string): OrderEvent => ({ orderId, stage: "Escalated", level }),
  approved: (orderId: string, result: OrderResult): OrderEvent => ({ orderId, stage: "Approved", result }),
  rejected: (orderId: string, result: OrderResult): OrderEvent => ({ orderId, stage: "Rejected", result }),
  cancelled: (orderId: string, result: OrderResult): OrderEvent => ({ orderId, stage: "Cancelled", result }),
  failed: (orderId: string, error: string): OrderEvent => ({ orderId, stage: "Failed", error }),
};

// ---- web view (what GET /api/orders/{id} and the SSE stream return) ----

export type OrderPhase =
  "Starting" | "WaitingForManager" | "WaitingForDirector" | "Approved" | "Rejected" | "Cancelled" | "Failed";
export type LevelStatus = "NotRequested" | "Pending" | "Approved" | "Rejected" | "NoResponse";

/** `deadlineSeconds` and `requestedAt` only feed the page's (visual) countdown. */
export interface LevelView {
  level: string;
  status: LevelStatus;
  deadlineSeconds: number;
  requestedAt: string | null;
  by: string | null;
  reason: string | null;
  at: string | null;
}

export interface TimelineEntry {
  kind: string;
  level: string | null;
  text: string;
  at: string;
}

export interface OrderState {
  orderId: string;
  purchase: PurchaseOrder;
  phase: OrderPhase;
  manager: LevelView;
  director: LevelView;
  timeline: TimelineEntry[];
  result: OrderResult | null;
  error: string | null;
}

export interface OrderView extends OrderState {
  active: boolean;
}

export interface AppConfig {
  defaultSupplier: string;
  defaultDescription: string;
  defaultAmount: number;
  managerDeadlineSeconds: number;
  directorDeadlineSeconds: number;
  monitorUrl: string | null;
}

export function isTerminalPhase(phase: OrderPhase): boolean {
  return phase === "Approved" || phase === "Rejected" || phase === "Cancelled" || phase === "Failed";
}

export interface UiState {
  label: string;
  enabled: boolean;
}

/** The order fields and the request button are available only when there is no order in progress. */
export function startState(order: Pick<OrderState, "phase"> | undefined): UiState {
  return !order || isTerminalPhase(order.phase)
    ? { label: "Request approval", enabled: true }
    : { label: "Request approval", enabled: false };
}
