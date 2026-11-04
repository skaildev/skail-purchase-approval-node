import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildSkail } from "@skail/build";

describe("skail build", () => {
  it("accepts the worker (no forbidden imports) and lists the function and commands as <workload>/<method>", async () => {
    const dir = await mkdtemp(join(tmpdir(), "purchase-approval-bundle-"));
    try {
      const manifest = await buildSkail({
        entryPoint: "src/skail-functions.ts",
        workload: "purchase-approval:v0.0.1",
        outfile: join(dir, "skail-functions.mjs"),
        manifestFile: join(dir, "manifest.json"),
      });

      expect(manifest.methods.map((m) => [m.kind, m.uri]).sort()).toEqual([
        ["command", "purchase-approval:v0.0.1/CancelForNoResponse"],
        ["command", "purchase-approval:v0.0.1/ConfirmPurchase"],
        ["command", "purchase-approval:v0.0.1/RejectPurchase"],
        ["command", "purchase-approval:v0.0.1/ReportStatus"],
        ["command", "purchase-approval:v0.0.1/RequestApproval"],
        ["function", "purchase-approval:v0.0.1/ApprovePurchase"],
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
