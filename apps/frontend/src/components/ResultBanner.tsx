import type { OrderView } from "@skail-purchase-approval/contracts";
import { LEVEL_LABELS } from "../labels";

/** Always rendered, and hidden while there is no result. */
export function ResultBanner({ order }: { order: OrderView | undefined }) {
  const r = order?.result;
  let message = "";
  if (r?.end === "Approved")
    message = `Approved by the ${LEVEL_LABELS[r.decision?.level ?? ""]} · reference ${r.reference}`;
  else if (r?.end === "Rejected")
    message = `Rejected by the ${LEVEL_LABELS[r.decision?.level ?? ""]}${r.reason ? ` (${r.reason})` : ""}`;
  else if (r) message = "Cancelled · no response from the Manager or the Director";

  return (
    <section
      id="result"
      className={`result ${r?.end === "Approved" ? "ok" : "bad"}`}
      hidden={!r}
      role="status"
      aria-label="Result"
    >
      {message}
    </section>
  );
}
