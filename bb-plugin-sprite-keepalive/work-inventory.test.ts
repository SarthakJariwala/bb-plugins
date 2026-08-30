import { describe, expect, it, vi } from "vitest";
import {
  hasRelevantWork,
  scanForActiveWork,
  type ThreadListItem,
} from "./work-inventory";

function thread(
  overrides: Partial<ThreadListItem> & Pick<ThreadListItem, "id">,
): ThreadListItem {
  return {
    activity: {
      activeBackgroundAgentCount: 0,
      activeBackgroundCommandCount: 0,
      activeGoalCount: 0,
      activePlanModeCount: 0,
      activeWorkflowCount: 0,
    },
    archivedAt: null,
    createdAt: 1,
    deletedAt: null,
    environmentBranchName: null,
    environmentHostId: null,
    environmentId: null,
    environmentName: null,
    environmentWorkspaceDisplayKind: "other",
    hasPendingInteraction: false,
    lastReadAt: null,
    latestAttentionAt: 1,
    originKind: null,
    originPluginId: null,
    parentThreadId: null,
    pinSortKey: null,
    pinnedAt: null,
    projectId: "proj_test",
    providerId: "codex",
    runtime: { displayStatus: "idle", hostReconnectGraceExpiresAt: null },
    sectionId: null,
    sourceThreadId: null,
    status: "idle",
    title: null,
    titleFallback: null,
    updatedAt: 1,
    visibility: "visible",
    ...overrides,
    id: overrides.id,
  };
}

describe("hasRelevantWork", () => {
  it.each(["starting", "active", "stopping"] as const)(
    "treats %s as foreground work",
    (status) => {
      expect(hasRelevantWork(thread({ id: status, status }))).toBe(true);
    },
  );

  it.each(["idle", "error"] as const)(
    "does not treat %s as foreground work",
    (status) => {
      expect(hasRelevantWork(thread({ id: status, status }))).toBe(false);
    },
  );

  it.each([
    "activeBackgroundAgentCount",
    "activeBackgroundCommandCount",
    "activeWorkflowCount",
  ] as const)("treats %s as background work", (field) => {
    expect(
      hasRelevantWork(
        thread({
          id: field,
          activity: {
            ...thread({ id: "base" }).activity,
            [field]: 1,
          },
        }),
      ),
    ).toBe(true);
  });

  it("ignores goals and plan-mode presentation counts", () => {
    expect(
      hasRelevantWork(
        thread({
          id: "presentation-only",
          activity: {
            ...thread({ id: "base" }).activity,
            activeGoalCount: 1,
            activePlanModeCount: 1,
          },
        }),
      ),
    ).toBe(false);
  });

  it("excludes archived and deleted threads", () => {
    expect(
      hasRelevantWork(thread({ id: "archived", status: "active", archivedAt: 2 })),
    ).toBe(false);
    expect(
      hasRelevantWork(thread({ id: "deleted", status: "active", deletedAt: 2 })),
    ).toBe(false);
  });
});

describe("scanForActiveWork", () => {
  it("includes hidden work and requests only non-archived threads", async () => {
    const list = vi.fn().mockResolvedValue([
      thread({ id: "hidden", status: "active", visibility: "hidden" }),
      thread({ id: "idle" }),
    ]);
    const signal = new AbortController().signal;

    await expect(scanForActiveWork({ list }, signal)).resolves.toEqual({
      activeThreadCount: 1,
      activeThreadIds: ["hidden"],
    });
    expect(list).toHaveBeenCalledWith({
      archived: false,
      includeHidden: true,
      limit: 200,
      offset: 0,
      signal,
    });
  });

  it("pages through the complete inventory", async () => {
    const firstPage = Array.from({ length: 200 }, (_, index) =>
      thread({ id: `idle-${index}` }),
    );
    const list = vi.fn(async ({ offset }: { offset?: number }) =>
      offset === 0 ? firstPage : [thread({ id: "late-active", status: "active" })],
    );

    await expect(
      scanForActiveWork({ list } as never, new AbortController().signal),
    ).resolves.toEqual({
      activeThreadCount: 1,
      activeThreadIds: ["late-active"],
    });
    expect(list).toHaveBeenCalledTimes(2);
    expect(list.mock.calls[1]?.[0]).toMatchObject({ offset: 200 });
  });

  it("bounds diagnostic ids while retaining the exact count", async () => {
    const list = vi
      .fn()
      .mockResolvedValue(
        Array.from({ length: 25 }, (_, index) =>
          thread({ id: `active-${index}`, status: "active" }),
        ),
      );

    const result = await scanForActiveWork(
      { list },
      new AbortController().signal,
      { diagnosticIdLimit: 3 },
    );
    expect(result.activeThreadCount).toBe(25);
    expect(result.activeThreadIds).toHaveLength(3);
  });
});
