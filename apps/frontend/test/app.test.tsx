import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OrderResult } from "@skail-purchase-approval/contracts";
import { App } from "../src/App";
import { CONFIG, FakeEventSource, ID, decision, escalated, json, level, view } from "./helpers";

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;
let routes: Record<string, Handler>;
const calls: Array<{ url: string; init?: RequestInit }> = [];

beforeEach(() => {
  FakeEventSource.instances = [];
  calls.length = 0;
  routes = { "GET /api/config": () => json(CONFIG) };
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      const handler = routes[`${init?.method ?? "GET"} ${url}`];
      return handler ? handler(url, init) : json({}, 404);
    }),
  );
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-01-01T10:00:30.000Z"));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const card = (name: "Manager" | "Director") => screen.getByRole("article", { name });
const body = (i = -1) => JSON.parse(calls.at(i)!.init!.body as string);

describe("idle page", () => {
  it("shows the defaults from /api/config, the deadlines, two cards not requested and locked controls", async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByLabelText("Supplier")).toHaveValue("Papelaria Central"));
    expect(screen.getByLabelText("Description")).toHaveValue("A4 paper reams (50 boxes)");
    expect(screen.getByLabelText("Amount")).toHaveValue(18500);
    expect(screen.getByText("Idle")).toBeInTheDocument();
    expect(screen.getByText("Deadlines: Manager 60s · Director 90s")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Request approval" })).toBeEnabled();
    for (const name of ["Manager", "Director"] as const) {
      expect(within(card(name)).getByText("Not requested")).toBeInTheDocument();
      expect(within(card(name)).getByRole("button", { name: "Approve" })).toBeDisabled();
      expect(within(card(name)).getByRole("button", { name: "Reject" })).toBeDisabled();
    }
    expect(screen.getByText("-")).toBeInTheDocument();
  });

  it("shows the Monitor link only when configured", async () => {
    routes["GET /api/config"] = () => json({ ...CONFIG, monitorUrl: "http://monitor" });
    render(<App />);
    const link = await screen.findByRole("link", { name: "Open the skail Monitor" });
    expect(link).toHaveAttribute("href", "http://monitor");
  });
});

