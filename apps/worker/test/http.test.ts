import { describe, expect, it } from "vitest";
import { HttpProgressNotifier } from "../src/web.js";

describe("HttpProgressNotifier", () => {
  it("posts the event to /internal/orders/{id}/events", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const notifier = new HttpProgressNotifier("http://web:8080", async (url, init) => {
      calls.push({ url, init });
      return new Response(null, { status: 204 });
    });
    await notifier.notify({ orderId: "a b", stage: "Started" });
    expect(calls[0]!.url).toBe("http://web:8080/internal/orders/a%20b/events");
    expect(calls[0]!.init?.method).toBe("POST");
    expect(JSON.parse(calls[0]!.init!.body as string)).toMatchObject({ stage: "Started" });
  });

  it("throws on a non-2xx answer so skail retries the command", async () => {
    const notifier = new HttpProgressNotifier("http://web:8080/", async () => new Response(null, { status: 500 }));
    await expect(notifier.notify({ orderId: "c", stage: "Started" })).rejects.toThrow(/500/);
  });
});
