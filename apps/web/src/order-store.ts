import {
  Levels,
  isTerminalPhase,
  type Decision,
  type LevelView,
  type OrderEvent,
  type OrderResult,
  type OrderState,
  type PurchaseOrder,
} from "@skail-purchase-approval/contracts";

export type DecisionOutcome = "Accepted" | "Duplicate" | "WrongLevel" | "Finished" | "NotFound";

interface Subscriber {
  onState: (state: OrderState) => void;
  onClose: () => void;
}

const newLevel = (level: string, deadlineSeconds: number): LevelView => ({
  level,
  status: "NotRequested",
  deadlineSeconds,
  requestedAt: null,
  by: null,
  reason: null,
  at: null,
});

const levelOf = (o: OrderState, level: string): LevelView => (level === Levels.manager ? o.manager : o.director);

const withLevel = (o: OrderState, level: string, change: (l: LevelView) => LevelView): OrderState =>
  level === Levels.manager ? { ...o, manager: change(o.manager) } : { ...o, director: change(o.director) };

const decided = (l: LevelView): boolean => l.status === "Approved" || l.status === "Rejected";

/**
 * In-memory state of the orders. The durable state lives in skail; this is only the UI view and the
 * "one decision, from the level that is waiting" guard. The decision is registered here when the click
 * arrives (before the fire), and the final result comes from the worker.
 */
export class OrderStore {
  readonly #orders = new Map<string, OrderState>();
  readonly #subscribers = new Map<string, Set<Subscriber>>();

  constructor(private readonly now: () => string = () => new Date().toISOString()) {}

  create(purchase: PurchaseOrder, managerDeadlineSeconds: number, directorDeadlineSeconds: number): OrderState {
    const order: OrderState = {
      orderId: purchase.id,
      purchase,
      phase: "Starting",
      manager: newLevel(Levels.manager, managerDeadlineSeconds),
      director: newLevel(Levels.director, directorDeadlineSeconds),
      timeline: [],
      result: null,
      error: null,
    };
    this.#orders.set(purchase.id, order);
    return order;
  }

  get(orderId: string): OrderState | undefined {
    return this.#orders.get(orderId);
  }

  remove(orderId: string): void {
    this.#orders.delete(orderId);
    this.#close(orderId);
  }

