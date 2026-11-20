import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
export const PORT = 8099;
/** Short deadlines keep the escalation and the cancellation scenarios fast; the code is the same for 48 hours. */
export const DEADLINE_SECONDS = 10;

/** Variables of the repository .env (real environment variables win). The values are never printed. */
export function loadEnv(): Record<string, string> {
  const file = resolve(ROOT, ".env");
  if (!existsSync(file))
    throw new Error(".env not found: the e2e test runs against a real skail environment (cp .env.example .env)");
  const env: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trimStart().startsWith("#")) env[m[1]!] = m[2]!.replace(/^(['"])(.*)\1$/, "$2");
  }
  return { ...env, ...(process.env as Record<string, string>) };
}

const runtimeEnv = () => ({
  ...loadEnv(),
  WEB_BASE_URL: `http://localhost:${PORT}`, // fixed in the worker bundle at build time
  NOTIFY_PROVIDER: "http",
  APPROVAL_MANAGER_DEADLINE_SECONDS: String(DEADLINE_SECONDS),
  APPROVAL_DIRECTOR_DEADLINE_SECONDS: String(DEADLINE_SECONDS),
  PORT: String(PORT),
  HOST: "127.0.0.1",
});

export function build(): void {
  execFileSync("pnpm", ["-r", "build"], { cwd: ROOT, env: runtimeEnv(), stdio: "inherit" });
}

export interface Managed {
  child: ChildProcess;
  output: () => string;
  stop: () => Promise<void>;
}

function start(cwd: string, args: string[], ready: RegExp): Promise<Managed> {
  const child = spawn("node", args, { cwd: resolve(ROOT, cwd), env: runtimeEnv(), stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  const collect = (chunk: Buffer) => (out += chunk.toString());
  child.stdout!.on("data", collect);
  child.stderr!.on("data", collect);
  const exited = new Promise<void>((r) => child.once("exit", () => r()));
  const managed: Managed = {
    child,
    output: () => out,
    stop: async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited;
    },
  };
  return new Promise((resolveStart, reject) => {
    const timer = setTimeout(() => reject(new Error(`${cwd} did not become ready:\n${out}`)), 60_000);
    const check = setInterval(() => {
      if (ready.test(out)) {
        clearTimeout(timer);
        clearInterval(check);
        resolveStart(managed);
      }
    }, 100);
    child.once("exit", (code) => {
      clearTimeout(timer);
      clearInterval(check);
      reject(new Error(`${cwd} exited with ${code}:\n${out}`));
    });
  });
}

export const startWeb = () => start("apps/web", ["--enable-source-maps", "dist/main.js"], /listening on/);
export const startWorker = () => start("apps/worker", ["--enable-source-maps", "dist/main.js"], /worker started/);
