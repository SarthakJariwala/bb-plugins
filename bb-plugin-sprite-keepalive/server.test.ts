import {
  createFakePluginHost,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import { describe, expect, it, vi } from "vitest";
import { createSpriteKeepalivePlugin } from "./server";
import type { TaskLease } from "./sprite-task-client";
import type { ThreadListItem } from "./work-inventory";

function listThread(id: string, status: ThreadListItem["status"]): ThreadListItem {
  return {
    id,
    status,
    archivedAt: null,
    deletedAt: null,
    activity: {
      activeBackgroundAgentCount: 0,
      activeBackgroundCommandCount: 0,
      activeGoalCount: 0,
      activePlanModeCount: 0,
      activeWorkflowCount: 0,
    },
  } as ThreadListItem;
}

describe("sprite-keepalive plugin", () => {
  it("stays healthy but inactive when the Sprite socket is absent", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "sprite-keepalive",
      sdk: { threads: { list: async () => [] } },
    });
    await createSpriteKeepalivePlugin({ detectSprite: async () => false })(bb);

    const service = harness.behavior.runService("sprite-task-reconciler");
    await vi.waitFor(() =>
      expect(harness.logEntries).toContainEqual(
        expect.objectContaining({
          message:
            "Plugin inactive: Sprite management socket not found at /.sprite/api.sock",
        }),
      ),
    );
    const result = await harness.behavior.runCli(["status", "--json"]);
    expect(JSON.parse(result.stdout ?? "{}")).toMatchObject({
      spriteDetected: false,
      taskHeld: false,
    });

    service.controller.abort();
    await service.done;
    await harness.lifecycle.dispose();
  });

  it("reconciles lifecycle events, hidden work, status, and shutdown cleanup", async () => {
    let threads: ThreadListItem[] = [];
    const task = {
      acquire: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
      release: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    } satisfies TaskLease;
    const { bb, harness } = createFakePluginHost({
      pluginId: "sprite-keepalive",
      sdk: {
        subscribe: () => () => undefined,
        threads: { list: async () => threads },
      },
    });
    await createSpriteKeepalivePlugin({
      createTaskClient: () => task,
      detectSprite: async () => true,
    })(bb);

    const service = harness.behavior.runService("sprite-task-reconciler");
    await vi.waitFor(() =>
      expect(harness.inspection.sdk.callsTo("threads.list").length).toBeGreaterThan(0),
    );

    threads = [
      {
        ...listThread("thr_hidden", "active"),
        visibility: "hidden",
      },
    ];
    await harness.behavior.emitThreadEvent("thread.active", {
      thread: makeThreadResponse({ id: "thr_hidden", status: "active" }),
    });
    await vi.waitFor(() => expect(task.acquire).toHaveBeenCalledTimes(1));

    const result = await harness.behavior.runCli(["status", "--json"]);
    expect(JSON.parse(result.stdout ?? "{}")).toMatchObject({
      activeThreadCount: 1,
      activeThreadIds: ["thr_hidden"],
      spriteDetected: true,
      taskHeld: true,
    });

    service.controller.abort();
    await service.done;
    expect(task.release).toHaveBeenCalledTimes(1);
    await harness.lifecycle.dispose();
  });
});
