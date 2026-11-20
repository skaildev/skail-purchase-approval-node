import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createSkailPlatform } from "@skail/runtime";
import { PurchaseDesk } from "./purchase-desk.js";
import { SkailApiClient, skailApiOptionsFromEnvironment } from "./skail-api.js";
import { Timeline } from "./timeline.js";

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// usage: npm start [-- <order id>]
//   then open http://localhost:8080; an order id follows an order that already exists (to see it resume)
const argument = process.argv.slice(2).find((a) => !a.startsWith("-"));
if (argument !== undefined && !GUID.test(argument)) {
  console.error(`Unknown argument '${argument}'. Pass an order id, or nothing.`);
  process.exit(1);
}

loadDotEnv();
const missing = ["SKAIL_WORKLOAD", "SKAIL_NAMESPACE", "SKAIL_KEY", "SKAIL_SIDECAR"].filter(
  (n) => !process.env[n]?.trim(),
);
if (missing.length > 0) {
  console.error(`Missing ${missing.join(", ")}. Copy .env.example to .env and fill it in.`);
  process.exit(1);
}

const timeline = new Timeline();
const desk = new PurchaseDesk(new SkailApiClient(skailApiOptionsFromEnvironment()), timeline);
if (argument) desk.follow(argument.toLowerCase());

const page = readFileSync(new URL("../page/index.html", import.meta.url));
const port = Number(process.env.DEMO_PORT ?? 8080);
// the page: localhost only, unless DEMO_HOST says otherwise (the container listens on all interfaces)
const host = process.env.DEMO_HOST ?? "127.0.0.1";

// the page, its API, and /internal/timeline, where the commands report each step
const server = createServer(async (request, response) => {
  const send = (status: number, body?: unknown) =>
    response
      .writeHead(status, { "content-type": "application/json" })
      .end(body === undefined ? "" : JSON.stringify(body));
  try {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (request.method === "GET" && url.pathname === "/")
      return void response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page);
    if (request.method === "GET" && url.pathname === "/api/state") return send(200, desk.view());
    if (request.method === "POST" && url.pathname === "/api/orders") return send(200, { id: await desk.place() });

    const decision = /^\/api\/decisions\/(\w+)\/(true|false)$/.exec(url.pathname);
    if (request.method === "POST" && decision)
      return send((await desk.decide(decision[1]!, decision[2] === "true")) ? 200 : 409);

    if (request.method === "POST" && url.pathname === "/internal/timeline") {
      let body = "";
      for await (const chunk of request) body += chunk;
      const entry = JSON.parse(body) as { runId: string; text: string; step: string | null };
      timeline.add(entry.runId, entry.text, entry.step);
      return send(200);
    }
    send(404);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    send(500);
  }
});
await new Promise<void>((resolve) => server.listen(port, host, resolve));

// the commands run in an isolated VM and report over HTTP; the address goes in the environment before the worker starts
process.env.DEMO_INTERNAL_URL = `http://127.0.0.1:${port}`;

// hosts the worker that executes PurchaseFunctions (the bundle from `npm run build`);
// reads SKAIL_WORKLOAD, SKAIL_NAMESPACE, SKAIL_KEY and SKAIL_SIDECAR from the environment
const platform = createSkailPlatform({
  bundle: new URL("../.skail/skail-functions.mjs", import.meta.url),
  manifest: new URL("../.skail/manifest.json", import.meta.url),
});

const shutdown = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    server.close();
    shutdown.abort();
  });
}
const worker = platform.run(shutdown.signal);
console.log(
  `Open http://localhost:${port} to place a purchase order and play the manager and the director. Ctrl+C exits.`,
);
await worker;

/** Loads .env from the current directory, when present. Variables already set in the environment win. */
function loadDotEnv(): void {
  try {
    process.loadEnvFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