describe("requesting an approval", () => {
  it("posts the fields, locks the form and follows the SSE stream", async () => {
    routes["POST /api/orders"] = () => json(view({ phase: "Starting", manager: level("manager") }));
    render(<App />);
    await screen.findByText("Deadlines: Manager 60s · Director 90s");
    const user = userEvent.setup();
    await user.clear(screen.getByLabelText("Supplier"));
    await user.type(screen.getByLabelText("Supplier"), "ACME");
    await user.click(screen.getByRole("button", { name: "Request approval" }));

    await waitFor(() => expect(screen.getByText("Starting…")).toBeInTheDocument());
    expect(body(-1)).toEqual({ supplier: "ACME", description: "A4 paper reams (50 boxes)", amount: 18500 });
    expect(screen.getByLabelText("Supplier")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Request approval" })).toBeDisabled();
    expect(localStorage.getItem("purchase-approval.orderId")).toBe(ID);
    expect(FakeEventSource.instances.at(-1)!.url).toBe(`/api/orders/${ID}/stream`);

    FakeEventSource.instances.at(-1)!.emit(view());
    await screen.findByText("Waiting for Manager");
    expect(screen.getByText(ID)).toBeInTheDocument();
  });

  it("shows an error and keeps the form usable when the trigger fails", async () => {
    routes["POST /api/orders"] = () => json({ error: "skail down" }, 502);
    render(<App />);
    await screen.findByText("Deadlines: Manager 60s · Director 90s");
    await userEvent.setup().click(screen.getByRole("button", { name: "Request approval" }));
    expect(await screen.findByText("Could not start: skail down")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Request approval" })).toBeEnabled();
  });
});

describe("cards", () => {
  async function restored(order = view()) {
    localStorage.setItem("purchase-approval.orderId", ID);
    routes[`GET /api/orders/${ID}`] = () => json(order);
    render(<App />);
    await waitFor(() => expect(screen.getByText(ID)).toBeInTheDocument());
  }

  it("only the pending manager can decide, with a countdown from the request time", async () => {
    await restored();
    expect(within(card("Manager")).getByText("Pending")).toBeInTheDocument();
    expect(within(card("Manager")).getByText("Deadline in 30s")).toBeInTheDocument();
    expect(within(card("Manager")).getByRole("button", { name: "Approve" })).toBeEnabled();
    expect(within(card("Manager")).getByRole("button", { name: "Reject" })).toBeEnabled();
    expect(within(card("Director")).getByRole("button", { name: "Approve" })).toBeDisabled();
    expect(screen.getByLabelText("Supplier")).toBeDisabled();
  });

  it("after the escalation the controls pass to the director and the manager shows No response", async () => {
    await restored(escalated());
    expect(screen.getByText("Waiting for Director")).toBeInTheDocument();
    expect(within(card("Manager")).getByText("No response")).toBeInTheDocument();
    expect(within(card("Manager")).getByRole("button", { name: "Approve" })).toBeDisabled();
    expect(within(card("Director")).getByRole("button", { name: "Approve" })).toBeEnabled();
  });

  it("Approve and Reject post the level, the approver and the reason", async () => {
    routes[`POST /api/orders/${ID}/decision`] = () => json(view());
    await restored();
    const user = userEvent.setup();
    const manager = within(card("Manager"));
    await user.type(manager.getByPlaceholderText("Decided by"), "Maria");
    await user.click(manager.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(body()).toEqual({ level: "manager", approved: true, by: "Maria", reason: "" }));

    await user.type(manager.getByPlaceholderText("Reason (if rejecting)"), "too expensive");
    await user.click(manager.getByRole("button", { name: "Reject" }));
    await waitFor(() =>
      expect(body()).toEqual({ level: "manager", approved: false, by: "Maria", reason: "too expensive" }),
    );
  });

  it("a failed decision shows the error and the buttons come back for another try", async () => {
    routes[`POST /api/orders/${ID}/decision`] = () => json({ error: "skail down" }, 502);
    await restored();
    await userEvent.setup().click(within(card("Manager")).getByRole("button", { name: "Approve" }));
    expect(await screen.findByText("Could not send the decision: skail down")).toBeInTheDocument();
    expect(within(card("Manager")).getByRole("button", { name: "Approve" })).toBeEnabled();
  });

  it("shows who decided, when and why", async () => {
    await restored(
      view({
        manager: level("manager", {
          status: "Rejected",
          requestedAt: "2026-01-01T10:00:00.000Z",
          by: "Maria",
          reason: "too expensive",
          at: "2026-01-01T10:00:20.000Z",
        }),
      }),
    );
    expect(within(card("Manager")).getByText("Rejected")).toBeInTheDocument();
    expect(within(card("Manager")).getByText(/Maria · .* · “too expensive”/)).toBeInTheDocument();
  });
});

describe("result and end of the order", () => {
  const terminal = (
    phase: "Approved" | "Rejected" | "Cancelled" | "Failed",
    result: ReturnType<typeof view>["result"],
    error: string | null = null,
  ) =>
    view({
      phase,
      result,
      error,
      manager: level("manager", { status: "Approved", by: "Maria", at: "2026-01-01T10:00:20.000Z" }),
    });

  async function restored(order: ReturnType<typeof view>) {
    localStorage.setItem("purchase-approval.orderId", ID);
    routes[`GET /api/orders/${ID}`] = () => json(order);
    render(<App />);
    await waitFor(() => expect(screen.getByText(ID)).toBeInTheDocument());
  }

  it("approved: the reference and the level that approved; the form unlocks", async () => {
    await restored(terminal("Approved", OrderResult.approved(ID, decision("manager"))));
    expect(screen.getByRole("status", { name: "Result" })).toHaveTextContent(
      "Approved by the Manager · reference PO-3F2A9C1E",
    );
    expect(screen.getByRole("status", { name: "Result" })).toHaveClass("ok");
    expect(screen.getByLabelText("Supplier")).toBeEnabled();
    expect(localStorage.getItem("purchase-approval.orderId")).toBeNull();
  });

  it("rejected: level and reason", async () => {
    await restored(terminal("Rejected", OrderResult.rejected(ID, decision("director", false, "too expensive"))));
    expect(screen.getByRole("status", { name: "Result" })).toHaveTextContent(
      "Rejected by the Director (too expensive)",
    );
    expect(screen.getByRole("status", { name: "Result" })).toHaveClass("bad");
  });

  it("cancelled: no response from the manager or the director", async () => {
    await restored(terminal("Cancelled", OrderResult.noResponse(ID)));
    expect(screen.getByRole("status", { name: "Result" })).toHaveTextContent(
      "Cancelled · no response from the Manager or the Director",
    );
  });

  it("failed: the error from the worker", async () => {
    await restored(terminal("Failed", null, "web down"));
    expect(screen.getByText("web down")).toBeInTheDocument();
    expect(screen.getByLabelText("Supplier")).toBeEnabled();
  });

  it("closes the stream at a terminal state and forgets the order", async () => {
    localStorage.setItem("purchase-approval.orderId", ID);
    routes[`GET /api/orders/${ID}`] = () => json(view());
    render(<App />);
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    FakeEventSource.instances[0]!.emit(terminal("Approved", OrderResult.approved(ID, decision("manager"))));
    await screen.findByText("Approved by the Manager · reference PO-3F2A9C1E");
    expect(FakeEventSource.instances[0]!.closed).toBe(true);
    expect(localStorage.getItem("purchase-approval.orderId")).toBeNull();
  });

  it("forgets an order the server does not know", async () => {
    localStorage.setItem("purchase-approval.orderId", "gone");
    render(<App />);
    await waitFor(() => expect(localStorage.getItem("purchase-approval.orderId")).toBeNull());
    expect(screen.getByText("Idle")).toBeInTheDocument();
  });
});
