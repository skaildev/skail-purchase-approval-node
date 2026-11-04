import type { Provider } from "@skail/runtime";
import { PurchaseFunctions } from "./purchase-functions.js";
import { buildConfig } from "./build-config.generated.js";
import { PurchaseOperations } from "./purchase-operations.js";
import { FakeProgressNotifier, HttpProgressNotifier } from "./web.js";

// The skail bundle cannot read environment variables: these settings are fixed at build time (gen-config.mjs).
export const providers: Provider[] = [
  {
    token: PurchaseFunctions,
    useFactory: () =>
      new PurchaseFunctions(
        new PurchaseOperations(
          buildConfig.notifyProvider === "fake"
            ? new FakeProgressNotifier()
            : new HttpProgressNotifier(buildConfig.webBaseUrl),
        ),
      ),
  },
];
