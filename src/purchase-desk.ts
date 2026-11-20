import { randomUUID } from "node:crypto";
import { Events, Levels, label, type Decision, type PurchaseOrder } from "./model.js";
import type { SkailApiClient } from "./skail-api.js";
import type { Timeline, TimelineEntry } from "./timeline.js";

/** Deadline of each level: 1 minute in the demo; a real approval would use 48 hours. */
export const DEADLINE_SECONDS = 60;

const sample = { supplier: "Papelaria Central", description: "A4 paper reams (50 boxes)", amount: 18500 };

/**
 * Plays the approvers for the page: it places the purchase order and turns each button into the decision event. Only
 * the level the order is waiting for can decide, and only once. It follows one order at a time, the last one placed
 * (or the one given on the command line).
 */
export class PurchaseDesk {
  private order: PurchaseOrder | null = null;
  private decided = false;

  constructor(
    private readonly skail: SkailApiClient,
    private readonly timeline: Timeline,
  ) {}

  /** Follows an order that already exists, to see it resume. */
  follow(id: string): void {
    this.order = { id, ...sample };
    this.decided = false;
  }

  async place(): Promise<string> {
    const placed = { id: randomUUID(), ...sample };
    await this.skail.trigger(placed, DEADLINE_SECONDS, DEADLINE_SECONDS);
    this.order = placed;
    this.decided = false;
    return placed.id;
  }

  /** Sends the decision of the level the order is waiting for. The first decision wins. */
  async decide(level: string, approved: boolean): Promise<boolean> {
    const order = this.order;
    if (!order || this.decided || waiting(this.timeline.for(order.id)) !== level) return false;
    this.decided = true;

    const decision: Decision = {
      level,
      approved,
      by: label(level),
      reason: approved ? null : "over the budget",
      at: new Date().toISOString(),
    };
    await this.skail.fireDecision(order.id, decision);
    this.timeline.add(
      order.id,
      `${label(level)} ${approved ? "approved" : "rejected"}: ${Events.purchaseDecision} sent`,
      `sent:${level}`,
    );
    return true;
  }

  /** What the page shows: the order, each level and the timeline of the run. */
  view(): unknown {
    const order = this.order;
    if (!order) return { order: null };

    const entries = this.timeline.for(order.id);
    const end = lastStep(entries, "end:");
    const waitingLevel = end === null && !this.decided ? waiting(entries) : null;
    const askedAt = [...entries].reverse().find((e) => e.step === `requested:${waitingLevel}`)?.at;
    return {
      order: {
        ...order,
        waiting: waitingLevel,
        deadline: askedAt ? new Date(Date.parse(askedAt) + DEADLINE_SECONDS * 1000).toISOString() : null,
        end,
      },
      levels: [Levels.manager, Levels.director].map((level) => ({
        level,
        label: label(level),
        status: levelStatus(level, entries, waitingLevel),
        canDecide: waitingLevel === level,
      })),
      timeline: entries.map((e) => ({ at: e.at, text: e.text })),
    };
  }
}

/** The value after the prefix of the last step that has it, or null. */
function lastStep(entries: TimelineEntry[], prefix: string): string | null {
  return (
    [...entries]
      .reverse()
      .find((e) => e.step?.startsWith(prefix))
      ?.step?.slice(prefix.length) ?? null
  );
}

/** The level asked last, which is the one that can decide now. */
function waiting(entries: TimelineEntry[]): string | null {
  return lastStep(entries, "requested:");
}

function levelStatus(level: string, entries: TimelineEntry[], waitingLevel: string | null): string {
  const has = (step: string) => entries.some((e) => e.step === step);
  if (has(`sent:${level}`)) return has("end:approved") ? "approved" : has("end:rejected") ? "rejected" : "decided";
  if (waitingLevel === level) return "waiting";
  if (has(`requested:${level}`)) return "no answer";
  return "not asked";
}
