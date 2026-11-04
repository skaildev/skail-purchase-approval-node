import { Skail, SkailCommand, SkailFunction, SkailNonDeterministicError } from "@skail/runtime";
import {
  Events,
  Levels,
  OrderEvent,
  isDecision,
  type Decision,
  type PurchaseOrder,
  type OrderResult,
} from "@skail-purchase-approval/contracts";
import type { PurchaseOperations } from "./purchase-operations.js";

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

// Method names are PascalCase because the skail URI is <workload>/<method>: the web app triggers
// <workload>/ApprovePurchase, and the Monitor lists each step by its method name.
export class PurchaseFunctions {
  constructor(private readonly operations: PurchaseOperations) {}

  /**
   * Asks the manager to approve the order and waits for the decision until a deadline. With no answer it
   * escalates to the director and waits again; with no answer again, it cancels. The deadlines are arguments
   * (recorded in the history) so the same code serves the demo (1 minute) and production (48 hours).
   * Deterministic: the decision comes only from the recorded event (the web app stamps the time).
   */
  @SkailFunction()
  async ApprovePurchase(
    purchase: PurchaseOrder,
    managerDeadlineSeconds: number,
    directorDeadlineSeconds: number,
  ): Promise<OrderResult> {
    try {
      await this.ReportStatus(OrderEvent.started(purchase));
      await this.RequestApproval(purchase, Levels.manager);

      // The wait is created once, without await, and reused in both whenAny.
      const decision = Skail.waitForEvent<Decision>(Events.purchaseDecision, purchase.id);

      // whenAny returns the value of the winner: undefined if the deadline won, the Decision if the event did.
      // Decide by that value, never by a task state: on a resume, a decision that arrived after the deadline would
      // already look completed, and the function would leave the recorded path.
      let winner = await Skail.whenAny([decision, Skail.delaySeconds(managerDeadlineSeconds)]);
      if (!isDecision(winner)) {
        await this.RequestApproval(purchase, Levels.director); // escalation
        winner = await Skail.whenAny([decision, Skail.delaySeconds(directorDeadlineSeconds)]);
      }

      if (!isDecision(winner)) return await this.CancelForNoResponse(purchase);

      return winner.approved
        ? await this.ConfirmPurchase(purchase, winner)
        : await this.RejectPurchase(purchase, winner);
    } catch (error) {
      if (!(error instanceof SkailNonDeterministicError))
        await this.ReportStatus(OrderEvent.failed(purchase.id, errorMessage(error)));
      throw error;
    }
  }

  // The commands only delegate: the logic lives in PurchaseOperations, testable without the runtime.

  @SkailCommand({ retryCount: 3 })
  async RequestApproval(purchase: PurchaseOrder, level: string): Promise<void> {
    await this.operations.requestApproval(purchase, level);
  }

  @SkailCommand({ retryCount: 3 })
  async ConfirmPurchase(purchase: PurchaseOrder, decision: Decision): Promise<OrderResult> {
    return this.operations.confirm(purchase, decision);
  }

  @SkailCommand({ retryCount: 3 })
  async RejectPurchase(purchase: PurchaseOrder, decision: Decision): Promise<OrderResult> {
    return this.operations.reject(purchase, decision);
  }

  @SkailCommand({ retryCount: 3 })
  async CancelForNoResponse(purchase: PurchaseOrder): Promise<OrderResult> {
    return this.operations.cancelForNoResponse(purchase);
  }

  /** Idempotent: the web app ignores a repeated event (same order, stage and level). */
  @SkailCommand({ retryCount: 3 })
  async ReportStatus(evt: OrderEvent): Promise<void> {
    await this.operations.reportStatus(evt);
  }
}
