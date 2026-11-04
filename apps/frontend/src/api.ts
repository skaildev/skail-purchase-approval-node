import type { AppConfig, OrderView } from "@skail-purchase-approval/contracts";

async function failure(res: Response): Promise<Error> {
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  return new Error(body.error ?? `HTTP ${res.status}`);
}

export interface NewOrder {
  supplier: string;
  description: string;
  amount: number | null;
}

export async function startOrder(order: NewOrder): Promise<OrderView> {
  const res = await fetch("/api/orders", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(order),
  });
  if (!res.ok) throw await failure(res);
  return res.json();
}

export interface DecisionRequest {
  level: string;
  approved: boolean;
  by: string;
  reason: string;
}

export async function decide(orderId: string, decision: DecisionRequest): Promise<OrderView> {
  const res = await fetch(`/api/orders/${orderId}/decision`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(decision),
  });
  if (!res.ok) throw await failure(res);
  return res.json();
}

export async function getOrder(orderId: string): Promise<OrderView | null> {
  const res = await fetch(`/api/orders/${orderId}`);
  return res.ok ? res.json() : null;
}

export async function getConfig(): Promise<AppConfig> {
  const res = await fetch("/api/config");
  if (!res.ok) throw await failure(res);
  return res.json();
}
