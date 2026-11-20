import { build } from "./processes";

// builds all packages with the e2e settings baked in (web URL and notifier of the worker bundle)
export default function globalSetup() {
  build();
}
