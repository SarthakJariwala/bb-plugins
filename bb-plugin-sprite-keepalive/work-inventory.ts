import type { BbPluginApi } from "@get-bb/plugin-sdk";

export type ThreadListItem = Awaited<
  ReturnType<BbPluginApi["sdk"]["threads"]["list"]>
>[number];

export interface WorkInventory {
  activeThreadCount: number;
  activeThreadIds: string[];
}

export interface InventoryOptions {
  diagnosticIdLimit?: number;
  pageSize?: number;
}

export function hasRelevantWork(thread: ThreadListItem): boolean {
  if (thread.deletedAt !== null || thread.archivedAt !== null) return false;

  const foreground =
    thread.status === "starting" ||
    thread.status === "active" ||
    thread.status === "stopping";
  const background =
    thread.activity.activeBackgroundAgentCount > 0 ||
    thread.activity.activeBackgroundCommandCount > 0 ||
    thread.activity.activeWorkflowCount > 0;

  return foreground || background;
}

export async function scanForActiveWork(
  threads: Pick<BbPluginApi["sdk"]["threads"], "list">,
  signal: AbortSignal,
  options: InventoryOptions = {},
): Promise<WorkInventory> {
  const pageSize = options.pageSize ?? 200;
  const diagnosticIdLimit = options.diagnosticIdLimit ?? 20;
  const activeIds = new Set<string>();
  let offset = 0;

  while (true) {
    const page = await threads.list({
      archived: false,
      includeHidden: true,
      limit: pageSize,
      offset,
      signal,
    });

    for (const thread of page) {
      if (hasRelevantWork(thread)) activeIds.add(thread.id);
    }

    if (page.length < pageSize) break;
    offset += page.length;
  }

  return {
    activeThreadCount: activeIds.size,
    activeThreadIds: [...activeIds].slice(0, diagnosticIdLimit),
  };
}
