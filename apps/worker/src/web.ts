import type { OrderEvent } from "@skail-purchase-approval/contracts";

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface ProgressNotifier {
  notify(event: OrderEvent): Promise<void>;
}

/** Reports progress to the web app: POST {web}/internal/orders/{id}/events. */
export class HttpProgressNotifier implements ProgressNotifier {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: Fetch = (url, init) => fetch(url, init),
  ) {}

  async notify(event: OrderEvent): Promise<void> {
    const base = this.baseUrl.endsWith("/") ? this.baseUrl : `${this.baseUrl}/`;
    const response = await this.fetchImpl(`${base}internal/orders/${encodeURIComponent(event.orderId)}/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Web app answered ${response.status} to the progress event`);
  }
}

/** Offline notifier (NOTIFY_PROVIDER=fake): drops the events. */
export class FakeProgressNotifier implements ProgressNotifier {
  async notify(): Promise<void> {}
}
