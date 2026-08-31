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

function isToolError(result: PluginAgentToolResult): boolean {
  return typeof result !== "string" && result.isError === true;
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

  it("waits for an active child to become idle", async () => {
    vi.useFakeTimers();
    let readCount = 0;
    const output = vi.fn(async () => ({ output: "duplicate report" }));
    const { bb, harness } = createFakePluginHost({
      pluginId: "pstack",
      sdk: {
        threads: {
          get: async () => childThread(readCount++ === 0 ? "active" : "idle"),
          output,
          interactions: { list: async () => [] },
        },
      },
    });
    await plugin(bb);

    const collecting = harness.behavior.callAgentTool("pstack_collect_threads", {
      threadIds: ["thr_child"],
    });
    await vi.advanceTimersByTimeAsync(1_000);

    expect(JSON.parse(resultText(await collecting))).toEqual({
      complete: true,
      outcomes: [
        {
          kind: "completed",
          threadId: "thr_child",
          status: "idle",
          pendingInteractions: 0,
          cleanup: "not-requested",
          outputIncluded: false,
        },
      ],
    });
    expect(output).not.toHaveBeenCalled();

    await harness.lifecycle.dispose();
  });

  it("fails on timeout and supports recollection after the child completes", async () => {
    vi.useFakeTimers();
    let status: "active" | "idle" = "active";
    const { bb, harness } = createFakePluginHost({
      pluginId: "pstack",
      sdk: {
        threads: {
          get: async () => childThread(status),
          interactions: { list: async () => [] },
        },
      },
    });
    await plugin(bb);

    const firstCollection = harness.behavior.callAgentTool("pstack_collect_threads", {
      threadIds: ["thr_child"],
      timeoutSeconds: 1,
    });
    await vi.advanceTimersByTimeAsync(1_000);
    const timedOut = await firstCollection;
    expect(isToolError(timedOut)).toBe(true);
    expect(JSON.parse(resultText(timedOut))).toEqual(
      expect.objectContaining({
        complete: false,
        outcomes: [
          {
            kind: "timed-out",
            threadId: "thr_child",
            status: "active",
            pendingInteractions: 0,
          },
        ],
        action: expect.stringContaining("Recollect timed-out workers"),
      }),
    );

    status = "idle";
    const recollected = await harness.behavior.callAgentTool("pstack_collect_threads", {
      threadIds: ["thr_child"],
    });
    expect(isToolError(recollected)).toBe(false);
    expect(JSON.parse(resultText(recollected))).toEqual(
      expect.objectContaining({
        complete: true,
        outcomes: [expect.objectContaining({ kind: "completed" })],
      }),
    );

    await harness.lifecycle.dispose();
  });

  it("returns incomplete outcomes when allowPartial explicitly waives the barrier", async () => {
    vi.useFakeTimers();
    const { bb, harness } = createFakePluginHost({
      pluginId: "pstack",
      sdk: {
        threads: {
          get: async () => childThread("active"),
          interactions: { list: async () => [] },
        },
      },
    });
    await plugin(bb);

    const collecting = harness.behavior.callAgentTool("pstack_collect_threads", {
      threadIds: ["thr_child"],
      timeoutSeconds: 1,
      allowPartial: true,
    });
    await vi.advanceTimersByTimeAsync(1_000);
    const result = await collecting;

    expect(isToolError(result)).toBe(false);
    expect(JSON.parse(resultText(result))).toEqual({
      complete: false,
      outcomes: [
        {
          kind: "timed-out",
          threadId: "thr_child",
          status: "active",
          pendingInteractions: 0,
        },
      ],
    });

    await harness.lifecycle.dispose();
  });

  it("reports child thread failures as error outcomes", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "pstack",
      sdk: {
        threads: {
          get: async () => childThread("error"),
          interactions: { list: async () => [] },
        },
      },
    });
    await plugin(bb);

    const result = await harness.behavior.callAgentTool("pstack_collect_threads", {
      threadIds: ["thr_child"],
    });

    expect(isToolError(result)).toBe(true);
    expect(JSON.parse(resultText(result))).toEqual(
      expect.objectContaining({
        complete: false,
        outcomes: [
          expect.objectContaining({
            kind: "error",
            threadId: "thr_child",
            status: "error",
            outputIncluded: false,
          }),
        ],
      }),
    );

    await harness.lifecycle.dispose();
  });

  it("reports pending interactions as blocked and never cleans them up", async () => {
    const archive = vi.fn(async () => undefined);
    const stop = vi.fn(async () => undefined);
    const pendingInteractions: never[] = [];
    pendingInteractions.length = 1;
    const { bb, harness } = createFakePluginHost({
      pluginId: "pstack",
      sdk: {
        threads: {
          get: async () => childThread("idle"),
          interactions: { list: async () => pendingInteractions },
          archive,
          stop,
        },
      },
    });
    await plugin(bb);

    const result = await harness.behavior.callAgentTool("pstack_collect_threads", {
      threadIds: ["thr_child"],
      cleanup: true,
    });

    expect(isToolError(result)).toBe(true);
    expect(JSON.parse(resultText(result))).toEqual(
      expect.objectContaining({
        complete: false,
        outcomes: [
          {
            kind: "blocked",
            threadId: "thr_child",
            status: "idle",
            pendingInteractions: 1,
          },
        ],
      }),
    );
    expect(archive).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();

    await harness.lifecycle.dispose();
  });

  it("fetches and returns full child output only when includeOutputs is true", async () => {
    const output = vi.fn(async () => ({ output: "full child report" }));
    const { bb, harness } = createFakePluginHost({
      pluginId: "pstack",
      sdk: {
        threads: {
          get: async () => childThread("idle"),
          output,
          interactions: { list: async () => [] },
        },
      },
    });
    await plugin(bb);

    const compact = await harness.behavior.callAgentTool("pstack_collect_threads", {
      threadIds: ["thr_child"],
    });
    expect(output).not.toHaveBeenCalled();
    expect(JSON.parse(resultText(compact))).toEqual(
      expect.objectContaining({
        outcomes: [expect.objectContaining({ outputIncluded: false })],
      }),
    );

    const expanded = await harness.behavior.callAgentTool("pstack_collect_threads", {
      threadIds: ["thr_child"],
      includeOutputs: true,
    });
    expect(output).toHaveBeenCalledTimes(1);
    expect(JSON.parse(resultText(expanded))).toEqual(
      expect.objectContaining({
        outcomes: [
          expect.objectContaining({
            outputIncluded: true,
            output: "full child report",
          }),
        ],
      }),
    );

    await harness.lifecycle.dispose();
  });

  it("keeps completed child threads visible unless cleanup is explicit", async () => {
    const archive = vi.fn(async () => undefined);
    const stop = vi.fn(async () => undefined);
    const { bb, harness } = createFakePluginHost({
      pluginId: "pstack",
      sdk: {
        threads: {
          get: async () => childThread("idle"),
          interactions: { list: async () => [] },
          archive,
          stop,
        },
      },
    });
    await plugin(bb);

    await harness.behavior.callAgentTool("pstack_collect_threads", {
      threadIds: ["thr_child"],
    });
    expect(archive).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();

    const result = await harness.behavior.callAgentTool("pstack_collect_threads", {
      threadIds: ["thr_child"],
      cleanup: true,
    });
    expect(JSON.parse(resultText(result))).toEqual(
      expect.objectContaining({
        complete: true,
        outcomes: [expect.objectContaining({ cleanup: "completed" })],
      }),
    );
    expect(archive).toHaveBeenCalledWith({ threadId: "thr_child" });
    expect(stop).toHaveBeenCalledWith({ threadId: "thr_child" });

    await harness.lifecycle.dispose();
  });

  it("does not clean up when collection is aborted", async () => {
    const controller = new AbortController();
    const archive = vi.fn(async () => undefined);
    const stop = vi.fn(async () => undefined);
    const started: { resolve: () => void } = { resolve: () => undefined };
    const getStarted = new Promise<void>((resolve) => {
      started.resolve = resolve;
    });
    const { bb, harness } = createFakePluginHost({
      pluginId: "pstack",
      sdk: {
        threads: {
          get: ({ signal }) => {
            started.resolve();
            return new Promise<never>((_resolve, reject) => {
              signal?.addEventListener(
                "abort",
                () => reject(signal.reason ?? new Error("Aborted")),
                { once: true },
              );
            });
          },
          interactions: { list: async () => [] },
          archive,
          stop,
        },
      },
    });
    await plugin(bb);

    const collecting = harness.behavior.callAgentTool(
      "pstack_collect_threads",
      { threadIds: ["thr_child"], cleanup: true },
      { signal: controller.signal },
    );
    await getStarted;
    controller.abort(new Error("test abort"));

    await expect(collecting).rejects.toThrow("test abort");
    expect(archive).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();

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
    expect(configuration.instructions).toContain("includeOutputs false");

    await harness.lifecycle.dispose();
  });
});
