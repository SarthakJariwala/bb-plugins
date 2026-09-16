import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  CONFIGURED_MODEL,
  PROVIDER_ID,
  REASONING_LEVELS,
  SQLSABER_EXECUTABLE_ENV,
  sqlsaberExtensionKinds,
} from "./src/vocabulary.js";

export default function plugin(bb: BbPluginApi): void {
  bb.providers.register({
    id: PROVIDER_ID,
    displayName: "SQLSaber",
    icon: "Database",
    experimental_visibility: "installed",
    maintenance: { health: true },
    capabilities: {
      supportsServiceTier: false,
      supportsNativeUserQuestion: false,
      fork: "none",
      supportsManualCompaction: false,
      supportsThreadArchive: false,
      supportsThreadRename: false,
      permissionModes: ["full"],
      reasoningLevels: REASONING_LEVELS,
    },
    reasoningLevels: [
      { id: "none", label: "Off" },
      { id: "low", label: "Low" },
      { id: "medium", label: "Medium" },
      { id: "high", label: "High" },
      { id: "max", label: "Maximum" },
    ],
    composerActions: [],
    models: { fallback: [CONFIGURED_MODEL], scope: "host" },
    env: { passthrough: [SQLSABER_EXECUTABLE_ENV] },
    strings: {
      signInHint:
        "Configure a model and database with `sqlsaber models set` and `sqlsaber db add` on this machine.",
      expiredHint:
        "SQLSaber could not use the configured model credentials. Update them on this machine and retry.",
      installUrl: "https://github.com/SarthakJariwala/sqlsaber",
    },
    extensionKinds: sqlsaberExtensionKinds,
  });
}
