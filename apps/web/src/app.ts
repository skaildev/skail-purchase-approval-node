import { randomUUID } from "node:crypto";
import fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import {
  Levels,
  OrderLimits,
  isTerminalPhase,
  type AppConfig,
  type Decision,
  type OrderEvent,
  type OrderState,
  type OrderView,
  type PurchaseOrder,
} from "@skail-purchase-approval/contracts";
import type { Deadlines } from "./config.js";
import type { OrderStore } from "./order-store.js";
import { SkailGatewayError, type SkailGateway } from "./gateway.js";

export interface AppOptions {
  store: OrderStore;
  gateway: SkailGateway;
  /** Deadline of each approval level, sent to the function as arguments (APPROVAL_*_DEADLINE_SECONDS). */
  deadlines?: Deadlines;
  /** Optional link to the skail Monitor (MONITOR_URL), shown by the page. */
  monitorUrl?: string | null;
  /** Directory with the built front end (index.html + assets). Optional: tests do not need it. */
  staticDir?: string;
}

export function toView(order: OrderState): OrderView {
  return { ...order, active: !isTerminalPhase(order.phase) };
}

interface StartBody {
  supplier?: unknown;
  description?: unknown;
  amount?: unknown;
}

interface DecisionBody {
  level?: unknown;
  approved?: unknown;
  by?: unknown;
  reason?: unknown;
}

const text = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

export function createApp({
  store,
  gateway,
  deadlines = {
    managerSeconds: OrderLimits.defaultDeadlineSeconds,
    directorSeconds: OrderLimits.defaultDeadlineSeconds,
  },
  monitorUrl = null,
  staticDir,
}: AppOptions): FastifyInstance {
  const app = fastify();

  app.get("/healthz", async () => "ok");

  app.get("/api/config", async (): Promise<AppConfig> => ({
    defaultSupplier: OrderLimits.defaultSupplier,
    defaultDescription: OrderLimits.defaultDescription,
    defaultAmount: OrderLimits.defaultAmount,
    managerDeadlineSeconds: deadlines.managerSeconds,
    directorDeadlineSeconds: deadlines.directorSeconds,
    monitorUrl: monitorUrl || null,
  }));

  app.post<{ Body: StartBody | null }>("/api/orders", async (request, reply) => {
    const body = request.body ?? {};
    const supplier = text(body.supplier) ?? OrderLimits.defaultSupplier;
    const description = text(body.description) ?? OrderLimits.defaultDescription;
    const amount = body.amount === null || body.amount === undefined ? OrderLimits.defaultAmount : body.amount;
    if (supplier.length > OrderLimits.maxTextLength || description.length > OrderLimits.maxTextLength) {
      return reply
        .code(400)
        .send({ error: `Supplier and description can have at most ${OrderLimits.maxTextLength} characters` });
    }
    if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) {
      return reply.code(400).send({ error: "The amount must be greater than zero" });
    }

    const purchase: PurchaseOrder = { id: randomUUID(), supplier, description, amount };
    const order = store.create(purchase, deadlines.managerSeconds, deadlines.directorSeconds);
    try {
      await gateway.trigger(purchase, deadlines.managerSeconds, deadlines.directorSeconds);
    } catch (error) {
      store.remove(purchase.id);
      return reply.code(502).send({ error: messageOf(error) });
    }
    return toView(store.get(purchase.id) ?? order);
  });

  app.get<{ Params: { id: string } }>("/api/orders/:id", async (request, reply) => {
    const order = store.get(request.params.id);
    return order ? toView(order) : reply.code(404).send();
  });

  // A decision: registered here (only the level that is waiting, first one wins) and fired to the function's waitForEvent.
  app.post<{ Params: { id: string }; Body: DecisionBody | null }>(
    "/api/orders/:id/decision",
    async (request, reply) => {
      const { id } = request.params;
      const body = request.body ?? {};
      if (!Levels.isValid(body.level)) {
        return reply.code(400).send({ error: `Unknown level. Use '${Levels.manager}' or '${Levels.director}'` });
      }

      const level = body.level;
      const approved = body.approved !== false;
      const decision: Decision = {
        level,
        approved,
        by: text(body.by) ?? `${Levels.label(level)} team`,
        reason: approved ? null : text(body.reason),
        at: new Date().toISOString(),
      };

      switch (store.tryDecide(id, decision)) {
        case "NotFound":
          return reply.code(404).send();
        case "Duplicate":
          return reply.code(409).send({ error: "This order already has a decision" });
        case "WrongLevel":
          return reply.code(409).send({ error: `The ${Levels.label(level)} is not the one waiting for this order` });
        case "Finished":
          return reply.code(409).send({ error: "The order is already finished" });
      }

      try {
        await gateway.fireDecision(id, decision);
      } catch (error) {
        store.release(id, level); // not delivered: the level can try again
        return reply.code(502).send({ error: messageOf(error) });
      }
      return toView(store.get(id)!);
    },
  );

  // called by the worker's commands (ReportStatus, RequestApproval, ConfirmPurchase, RejectPurchase, CancelForNoResponse)
  app.post<{ Params: { id: string }; Body: OrderEvent }>("/internal/orders/:id/events", async (request, reply) => {
    store.apply({ ...request.body, orderId: request.params.id });
    return reply.code(204).send();
  });

  app.get<{ Params: { id: string } }>("/api/orders/:id/stream", (request, reply) => {
    const { id } = request.params;
    const current = store.get(id);
    if (!current) return reply.code(404).send();

    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    const send = (state: OrderState) => raw.write(`data: ${JSON.stringify(toView(state))}\n\n`);

    // subscribe before sending the snapshot: no update is lost
    const unsubscribe = store.subscribe(id, send, () => raw.end());
    raw.on("close", unsubscribe);
    send(current);
    if (isTerminalPhase(current.phase)) {
      unsubscribe();
      raw.end();
    }
  });

  if (staticDir) app.register(fastifyStatic, { root: staticDir });

  return app;
}

function messageOf(error: unknown): string {
  return error instanceof SkailGatewayError || error instanceof Error ? error.message : String(error);
}
