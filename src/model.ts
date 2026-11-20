// Types of the demo. This file ends up inside the skail bundle: pure code only, no Node imports.

/** The two approval levels, as plain strings: they travel in the payload of an external event. */
export const Levels = { manager: "manager", director: "director" } as const;

export const label = (level: string) => (level === Levels.manager ? "Manager" : "Director");

/** External event name, shared by the function (waitForEvent) and the console (fire). */
export const Events = { purchaseDecision: "PURCHASE_DECISION" } as const;

/** The purchase order that goes into the run history: no sensitive data. */
export interface PurchaseOrder {
  id: string;
  supplier: string;
  description: string;
  amount: number;
}

/**
 * One level's answer, and the payload of the external event. `at` is stamped by whoever fires the event, since the
 * function cannot read the clock.
 */
export interface Decision {
  level: string;
  approved: boolean;
  by: string;
  reason: string | null;
  at: string;
}

/** Skail.whenAny returns the value of the winner: the decision for the event, undefined for the deadline. */
export function isDecision(winner: unknown): winner is Decision {
  return winner !== undefined && winner !== null;
}
