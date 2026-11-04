import { useCallback, useEffect, useState } from "react";
import {
  OrderLimits,
  isTerminalPhase,
  startState,
  type AppConfig,
  type OrderView,
} from "@skail-purchase-approval/contracts";
import { decide, getConfig, getOrder, startOrder } from "./api";
import { AreaCard } from "./components/AreaCard";
import { OrderForm, type OrderFields } from "./components/OrderForm";
import { ResultBanner } from "./components/ResultBanner";
import { StatusBadge } from "./components/StatusBadge";
import { Timeline } from "./components/Timeline";
import { useNow } from "./hooks/useNow";
import { useOrderStream } from "./hooks/useOrderStream";
import { LEVELS } from "./labels";

const KEY = "purchase-approval.orderId";

const fieldsOf = (o: OrderView): OrderFields => ({
  supplier: o.purchase.supplier,
  description: o.purchase.description,
  amount: String(o.purchase.amount),
});

export function App() {
  const [order, setOrder] = useState<OrderView | undefined>();
  const [config, setConfig] = useState<AppConfig | undefined>();
  const [fields, setFields] = useState<OrderFields>({
    supplier: OrderLimits.defaultSupplier,
    description: OrderLimits.defaultDescription,
    amount: String(OrderLimits.defaultAmount),
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const now = useNow();

  const forget = useCallback(() => localStorage.removeItem(KEY), []);
  const live = order !== undefined && !isTerminalPhase(order.phase);
  useOrderStream(live ? order.orderId : undefined, setOrder, forget);

  useEffect(() => {
    getConfig().then(
      (c) => {
        setConfig(c);
        setFields((current) =>
          order
            ? current
            : { supplier: c.defaultSupplier, description: c.defaultDescription, amount: String(c.defaultAmount) },
        );
      },
      () => {},
    );
    // runs once: the defaults only fill the form when there is no order yet
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // reload keeps the cards, the countdown and the locked controls right: the state always comes from the server
  useEffect(() => {
    const saved = localStorage.getItem(KEY);
    if (!saved) return;
    getOrder(saved).then((restored) => {
      if (!restored) return forget();
      setOrder(restored);
      setFields(fieldsOf(restored));
      if (isTerminalPhase(restored.phase)) forget();
    }, forget);
  }, [forget]);

  const ui = startState(order);
  const placeholders: OrderFields = {
    supplier: config?.defaultSupplier ?? "",
    description: config?.defaultDescription ?? "",
    amount: config ? String(config.defaultAmount) : "",
  };

  async function onStart() {
    setBusy(true);
    setError(null);
    try {
      const started = await startOrder({
        supplier: fields.supplier,
        description: fields.description,
        amount: fields.amount === "" ? null : Number(fields.amount),
      });
      localStorage.setItem(KEY, started.orderId);
      setOrder(started);
      setFields(fieldsOf(started));
    } catch (e) {
      setError(`Could not start: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function onDecide(level: string, approved: boolean, by: string, reason: string) {
    if (!order) return;
    setBusy(true);
    setError(null);
    try {
      setOrder(await decide(order.orderId, { level, approved, by, reason }));
    } catch (e) {
      // the server released the level: the controls come back
      setError(`Could not send the decision: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  const shownError = error ?? order?.error ?? null;

  return (
    <main>
      <header>
        <h1>Purchase approval</h1>
        <p className="subtitle">
          A skail function asks the manager to approve a purchase order and waits for the answer until a deadline. With
          no answer it escalates to the director; with no answer again, it cancels the order. In this demo the deadlines
          are short (see below); the code is the same for 48 hours.
        </p>
      </header>

      <OrderForm
        fields={fields}
        placeholders={placeholders}
        ui={ui}
        busy={busy}
        onChange={setFields}
        onStart={onStart}
      />

      <section className="status">
        <StatusBadge order={order} />
        <span id="deadlines">
          {config
            ? `Deadlines: Manager ${config.managerDeadlineSeconds}s · Director ${config.directorDeadlineSeconds}s`
            : ""}
        </span>
        <a id="monitor" href={config?.monitorUrl ?? "#"} target="_blank" rel="noopener" hidden={!config?.monitorUrl}>
          Open the skail Monitor
        </a>
      </section>

      <p id="error" className="error" hidden={!shownError}>
        {shownError ?? ""}
      </p>

      <ResultBanner order={order} />

      <section className="areas">
        {LEVELS.map((level) => (
          <AreaCard
            key={level}
            level={level}
            view={order?.[level]}
            active={live}
            busy={busy}
            now={now}
            onDecide={(a, by, r) => onDecide(level, a, by, r)}
          />
        ))}
      </section>

      <section>
        <h2>Timeline</h2>
        <Timeline entries={order?.timeline ?? []} />
      </section>

      <footer>
        Order <code id="orderId">{order?.orderId ?? "-"}</code>
      </footer>
    </main>
  );
}
