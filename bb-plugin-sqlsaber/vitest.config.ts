import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    fileParallelism: false,
    sequence: { concurrent: false },
    setupFiles: ["./test/setup.ts"],
    server: { deps: { external: ["@get-bb/plugin-sdk"] } },
    testTimeout: 15_000,
  },
});
