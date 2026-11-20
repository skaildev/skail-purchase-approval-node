import { Skail, SkailCommand, SkailFunction } from "@skail/runtime";
import { Events, Levels, isDecision, label, type Decision, type PurchaseOrder } from "./model.js";

// Method names are PascalCase on purpose: the skail address is <workload>/<method>, and the trigger calls
// <workload>/ApprovePurchase.
export class PurchaseFunctions {
  /**
   * Asks the manager to approve the order and waits for the decision until a deadline. With no answer it escalates to
   * the director and waits again; with no answer again, it cancels the order. The deadlines are arguments, so the same
   * code serves the demo (1 minute) and a real approval (48 hours).
   * The name and the parameters are the trigger contract: [{purchase}, {managerDeadlineSeconds}, {directorDeadlineSeconds}].
   */
  @SkailFunction()
  async ApprovePurchase(
    purchase: PurchaseOrder,
    managerDeadlineSeconds: number,
    directorDeadlineSeconds: number,
  ): Promise<string> {
    await this.RequestApproval(purchase, Levels.manager);

    // the wait is created once, without await, and reused in both whenAny
    const decision = Skail.waitForEvent<Decision>(Events.purchaseDecision, purchase.id);

    // whenAny returns the value of the winner: the decision, or undefined for the deadline
    let answer = await Skail.whenAny([decision, Skail.delaySeconds(managerDeadlineSeconds)]);
    if (!isDecision(answer)) {
      await this.RequestApproval(purchase, Levels.director); // escalation
      answer = await Skail.whenAny([decision, Skail.delaySeconds(directorDeadlineSeconds)]);
    }

    if (!isDecision(answer)) return this.CancelForNoResponse(purchase);

    return answer.approved ? this.ConfirmPurchase(purchase, answer) : this.RejectPurchase(purchase, answer);
  }

  // The commands are the I/O: here they only report what would happen in the purchasing system, to the console and to
  // the page.
  // A completed command never runs again, so a replay does not ask the approvers again nor print the same line twice.

  @SkailCommand({ retryCount: 3 })
  async RequestApproval(purchase: PurchaseOrder, level: string): Promise<void> {
    await report(
      purchase.id,
      `${label(level)}: approval requested for ${purchase.description}, ${purchase.supplier}, ${money(purchase.amount)}`,
      `requested:${level}`,
    );
  }

  @SkailCommand({ retryCount: 3 })
  async ConfirmPurchase(purchase: PurchaseOrder, decision: Decision): Promise<string> {
    const reference = `PO-${purchase.id.slice(0, 8).toUpperCase()}`;
    await report(
      purchase.id,
      `approved by ${decision.by}: order ${reference} sent to ${purchase.supplier}`,
      "end:approved",
    );
    return `approved ${reference}`;
  }

  @SkailCommand({ retryCount: 3 })
  async RejectPurchase(purchase: PurchaseOrder, decision: Decision): Promise<string> {
    await report(purchase.id, `rejected by ${decision.by} (${decision.reason})`, "end:rejected");
    return "rejected";
  }

  /** Nobody answered before the second deadline, which is different from a rejection. */
  @SkailCommand({ retryCount: 3 })
  async CancelForNoResponse(purchase: PurchaseOrder): Promise<string> {
    await report(purchase.id, "cancelled: nobody answered before the deadlines", "end:cancelled");
    return "cancelled";
  }
}

/**
 * Reports a step to the app, which prints it and shows it on the page. Commands run in an isolated VM, so they reach the
 * app over HTTP on a local port, whose address is in DEMO_INTERNAL_URL.
 */
async function report(orderId: string, text: string, step: string): Promise<void> {
  const response = await fetch(`${process.env.DEMO_INTERNAL_URL}/internal/timeline`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ runId: orderId, text, step }),
  });
  if (!response.ok) throw new Error(`the app answered ${response.status} to the timeline`);
}

function money(value: number): string {
  return `R$ ${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
