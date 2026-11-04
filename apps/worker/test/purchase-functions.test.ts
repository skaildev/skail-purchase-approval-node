import { beforeEach, describe, expect, it } from "vitest";
import { EventType, type Provider } from "@skail/runtime";
import { createSkailWorker, type SkailWorker } from "@skail/runtime/testing";
import { InMemorySkailPlatform } from "@skail/testing";
import {
  Events,
  Levels,
  type Decision,
  type PurchaseOrder,
  type OrderEvent,
  type OrderResult,
} from "@skail-purchase-approval/contracts";
import { PurchaseFunctions } from "../src/purchase-functions.js";
import { PurchaseOperations } from "../src/purchase-operations.js";
import type { ProgressNotifier } from "../src/web.js";

const WORKLOAD = "purchase-approval:v0.0.1";
const ID = "3f2a9c1e-0000-4000-8000-000000000001";
const PURCHASE: PurchaseOrder = { id: ID, supplier: "Papelaria Central", description: "A4 paper", amount: 18500 };

const decision = (level: string, approved = true, reason: string | null = null): Decision => ({
  level,
  approved,
  by: `${level} user`,
  reason,
  at: "2026-01-01T10:00:00.000Z",
});

class Harness {
  readonly events: OrderEvent[] = [];
  failNotify = 0; // transient failures of the notifier (on ApprovalRequested) before succeeding
  alwaysFailRequest = false;
  readonly platform = new InMemorySkailPlatform();
  readonly worker: SkailWorker;

  constructor() {
    const notifier: ProgressNotifier = {
      notify: async (event) => {
        if (this.alwaysFailRequest && event.stage === "ApprovalRequested") throw new Error("web down");
        if (this.failNotify > 0 && event.stage === "ApprovalRequested") {
          this.failNotify--;
          throw new Error("transient");
        }
        this.events.push(event);
      },
    };
    const providers: Provider[] = [
      { token: PurchaseFunctions, useFactory: () => new PurchaseFunctions(new PurchaseOperations(notifier)) },
    ];
    this.worker = createSkailWorker({
      workload: WORKLOAD,
      types: [PurchaseFunctions],
      providers,
      sidecar: this.platform,
    });
  }

  /** Different deadlines per level prove the arguments (not a constant) drive each delay. */
  start(id = ID, manager = 60, director = 90) {
    this.platform.start(`${WORKLOAD}/ApprovePurchase`, [{ ...PURCHASE, id }, manager, director], id);
  }

  async run() {
    return this.worker.runActivation((await this.platform.consume())!);
  }

  pending(eventType: EventType) {
    return this.platform.history(ID).filter((f) => f.eventType === eventType && !f.targetResult);
  }

  /** Completes the most recent pending delay: the deadline of the level that is waiting. */
  async elapse() {
    const delays = this.pending(EventType.Delay);
    expect(delays.length).toBeGreaterThan(0);
    this.platform.complete(ID, delays.at(-1)!.index);
    return this.run();
  }

  /** What the web app does on a click: fire the event with the Decision as payload. */
  decide(d: Decision, id = ID) {
    this.platform.signal(Events.purchaseDecision, id, d);
  }

  stages(stage: OrderEvent["stage"]) {
    return this.events.filter((e) => e.stage === stage);
  }
}

let h: Harness;
beforeEach(() => {
  h = new Harness();
});

const result = (outcome: Awaited<ReturnType<Harness["run"]>>) => (outcome as { result: OrderResult }).result;

describe("ApprovePurchase: manager within the deadline", () => {
  it("notifies Started, asks only the manager and hibernates on one wait and one delay", async () => {
    h.start();
    expect((await h.run()).status).toBe("hibernated");

    expect(h.stages("Started")).toHaveLength(1);
    expect(h.stages("ApprovalRequested").map((e) => e.level)).toEqual([Levels.manager]);
    expect(h.stages("Escalated")).toHaveLength(0);
    expect(h.pending(EventType.WaitExternalEvent)).toHaveLength(1);
    expect(h.pending(EventType.Delay)).toHaveLength(1);
  });

  it("approves at once, without elapsing the deadline", async () => {
    h.start();
    await h.run();
    h.decide(decision(Levels.manager));

    const outcome = await h.run();
    expect(outcome.status).toBe("completed");
    expect(result(outcome)).toMatchObject({ end: "Approved", reference: "PO-3F2A9C1E" });
    expect(h.stages("Approved")).toHaveLength(1);
    expect(h.stages("Rejected")).toHaveLength(0);
    expect(h.stages("Escalated")).toHaveLength(0);
  });

  it("a rejection is a business result: Rejected with level and reason, no purchase", async () => {
    h.start();
    await h.run();
    h.decide(decision(Levels.manager, false, "fora do orçamento"));

    const outcome = await h.run();
    expect(outcome.status).toBe("completed");
    expect(result(outcome)).toMatchObject({
      end: "Rejected",
      reason: "fora do orçamento",
      decision: { level: Levels.manager },
    });
    expect(h.stages("Rejected")).toHaveLength(1);
    expect(h.stages("Approved")).toHaveLength(0);
  });

  it("serves a decision fired before the function reached the wait (worker was down)", async () => {
    h.start();
    await h.run();
    h.decide(decision(Levels.manager)); // arrives while nobody runs
    expect(result(await h.run())).toMatchObject({ end: "Approved" });
  });
});

