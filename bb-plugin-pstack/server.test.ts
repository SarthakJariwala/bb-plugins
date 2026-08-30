import {
  createFakePluginHost,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import { describe, expect, it, vi } from "vitest";
import plugin from "./server";

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
      { model: "pi/custom", reasoningLevel: "high" },
    ]);

    await harness.lifecycle.dispose();
  });

  it("spawns visible Pi child threads with the configured role", async () => {
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

    expect(typeof output).toBe("string");
    expect(JSON.parse(output as string)).toEqual([
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

  it("keeps collected child threads visible unless cleanup is explicit", async () => {
    const archive = vi.fn(async () => undefined);
    const stop = vi.fn(async () => undefined);
    const { bb, harness } = createFakePluginHost({
      pluginId: "pstack",
      sdk: {
        threads: {
          get: async () =>
            makeThreadResponse({
              id: "thr_child",
              projectId: "proj_test",
              parentThreadId: "thr_parent",
              status: "idle",
              visibility: "visible",
            }),
          output: async () => ({ output: "done" }),
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

    await harness.behavior.callAgentTool("pstack_collect_threads", {
      threadIds: ["thr_child"],
      cleanup: true,
    });
    expect(archive).toHaveBeenCalledWith({ threadId: "thr_child" });
    expect(stop).toHaveBeenCalledWith({ threadId: "thr_child" });

    await harness.lifecycle.dispose();
  });
});
