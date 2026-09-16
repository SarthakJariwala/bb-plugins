import { createRequire } from "node:module";

Object.defineProperty(globalThis, "require", {
  value: createRequire(import.meta.url),
  configurable: true,
});
