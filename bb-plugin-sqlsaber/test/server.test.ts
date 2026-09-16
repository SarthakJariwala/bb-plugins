import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import plugin from "../server.js";
import {
  CONFIGURED_MODEL_ID,
  PROVIDER_ID,
  QUERY_RESULT_KIND,
  SQLSABER_EXECUTABLE_ENV,
} from "../src/vocabulary.js";

describe("SQLSaber provider registration", () => {
  it("declares only the bridge capabilities it implements", () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "sqlsaber",
      experimental_hostEntry: true,
    });

    plugin(bb);

    expect(harness.inspection.registrations.providerRegistrations).toHaveLength(1);
    const provider = harness.inspection.registrations.providerRegistrations[0];
    expect(provider).toMatchObject({
      id: PROVIDER_ID,
      displayName: "SQLSaber",
      experimental_visibility: "installed",
      maintenance: { health: true, usage: false, installation: false },
      capabilities: {
        supportsServiceTier: false,
        supportsNativeUserQuestion: false,
        fork: "none",
        supportsManualCompaction: false,
        supportsThreadArchive: false,
        supportsThreadRename: false,
        permissionModes: ["full"],
        reasoningLevels: ["none", "low", "medium", "high", "max"],
      },
      composerActions: [],
      models: {
        scope: "host",
        fallback: [{ id: CONFIGURED_MODEL_ID, isDefault: true }],
      },
      env: { passthrough: [SQLSABER_EXECUTABLE_ENV] },
    });
    expect(provider?.extensionKinds).toHaveProperty("query-result");
    expect(QUERY_RESULT_KIND).toBe("sqlsaber/query-result");
  });
});
