import { Levels, OrderEvent, OrderResult, type Decision, type PurchaseOrder } from "@skail-purchase-approval/contracts";
import type { ProgressNotifier } from "./web.js";

/**
 * The I/O behind the commands, as plain async methods. The command wrappers only delegate here, so the
 * logic is unit tested without the skail runtime. The web app plays the manager's and the director's inbox:
 * delivering a request is the event it receives, and if it cannot be delivered the method throws and skail retries.
 */
export class PurchaseOperations {
  constructor(private readonly notifier: ProgressNotifier) {}

  /** Idempotent: the web app records one request per order and level. Escalating to the director is the Escalated stage. */
  async requestApproval(purchase: PurchaseOrder, level: string): Promise<void> {
    if (!Levels.isValid(level)) throw new Error(`unknown level '${level}'`);
    await this.notifier.notify(
      level === Levels.manager
        ? OrderEvent.approvalRequested(purchase.id, level)
        : OrderEvent.escalated(purchase.id, level),
    );
  }

  /** Idempotent: the result derives from the arguments, and the web app ignores a repeated stage. */
  async confirm(purchase: PurchaseOrder, decision: Decision): Promise<OrderResult> {
    if (!decision.approved) throw new Error("only an approved decision confirms the purchase");
    const result = OrderResult.approved(purchase.id, decision);
    await this.notifier.notify(OrderEvent.approved(purchase.id, result));
    return result;
  }

  /** An explicit rejection: a business result, different from the cancellation for no response. Idempotent. */
  async reject(purchase: PurchaseOrder, decision: Decision): Promise<OrderResult> {
    if (decision.approved) throw new Error("only a rejected decision rejects the purchase");
    const result = OrderResult.rejected(purchase.id, decision);
    await this.notifier.notify(OrderEvent.rejected(purchase.id, result));
    return result;
  }

  /** Nobody answered either deadline. Idempotent. */
  async cancelForNoResponse(purchase: PurchaseOrder): Promise<OrderResult> {
    const result = OrderResult.noResponse(purchase.id);
    await this.notifier.notify(OrderEvent.cancelled(purchase.id, result));
    return result;
  }

  reportStatus(evt: OrderEvent): Promise<void> {
    return this.notifier.notify(evt);
  }
}
