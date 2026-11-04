import { useEffect } from "react";
import { isTerminalPhase, type OrderView } from "@skail-purchase-approval/contracts";

/**
 * Follows an order through SSE. EventSource reconnects by itself and the stream starts with the current
 * snapshot, so no update is lost. Closes at a terminal phase.
 */
export function useOrderStream(
  orderId: string | undefined,
  onState: (order: OrderView) => void,
  onTerminal: () => void,
) {
  useEffect(() => {
    if (!orderId) return;
    const source = new EventSource(`/api/orders/${orderId}/stream`);
    source.onmessage = (event) => {
      const order = JSON.parse(event.data) as OrderView;
      onState(order);
      if (isTerminalPhase(order.phase)) {
        source.close();
        onTerminal();
      }
    };
    return () => source.close();
    // callbacks are stable (state setters); the stream only depends on the order id
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderId]);
}
