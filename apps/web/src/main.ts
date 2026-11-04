import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";
import { deadlinesFromEnvironment } from "./config.js";
import { SkailApiGateway, skailOptionsFromEnvironment } from "./gateway.js";
import { OrderStore } from "./order-store.js";

const staticDir = process.env.STATIC_DIR ?? fileURLToPath(new URL("../../frontend/dist", import.meta.url));
const deadlines = deadlinesFromEnvironment();
const app = createApp({
  store: new OrderStore(),
  gateway: new SkailApiGateway(skailOptionsFromEnvironment()),
  deadlines,
  monitorUrl: process.env.MONITOR_URL,
  staticDir,
});

const port = Number(process.env.PORT ?? 8080);
const host = process.env.HOST ?? "0.0.0.0";

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => void app.close().then(() => process.exit(0)));
}

await app.listen({ port, host });
console.log(
  `Purchase approval web listening on http://${host}:${port} (deadlines: manager ${deadlines.managerSeconds}s, director ${deadlines.directorSeconds}s; static: ${staticDir})`,
);