  /**
   * Registers a decision. Only the level that is waiting can decide, and the first decision wins: a decision
   * from the other level, a second one, or one after the order finished is refused so no second event is fired.
   */
  tryDecide(orderId: string, d: Decision): DecisionOutcome {
    const order = this.#orders.get(orderId);
    if (!order) return "NotFound";
    if (isTerminalPhase(order.phase)) return "Finished";
    if (levelOf(order, d.level).status !== "Pending")
      return decided(order.manager) || decided(order.director) ? "Duplicate" : "WrongLevel";

    const verb = d.approved ? "approved" : "rejected";
    const reason = d.approved || !d.reason?.trim() ? "" : `: ${d.reason}`;
    const next = withLevel(order, d.level, (l) => ({
      ...l,
      status: d.approved ? "Approved" : "Rejected",
      by: d.by,
      reason: d.reason,
      at: d.at,
    }));
    this.#publish(
      this.#add(
        next,
        d.approved ? "Approved" : "Rejected",
        d.level,
        `${Levels.label(d.level)} ${verb} (${d.by})${reason}`,
      ),
    );
    return "Accepted";
  }

  /** Undoes tryDecide when the fire failed, so the same level can try again. */
  release(orderId: string, level: string): void {
    const order = this.#orders.get(orderId);
    if (!order || isTerminalPhase(order.phase) || !decided(levelOf(order, level))) return;

    const timeline = [...order.timeline];
    const last = timeline
      .map((t) => t.level === level && (t.kind === "Approved" || t.kind === "Rejected"))
      .lastIndexOf(true);
    if (last >= 0) timeline.splice(last, 1);
    this.#publish(
      withLevel({ ...order, timeline }, level, (l) => ({ ...l, status: "Pending", by: null, reason: null, at: null })),
    );
  }

  /** @returns true when the event changed the order; false when ignored (unknown or finished order, duplicate). */
  apply(event: OrderEvent): boolean {
    const order = this.#orders.get(event.orderId);
    if (!order || isTerminalPhase(order.phase)) return false;

    let next: OrderState | null = null;
    switch (event.stage) {
      case "Started":
        if (order.phase === "Starting")
          next = this.#add({ ...order, phase: "WaitingForManager" }, "Started", null, "Order sent for approval");
        break;
      case "ApprovalRequested":
        if (event.level === Levels.manager && order.manager.status === "NotRequested") {
          const pending = withLevel(order, Levels.manager, (l) => ({
            ...l,
            status: "Pending",
            requestedAt: this.now(),
          }));
          next = this.#add(
            { ...pending, phase: order.phase === "Starting" ? "WaitingForManager" : order.phase },
            "Requested",
            Levels.manager,
            "Approval requested from the Manager",
          );
        }
        break;
      case "Escalated":
        if (event.level === Levels.director && order.director.status === "NotRequested") next = this.#escalate(order);
        break;
      case "Approved":
        if (event.result)
          next = this.#add(
            { ...order, phase: "Approved", result: event.result },
            "Completed",
            null,
            `Purchase approved (${event.result.reference})`,
          );
        break;
      case "Rejected":
        if (event.result) {
          const r = event.result;
          const by = Levels.label(r.decision?.level ?? "");
          next = this.#add(
            { ...order, phase: "Rejected", result: r },
            "Completed",
            null,
            `Purchase rejected by the ${by}${r.reason?.trim() ? ` (${r.reason})` : ""}`,
          );
        }
        break;
      case "Cancelled":
        if (event.result) next = this.#cancel(order, event.result);
        break;
      case "Failed": {
        const error = event.error ?? "unknown error";
        next = this.#add({ ...order, phase: "Failed", error }, "Failed", null, error);
        break;
      }
    }
    if (!next) return false;
    this.#publish(next);
    return true;
  }

  /** @returns the unsubscribe function. `onClose` is called when the order ends or is removed. */
  subscribe(orderId: string, onState: (state: OrderState) => void, onClose: () => void): () => void {
    const subscriber: Subscriber = { onState, onClose };
    let set = this.#subscribers.get(orderId);
    if (!set) this.#subscribers.set(orderId, (set = new Set()));
    set.add(subscriber);
    return () => void this.#subscribers.get(orderId)?.delete(subscriber);
  }

  #escalate(order: OrderState): OrderState {
    // a manager decision that raced the deadline keeps its status (skail consumes it at the second wait);
    // otherwise the manager did not answer and the director is now the one waiting
    if (decided(order.manager))
      return this.#add(order, "Escalated", Levels.director, "Deadline passed; the Manager's decision arrived in time");

    const next = withLevel(
      withLevel(order, Levels.manager, (l) => ({ ...l, status: "NoResponse" })),
      Levels.director,
      (l) => ({ ...l, status: "Pending", requestedAt: this.now() }),
    );
    return this.#add(
      { ...next, phase: "WaitingForDirector" },
      "Escalated",
      Levels.director,
      "No response from the Manager: escalated to the Director",
    );
  }

  #cancel(order: OrderState, r: OrderResult): OrderState {
    // whoever was still waiting never answered
    const noAnswer = (l: LevelView): LevelView => (l.status === "Pending" ? { ...l, status: "NoResponse" } : l);
    const next: OrderState = {
      ...order,
      phase: "Cancelled",
      result: r,
      manager: noAnswer(order.manager),
      director: noAnswer(order.director),
    };
    return this.#add(next, "Cancelled", null, "Order cancelled: no response from the Manager or the Director");
  }

  #add(order: OrderState, kind: string, level: string | null, text: string): OrderState {
    return { ...order, timeline: [...order.timeline, { kind, level, text, at: this.now() }] };
  }

  #publish(state: OrderState): void {
    this.#orders.set(state.orderId, state);
    for (const subscriber of [...(this.#subscribers.get(state.orderId) ?? [])]) subscriber.onState(state);
    if (isTerminalPhase(state.phase)) this.#close(state.orderId);
  }

  #close(orderId: string): void {
    const set = this.#subscribers.get(orderId);
    if (!set) return;
    this.#subscribers.delete(orderId);
    for (const subscriber of set) subscriber.onClose();
  }
}
