import type { OrderView } from "@skail-purchase-approval/contracts";
import { PHASE_LABELS } from "../labels";

export function StatusBadge({ order }: { order: OrderView | undefined }) {
  const kind = !order
    ? "idle"
    : order.phase === "Failed" || order.phase === "Cancelled" || order.phase === "Rejected"
      ? "failed"
      : order.phase === "Approved"
        ? "done"
        : "active";
  const label = order ? (PHASE_LABELS[order.phase] ?? order.phase) : "Idle";
  return (
    <span id="state" className={`badge ${kind}`}>
      {label}
    </span>
  );
}