describe("ApprovePurchase: escalation", () => {
  it("the manager's deadline escalates to the director, asked exactly once", async () => {
    h.start();
    await h.run();
    const outcome = await h.elapse();

    expect(outcome.status).toBe("hibernated");
    expect(h.stages("ApprovalRequested").map((e) => e.level)).toEqual([Levels.manager]);
    expect(h.stages("Escalated").map((e) => e.level)).toEqual([Levels.director]);
    expect(h.pending(EventType.Delay).length).toBeGreaterThan(0);
  });

  it("the director approves after the escalation (same wait serves the second whenAny)", async () => {
    h.start();
    await h.run();
    await h.elapse();
    h.decide(decision(Levels.director));

    const outcome = await h.run();
    expect(result(outcome)).toMatchObject({ end: "Approved", decision: { level: Levels.director } });
    expect(h.platform.history(ID).filter((f) => f.eventType === EventType.WaitExternalEvent)).toHaveLength(1);
  });

  it("the director rejects after the escalation", async () => {
    h.start();
    await h.run();
    await h.elapse();
    h.decide(decision(Levels.director, false, "não"));

    expect(result(await h.run())).toMatchObject({
      end: "Rejected",
      reason: "não",
      decision: { level: Levels.director },
    });
  });

  it("a decision that arrives after the first deadline is consumed by the second wait", async () => {
    h.start();
    await h.run();
    await h.elapse(); // escalation recorded
    h.decide(decision(Levels.manager)); // late answer: still the one the single wait delivers
    expect(result(await h.run())).toMatchObject({ end: "Approved" });
  });
});

describe("ApprovePurchase: no response", () => {
  it("both deadlines pass: cancelled for no response, not rejected", async () => {
    h.start();
    await h.run();
    await h.elapse();
    const outcome = await h.elapse();

    expect(outcome.status).toBe("completed");
    expect(result(outcome)).toEqual({
      orderId: ID,
      end: "Cancelled",
      reference: null,
      decision: null,
      reason: "no response",
    });
    expect(h.stages("Cancelled")).toHaveLength(1);
    expect(h.stages("Rejected")).toHaveLength(0);
  });
});

describe("ApprovePurchase: durability and isolation", () => {
  it("an event for another order does not wake this one", async () => {
    h.start();
    await h.run();
    expect(() => h.decide(decision(Levels.manager), "other-order")).toThrow();
    expect(h.pending(EventType.WaitExternalEvent)).toHaveLength(1);
  });

  it("asks each level once even after resuming", async () => {
    h.start();
    await h.run();
    await h.elapse();
    h.decide(decision(Levels.director));
    await h.run();

    expect(h.stages("ApprovalRequested")).toHaveLength(1);
    expect(h.stages("Escalated")).toHaveLength(1);
    expect(h.platform.history(ID).filter((f) => f.eventType === EventType.WaitExternalEvent)).toHaveLength(1);
  });

  it("retries a request command that failed once", async () => {
    h.failNotify = 1;
    h.start();
    await h.run();
    for (let i = 0; i < 5 && h.stages("ApprovalRequested").length < 1; i++) {
      h.platform.enqueue(ID);
      await h.run();
    }
    expect(h.stages("ApprovalRequested").map((e) => e.level)).toEqual([Levels.manager]);
  });

  it("reports Failed and rethrows when a command exhausts its retries", async () => {
    h.alwaysFailRequest = true;
    h.start();
    let outcome = await h.run();
    for (let i = 0; i < 10 && outcome.status !== "failed"; i++) {
      h.platform.enqueue(ID);
      outcome = await h.run();
    }
    expect(h.stages("Failed").length).toBeGreaterThan(0);
  });
});
