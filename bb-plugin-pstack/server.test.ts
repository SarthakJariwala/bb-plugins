import type { BbPluginApi, PluginAgentToolResult } from "@get-bb/plugin-sdk";
import {
  createFakePluginHost,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "./server";

function resultText(result: PluginAgentToolResult): string {
  if (typeof result === "string") return result;
  return result.content
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("");
}

function childThread(status: "active" | "error" | "idle" = "idle") {
  return makeThreadResponse({
    id: "thr_child",
    projectId: "proj_test",
    parentThreadId: "thr_parent",
    status,
    visibility: "visible",
  });
}

type ProviderInfo = Awaited<
  ReturnType<BbPluginApi["sdk"]["providers"]["list"]>
>[number];
type ProviderModelsArgs = Parameters<
  BbPluginApi["sdk"]["providers"]["models"]
>[0];
type ProviderModelsResult = Awaited<
  ReturnType<BbPluginApi["sdk"]["providers"]["models"]>
>;

function providerInfo(id: string, displayName: string): ProviderInfo {
  return {
    id,
    displayName,
    pluginId: id,
    available: true,
    logoUrl: null,
    maintenance: { health: true, installation: true, usage: true },
    capabilities: {
      modelCatalogScope: "workspace",
      permissionModes: ["full"],
      supportsFork: false,
      supportsNativeUserQuestion: false,
      supportsServiceTier: true,
      supportsSessionRewind: false,
      supportsThreadArchive: false,
      supportsThreadRename: false,
    },
    composerActions: [],
    serviceTiers: [
      { id: "default", label: "Default" },
      { id: "fast", label: "Fast" },
    ],
  };
}

function providerModels(
  provider: ProviderInfo,
  modelId: string,
): ProviderModelsResult {
  return {
    modelLoadError: null,
    models: [
      {
        id: modelId,
        model: modelId,
        displayName: modelId,
        description: "",
        isDefault: true,
        defaultReasoningEffort: "high",
        supportedReasoningEfforts: [
          { reasoningEffort: "high", description: "High" },
        ],
      },
    ],
    permissionCeiling: "full",
    providers: [provider],
    selectedOnlyModels: [],
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("pstack plugin", () => {
  it("persists setup changes through the agent tool and CLI", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "pstack" });
    await plugin(bb);

    await harness.behavior.callAgentTool("pstack_update_model_config", {
      updates: [
        {
          role: "bug-fix",
          selections: [{ model: "pi/custom", reasoningLevel: "high" }],
        },
      ],
    });

    const result = await harness.behavior.runCli(["config", "--json"]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout ?? "{}")["bug-fix"]).toEqual([
      { providerId: "pi", model: "pi/custom", reasoningLevel: "high" },
    ]);

    await harness.lifecycle.dispose();
  });

  it("returns every available provider catalog for setup", async () => {
    const claude = providerInfo("claude", "Claude");
    const codex = providerInfo("codex", "Codex");
    const list = vi.fn(async () => [claude, codex]);
    const models = vi.fn(async (args: ProviderModelsArgs) =>
      args?.providerId === "claude"
        ? providerModels(claude, "claude-opus-4-6")
        : providerModels(codex, "gpt-5.4"),
    );
    const { bb, harness } = createFakePluginHost({
      pluginId: "pstack",
      sdk: {
        threads: {
          get: async () =>
            makeThreadResponse({
              id: "thr_parent",
              environmentId: "env_test",
            }),
        },
        providers: { list, models },
      },
    });
    await plugin(bb);

    const result = await harness.behavior.callAgentTool(
      "pstack_get_model_config",
      {},
      { threadId: "thr_parent" },
    );
    const parsed = JSON.parse(resultText(result));

    expect(parsed.providers).toEqual([
      expect.objectContaining({
        id: "claude",
        models: [expect.objectContaining({ id: "claude-opus-4-6" })],
        serviceTiers: ["default", "fast"],
      }),
      expect.objectContaining({
        id: "codex",
        models: [expect.objectContaining({ id: "gpt-5.4" })],
      }),
    ]);
    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({ environmentId: "env_test" }),
    );
    expect(models).toHaveBeenCalledTimes(2);

    await harness.lifecycle.dispose();
  });

  it("returns immediately after spawning a visible active default child", async () => {
    const spawn = vi.fn(async () =>
      makeThreadResponse({
        id: "thr_child",
        projectId: "proj_test",
        parentThreadId: "thr_parent",
        providerId: "pi",
        status: "active",
        visibility: "visible",
      }),
    );
    const { bb, harness } = createFakePluginHost({
      pluginId: "pstack",
      sdk: {
        threads: {
          get: async () =>
            makeThreadResponse({
              id: "thr_parent",
              projectId: "proj_test",
              environmentId: "env_test",
              canSpawnChild: true,
            }),
          spawn,
        },
      },
    });
    await plugin(bb);

    const output = await harness.behavior.callAgentTool(
      "pstack_spawn_threads",
      {
        workers: [
          {
            prompt: "Inspect the parser and report the control flow.",
            role: "how-explorer",
            preset: "general",
            readOnly: true,
            workspace: "reuse",
          },
        ],
      },
      { threadId: "thr_parent", projectId: "proj_test" },
    );

    expect(JSON.parse(resultText(output))).toEqual([
      expect.objectContaining({
        ok: true,
        threadId: "thr_child",
        model: "openai-codex/gpt-5.6-sol",
        reasoningLevel: "xhigh",
      }),
    ]);
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "proj_test",
        parentThreadId: "thr_parent",
        providerId: "pi",
        model: "openai-codex/gpt-5.6-sol",
        reasoningLevel: "xhigh",
        visibility: "visible",
        environment: { type: "reuse", environmentId: "env_test" },
      }),
    );

    await harness.lifecycle.dispose();
  });

  it("spawns a child with the configured provider, model, reasoning, and service tier", async () => {
    const spawn = vi.fn(async () =>
      makeThreadResponse({
        id: "thr_claude_child",
        projectId: "proj_test",
        parentThreadId: "thr_parent",
        providerId: "claude",
        status: "active",
        visibility: "visible",
      }),
    );
    const { bb, harness } = createFakePluginHost({
      pluginId: "pstack",
      sdk: {
        threads: {
          get: async () =>
            makeThreadResponse({
              id: "thr_parent",
              projectId: "proj_test",
              environmentId: "env_test",
              canSpawnChild: true,
            }),
          spawn,
        },
      },
    });
    await plugin(bb);

    await harness.behavior.callAgentTool("pstack_update_model_config", {
      updates: [
        {
          role: "bug-fix",
          selections: [
            {
              providerId: "claude",
              model: "claude-opus-4-6",
              reasoningLevel: "high",
              serviceTier: "fast",
            },
          ],
        },
      ],
    });
    const result = await harness.behavior.callAgentTool(
      "pstack_spawn_threads",
      {
        workers: [
          {
            prompt: "Fix the parser.",
            role: "bug-fix",
            workspace: "reuse",
          },
        ],
      },
      { threadId: "thr_parent", projectId: "proj_test" },
    );

    expect(JSON.parse(resultText(result))).toEqual([
      expect.objectContaining({
        ok: true,
        providerId: "claude",
        model: "claude-opus-4-6",
        reasoningLevel: "high",
        serviceTier: "fast",
      }),
    ]);
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: "claude",
        model: "claude-opus-4-6",
        reasoningLevel: "high",
        serviceTier: "fast",
      }),
    );

    await harness.lifecycle.dispose();
  });

  it("rejects multiple shared-workspace writers before any spawn", async () => {
    const get = vi.fn(async () => childThread());
    const spawn = vi.fn(async () => childThread("active"));
    const { bb, harness } = createFakePluginHost({
      pluginId: "pstack",
      sdk: { threads: { get, spawn } },
    });
    await plugin(bb);

    await expect(
      harness.behavior.callAgentTool("pstack_spawn_threads", {
        workers: [
          {
            prompt: "Edit the parser.",
            role: "feature-refactoring",
            workspace: "reuse",
          },
          {
            prompt: "Edit the serializer.",
            role: "feature-refactoring",
            workspace: "project-default",
          },
        ],
      }),
    ).rejects.toThrow("PSTACK_SHARED_WRITER_BATCH");
    expect(get).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();

    await harness.lifecycle.dispose();
  });

  it("allows one shared writer alongside isolated writers", async () => {
    let childIndex = 0;
    const spawn = vi.fn(async () =>
      makeThreadResponse({
        id: `thr_child_${childIndex++}`,
        projectId: "proj_test",
        parentThreadId: "thr_parent",
        status: "active",
        visibility: "visible",
      }),
    );
    const { bb, harness } = createFakePluginHost({
      pluginId: "pstack",
      sdk: {
        threads: {
          get: async () =>
            makeThreadResponse({
              id: "thr_parent",
              projectId: "proj_test",
              environmentId: null,
              canSpawnChild: true,
            }),
          spawn,
        },
      },
    });
    await plugin(bb);

    const result = await harness.behavior.callAgentTool("pstack_spawn_threads", {
      workers: [
        {
          prompt: "Edit the parser.",
          role: "feature-refactoring",
          workspace: "reuse",
        },
        {
          prompt: "Edit the serializer.",
          role: "feature-refactoring",
          workspace: "new-worktree",
        },
      ],
    });

    expect(JSON.parse(resultText(result))).toHaveLength(2);
    expect(spawn).toHaveBeenCalledTimes(2);

    await harness.lifecycle.dispose();
  });

  it("publishes the coordinator rule in spawn and configured instructions", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "pstack" });
    await plugin(bb);

    const spawnTool = harness.inspection.registrations.agentTools.find(
      (tool) => tool.name === "pstack_spawn_threads",
    );
    expect(spawnTool?.instructions).toContain("One owner per scope");
    expect(spawnTool?.instructions).toContain("Point children to files and artifacts");
    expect(spawnTool?.instructions).toContain("Those messages are the barrier");
    expect(
      harness.inspection.registrations.agentTools.map((tool) => tool.name),
    ).not.toContain("pstack_collect_threads");

    const configurationProvider =
      harness.inspection.registrations.agentConfigurationProvider;
    if (configurationProvider === null) {
      throw new Error("Expected pstack agent configuration provider.");
    }
    const configuration = await configurationProvider({
      thread: {
        id: "thr_parent",
        title: null,
        parentThreadId: null,
        sourceThreadId: null,
      },
      project: {
        id: "proj_test",
        kind: "standard",
        name: "Test project",
        gitRemoteUrl: null,
      },
      environment: {
        id: "env_test",
        name: null,
        path: "/tmp/test",
        workspaceProvisionType: "unmanaged",
        branchName: null,
      },
      host: { id: "host_test", name: "Test host" },
      provider: {
        id: "pi",
        model: "test-model",
        capabilities: { supportsNativeUserQuestion: false },
      },
      origin: { kind: null, pluginId: null },
    });
    expect(configuration.instructions).toContain("One owner per scope");
    expect(configuration.instructions).toContain("Those messages are the barrier");
    expect(configuration.instructions).not.toContain("pstack_collect_threads");
    expect(configuration.instructions).not.toContain("includeOutputs");

    await harness.lifecycle.dispose();
  });
});
