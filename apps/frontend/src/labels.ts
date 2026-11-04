// Texts of the page.
import type { LevelStatus, OrderPhase } from "@skail-purchase-approval/contracts";

export const LEVELS = ["manager", "director"] as const;
export type Level = (typeof LEVELS)[number];

export const LEVEL_LABELS: Record<string, string> = { manager: "Manager", director: "Director" };

export const STATUS_LABELS: Record<LevelStatus, string> = {
  NotRequested: "Not requested",
  Pending: "Pending",
  Approved: "Approved",
  Rejected: "Rejected",
  NoResponse: "No response",
};

export const PHASE_LABELS: Partial<Record<OrderPhase, string>> = {
  Starting: "Starting…",
  WaitingForManager: "Waiting for Manager",
  WaitingForDirector: "Waiting for Director",
};
