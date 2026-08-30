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

  it("spawns hidden Pi child threads with the configured role", async () => {
    const spawn = vi.fn(async () =>
      makeThreadResponse({
        id: "thr_child",
        projectId: "proj_test",
        parentThreadId: "thr_parent",
        providerId: "pi",
        status: "active",
        visibility: "hidden",
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
        visibility: "hidden",
        environment: { type: "reuse", environmentId: "env_test" },
      }),
    );

    await harness.lifecycle.dispose();
  });
});
