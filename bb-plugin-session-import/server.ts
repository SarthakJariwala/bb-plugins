import { defineRpcContract, type BbPluginApi } from "@bb/plugin-sdk";
import { z } from "zod";
import {
  parseSessionContent,
  providerKinds,
  rewriteSessionContent,
  type ProviderKind,
} from "./session-files";

const providerSchema = z.enum(providerKinds);
const permissionModeSchema = z.enum(["accept-edits", "auto", "full"]);
const reasoningLevelSchema = z.enum([
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "ultracode",
  "max",
  "ultra",
]);

const sessionSchema = z.object({
  provider: providerSchema,
  sourceId: z.string(),
  sourcePath: z.string(),
  title: z.string(),
  cwd: z.string().nullable(),
  createdAt: z.number(),
  modifiedAt: z.number(),
  messageCount: z.number().int().nonnegative(),
  importedThreadId: z.string().nullable(),
});

const inspectedSessionSchema = z.object({
  provider: providerSchema,
  sourceId: z.string(),
  sourcePath: z.string(),
  title: z.string(),
  cwd: z.string(),
  model: z.string().nullable(),
  reasoningLevel: z.string().nullable(),
  createdAt: z.number(),
  modifiedAt: z.number(),
  messageCount: z.number().int().nonnegative(),
  sizeBytes: z.number().int().nonnegative(),
});

export const rpcContract = defineRpcContract({
  bootstrap: {
    input: z.null(),
    output: z.object({
      hosts: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          status: z.enum(["connected", "disconnected"]),
        }),
      ),
      projects: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          kind: z.enum(["standard", "personal"]),
          sources: z.array(z.object({ hostId: z.string(), path: z.string() })),
        }),
      ),
    }),
  },
  listSessions: {
    input: z.object({
      hostId: z.string(),
      provider: providerSchema,
      query: z.string().max(200).default(""),
    }),
    output: z.object({ sessions: z.array(sessionSchema), truncated: z.boolean() }),
  },
  inspectSession: {
    input: z.object({
      hostId: z.string(),
      provider: providerSchema,
      sourcePath: z.string(),
    }),
    output: inspectedSessionSchema,
  },
  migrateSession: {
    input: z.object({
      hostId: z.string(),
      provider: providerSchema,
      sourcePath: z.string(),
      projectId: z.string(),
      permissionMode: permissionModeSchema,
    }),
    output: z.object({ threadId: z.string() }),
  },
  importedForThread: {
    input: z.object({ threadId: z.string() }),
    output: z.object({
      imported: z.boolean(),
      provider: providerSchema.nullable(),
      sourceId: z.string().nullable(),
      title: z.string().nullable(),
    }),
  },
});

type SessionListItem = z.infer<typeof sessionSchema>;
type FileApi = BbPluginApi["sdk"]["files"];

interface ImportedRow {
  provider: ProviderKind;
  source_id: string;
  thread_id: string;
  title: string;
}

function joinPath(base: string, ...parts: string[]): string {
  const separator = base.includes("\\") && !base.includes("/") ? "\\" : "/";
  return [base.replace(/[\\/]$/u, ""), ...parts.map((part) => part.replace(/^[\\/]+|[\\/]+$/gu, ""))]
    .filter(Boolean)
    .join(separator);
}

function dirname(path: string): string {
  const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return index <= 0 ? path : path.slice(0, index);
}

function basename(path: string): string {
  return path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
}

function absolutePath(root: string, candidate: string): string {
  if (candidate.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(candidate)) return candidate;
  return joinPath(root, candidate);
}

function isWithin(root: string, candidate: string): boolean {
  const normalizedRoot = root.replace(/[\\/]+$/u, "");
  return candidate === normalizedRoot || candidate.startsWith(`${normalizedRoot}/`) || candidate.startsWith(`${normalizedRoot}\\`);
}

function providerRoots(home: string, provider: ProviderKind): string[] {
  switch (provider) {
    case "claude-code":
      return [joinPath(home, ".claude", "projects")];
    case "codex":
      return [joinPath(home, ".codex", "sessions"), joinPath(home, ".codex", "archived_sessions")];
    case "pi":
      return [joinPath(home, ".pi", "agent", "sessions")];
  }
}

function sourceRoot(home: string, provider: ProviderKind, sourcePath: string): string {
  const root = providerRoots(home, provider).find((candidate) => isWithin(candidate, sourcePath));
  if (!root) throw new Error(`Selected file is outside ${provider}'s session directory`);
  return root;
}

async function hostHome(bb: BbPluginApi, hostId: string): Promise<string> {
  const listing = await bb.sdk.hosts.directory({ hostId });
  return listing.directory;
}

async function readIfPresent(
  files: FileApi,
  args: { hostId: string; path: string; rootPath: string },
) {
  try {
    return await files.read(args);
  } catch {
    return null;
  }
}

async function listSessionPaths(
  bb: BbPluginApi,
  hostId: string,
  roots: string[],
  query: string,
): Promise<{ paths: string[]; truncated: boolean }> {
  const results = await Promise.all(
    roots.map(async (root) => {
      try {
        return await bb.sdk.files.listPaths({
          hostId,
          path: root,
          query,
          limit: 500,
          includeFiles: true,
          includeDirectories: false,
        });
      } catch {
        return { paths: [], truncated: false };
      }
    }),
  );
  return {
    paths: results.flatMap((result, index) =>
      result.paths.map((entry) => absolutePath(roots[index]!, entry.path)),
    ),
    truncated: results.some((result) => result.truncated),
  };
}

async function listCodexRecentPaths(
  bb: BbPluginApi,
  hostId: string,
  home: string,
): Promise<string[]> {
  const sessionsRoot = joinPath(home, ".codex", "sessions");
  const archivedRoot = joinPath(home, ".codex", "archived_sessions");
  const paths: string[] = [];
  const browse = async (path: string) => {
    try {
      return await bb.sdk.hosts.directory({ hostId, path });
    } catch {
      return null;
    }
  };

  const archived = await browse(archivedRoot);
  if (archived) {
    paths.push(
      ...archived.entries
        .filter((entry) => entry.kind === "file" && entry.name.endsWith(".jsonl"))
        .map((entry) => entry.path),
    );
  }

  const years = (await browse(sessionsRoot))?.entries
    .filter((entry) => entry.kind === "directory" && /^\d{4}$/u.test(entry.name))
    .sort((a, b) => b.name.localeCompare(a.name)) ?? [];
  for (const year of years) {
    const months = (await browse(year.path))?.entries
      .filter((entry) => entry.kind === "directory" && /^\d{2}$/u.test(entry.name))
      .sort((a, b) => b.name.localeCompare(a.name)) ?? [];
    for (const month of months) {
      const days = (await browse(month.path))?.entries
        .filter((entry) => entry.kind === "directory" && /^\d{2}$/u.test(entry.name))
        .sort((a, b) => b.name.localeCompare(a.name)) ?? [];
      for (const day of days) {
        const listing = await browse(day.path);
        if (listing) {
          paths.push(
            ...listing.entries
              .filter((entry) => entry.kind === "file" && entry.name.endsWith(".jsonl"))
              .map((entry) => entry.path),
          );
        }
        if (paths.length >= 500) return paths;
      }
    }
  }
  return paths;
}

interface HistorySummary {
  title: string;
  cwd: string | null;
  createdAt: number;
  modifiedAt: number;
  messageCount: number;
}

function summarizeHistory(
  content: string,
  provider: "claude-code" | "codex",
): Map<string, HistorySummary> {
  const summaries = new Map<string, HistorySummary>();
  for (const line of content.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as Record<string, unknown>;
      const sourceId = provider === "claude-code" ? row.sessionId : row.session_id;
      if (typeof sourceId !== "string") continue;
      const rawTime = provider === "claude-code" ? row.timestamp : row.ts;
      const at = typeof rawTime === "number" ? (rawTime < 10_000_000_000 ? rawTime * 1000 : rawTime) : 0;
      const text = provider === "claude-code" ? row.display : row.text;
      const cwd = provider === "claude-code" && typeof row.project === "string" ? row.project : null;
      const previous = summaries.get(sourceId);
      summaries.set(sourceId, {
        title:
          previous?.title || (typeof text === "string" && text.trim() ? text.replace(/\s+/gu, " ").trim().slice(0, 140) : `CLI session ${sourceId.slice(0, 8)}`),
        cwd: previous?.cwd ?? cwd,
        createdAt: previous ? Math.min(previous.createdAt || at, at || previous.createdAt) : at,
        modifiedAt: Math.max(previous?.modifiedAt ?? 0, at),
        messageCount: (previous?.messageCount ?? 0) + 1,
      });
    } catch {
      // Ignore a partial trailing history record.
    }
  }
  return summaries;
}

function sourceIdFromPath(provider: ProviderKind, path: string): string | null {
  const name = basename(path);
  if (!name.endsWith(".jsonl")) return null;
  if (provider === "claude-code") return name.slice(0, -6);
  if (provider === "codex") {
    return name.match(/([0-9a-f]{8}-[0-9a-f-]{27})\.jsonl$/iu)?.[1] ?? null;
  }
  return name.match(/_([0-9a-f]{8}-[0-9a-f-]{27})\.jsonl$/iu)?.[1] ?? null;
}

function piTimestampFromPath(path: string): number {
  const match = basename(path).match(/^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)_/u);
  if (!match) return 0;
  return Date.parse(match[1]!.replace(/T(\d{2})-(\d{2})-(\d{2})-/u, "T$1:$2:$3."));
}

function matchesQuery(item: SessionListItem, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return true;
  return [item.title, item.cwd ?? "", item.sourceId, item.sourcePath]
    .join("\n")
    .toLocaleLowerCase()
    .includes(needle);
}

async function buildSessionList(
  bb: BbPluginApi,
  db: ReturnType<BbPluginApi["storage"]["database"]>,
  args: { hostId: string; provider: ProviderKind; query: string },
): Promise<{ sessions: SessionListItem[]; truncated: boolean }> {
  const home = await hostHome(bb, args.hostId);
  const roots = providerRoots(home, args.provider);
  const listed = await listSessionPaths(bb, args.hostId, roots, "jsonl");
  const recentCodexPaths =
    args.provider === "codex"
      ? await listCodexRecentPaths(bb, args.hostId, home)
      : [];
  const pathsById = new Map<string, string>();
  for (const path of [...listed.paths, ...recentCodexPaths]) {
    if (path.includes(`${args.provider === "claude-code" ? ".claude" : args.provider === "codex" ? ".codex" : ".pi"}${path.includes("\\") ? "\\" : "/"}`)) {
      const id = sourceIdFromPath(args.provider, path);
      if (id) pathsById.set(id, path);
    }
  }

  let history = new Map<string, HistorySummary>();
  const managedCodexIds = new Set<string>();
  if (args.provider === "claude-code" || args.provider === "codex") {
    const historyRoot = joinPath(home, args.provider === "claude-code" ? ".claude" : ".codex");
    const historyFile = await readIfPresent(bb.sdk.files, {
      hostId: args.hostId,
      path: joinPath(historyRoot, "history.jsonl"),
      rootPath: historyRoot,
    });
    if (historyFile) history = summarizeHistory(historyFile.content, args.provider);
    if (args.provider === "codex") {
      const indexFile = await readIfPresent(bb.sdk.files, {
        hostId: args.hostId,
        path: joinPath(historyRoot, "session_index.jsonl"),
        rootPath: historyRoot,
      });
      if (indexFile) {
        for (const line of indexFile.content.split(/\r?\n/u)) {
          try {
            const row = JSON.parse(line) as Record<string, unknown>;
            if (
              typeof row.id === "string" &&
              typeof row.thread_name === "string" &&
              row.thread_name.startsWith("[bb]")
            ) {
              managedCodexIds.add(row.id);
            }
          } catch {
            // Ignore a partial trailing index record.
          }
        }
      }
    }
  }

  const imported = db
    .prepare("SELECT provider, source_id, thread_id, title FROM imported_sessions WHERE host_id = ? AND provider = ?")
    .all(args.hostId, args.provider) as ImportedRow[];
  const importedBySource = new Map(imported.map((row) => [row.source_id, row.thread_id]));
  const ids = new Set([...pathsById.keys(), ...history.keys()]);
  const sessions: SessionListItem[] = [];
  for (const sourceId of ids) {
    if (managedCodexIds.has(sourceId)) continue;
    const sourcePath = pathsById.get(sourceId);
    if (!sourcePath) continue;
    const summary = history.get(sourceId);
    const at = args.provider === "pi" ? piTimestampFromPath(sourcePath) : 0;
    sessions.push({
      provider: args.provider,
      sourceId,
      sourcePath,
      title:
        summary?.title ??
        (args.provider === "pi"
          ? `Pi session · ${basename(dirname(sourcePath)).replace(/^--|--$/gu, "")}`
          : `${args.provider === "codex" ? "Codex" : "Claude"} session ${sourceId.slice(0, 8)}`),
      cwd: summary?.cwd ?? null,
      createdAt: summary?.createdAt ?? at,
      modifiedAt: summary?.modifiedAt ?? at,
      messageCount: summary?.messageCount ?? 0,
      importedThreadId: importedBySource.get(sourceId) ?? null,
    });
  }
  sessions.sort((a, b) => b.modifiedAt - a.modifiedAt || b.sourcePath.localeCompare(a.sourcePath));
  return {
    sessions: sessions.filter((item) => matchesQuery(item, args.query)).slice(0, 150),
    truncated:
      listed.truncated ||
      recentCodexPaths.length >= 500 ||
      sessions.length > 150,
  };
}

async function inspectSource(
  bb: BbPluginApi,
  args: { hostId: string; provider: ProviderKind; sourcePath: string },
) {
  const home = await hostHome(bb, args.hostId);
  const root = sourceRoot(home, args.provider, args.sourcePath);
  const file = await bb.sdk.files.read({ hostId: args.hostId, path: args.sourcePath, rootPath: root });
  const metadata = parseSessionContent(args.provider, file.content);
  return { file, home, metadata, root };
}

async function waitForProviderIdentity(bb: BbPluginApi, threadId: string): Promise<string> {
  const existing = await bb.sdk.threads.events.list({ threadId, limit: "200" });
  const storedIdentity = [...existing]
    .reverse()
    .find((row) => row.type === "thread/identity");
  const waitedIdentity = storedIdentity
    ? null
    : await bb.sdk.threads.events.wait({
        threadId,
        type: "thread/identity",
        waitMs: "45000",
      });
  const identity = storedIdentity ?? waitedIdentity;
  if (!identity || identity.type !== "thread/identity") {
    throw new Error("BB started the managed thread but the provider did not report a session id");
  }
  return identity.data.providerThreadId;
}

async function unloadBootstrapRuntime(bb: BbPluginApi, threadId: string): Promise<void> {
  // The public spawn API currently requires one input item. Start hidden with
  // agent-only bootstrap context, stop as soon as provider identity exists,
  // then archive to forget the warm runtime before replacing its session file.
  await bb.sdk.threads.stop({ threadId }).catch(() => undefined);
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const thread = await bb.sdk.threads.get({ threadId });
    if (thread.status === "idle" || thread.status === "error") return;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error("Timed out while stopping the temporary provider bootstrap");
}

async function findCodexTarget(
  bb: BbPluginApi,
  hostId: string,
  home: string,
  targetId: string,
): Promise<{ path: string; root: string } | null> {
  const roots = providerRoots(home, "codex");
  for (let attempt = 0; attempt < 15; attempt += 1) {
    const listed = await listSessionPaths(bb, hostId, roots, targetId);
    const path = listed.paths.find((candidate) => sourceIdFromPath("codex", candidate) === targetId);
    if (path) return { path, root: roots.find((candidate) => isWithin(candidate, path))! };
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return null;
}

async function managedTarget(
  bb: BbPluginApi,
  args: {
    hostId: string;
    home: string;
    provider: ProviderKind;
    sourcePath: string;
    targetId: string;
    threadId: string;
  },
): Promise<{ path: string; root: string }> {
  if (args.provider === "claude-code") {
    const root = dirname(args.sourcePath);
    return { path: joinPath(root, `${args.targetId}.jsonl`), root };
  }
  if (args.provider === "pi") {
    const root = joinPath(args.home, ".bb", "pi-bridge-sessions");
    return { path: joinPath(root, `${args.threadId}.jsonl`), root };
  }
  const found = await findCodexTarget(bb, args.hostId, args.home, args.targetId);
  if (!found) throw new Error("Could not locate the new BB-managed Codex rollout file");
  return found;
}

function safeReasoning(value: string | null) {
  return reasoningLevelSchema.safeParse(value).success
    ? (value as z.infer<typeof reasoningLevelSchema>)
    : undefined;
}

function importTitle(title: string): string {
  const value = `Continue: ${title}`;
  return value.length > 100 ? `${value.slice(0, 97)}…` : value;
}

export default async function plugin(bb: BbPluginApi) {
  const db = bb.storage.database();
  bb.storage.migrate(db, [
    `CREATE TABLE IF NOT EXISTS imported_sessions (
      host_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      source_id TEXT NOT NULL,
      source_path TEXT NOT NULL,
      thread_id TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      imported_at INTEGER NOT NULL,
      PRIMARY KEY (host_id, provider, source_id)
    )`,
  ]);

  bb.rpc.register(rpcContract, {
    async bootstrap() {
      const [hosts, projects] = await Promise.all([
        bb.sdk.hosts.list(),
        bb.sdk.projects.list({ includePersonal: true }),
      ]);
      return {
        hosts: hosts.map(({ id, name, status }) => ({ id, name, status })),
        projects: projects.map(({ id, name, kind, sources }) => ({
          id,
          name,
          kind,
          sources: sources.map(({ hostId, path }) => ({ hostId, path })),
        })),
      };
    },

    listSessions: (args) => buildSessionList(bb, db, args),

    async inspectSession(args) {
      const { file, metadata } = await inspectSource(bb, args);
      return { provider: args.provider, sourcePath: args.sourcePath, ...metadata, sizeBytes: file.sizeBytes };
    },

    async migrateSession(args) {
      const existing = db
        .prepare(
          "SELECT thread_id FROM imported_sessions WHERE host_id = ? AND provider = ? AND source_path = ?",
        )
        .get(args.hostId, args.provider, args.sourcePath) as
        | { thread_id: string }
        | undefined;
      if (existing) return { threadId: existing.thread_id };

      const { file, home, metadata } = await inspectSource(bb, args);
      const duplicate = db
        .prepare("SELECT thread_id FROM imported_sessions WHERE host_id = ? AND provider = ? AND source_id = ?")
        .get(args.hostId, args.provider, metadata.sourceId) as { thread_id: string } | undefined;
      if (duplicate) return { threadId: duplicate.thread_id };

      const providerOptions = await bb.sdk.providers.models({
        hostId: args.hostId,
        providerId: args.provider,
      });
      const preservedModel = metadata.model
        ? providerOptions.models.find((candidate) => candidate.model === metadata.model)
        : undefined;
      const preservedReasoning = safeReasoning(metadata.reasoningLevel);
      const reasoningSupported =
        preservedModel && preservedReasoning
          ? preservedModel.supportedReasoningEfforts.some(
              (effort) => effort.reasoningEffort === preservedReasoning,
            )
          : false;

      let threadId: string | null = null;
      let targetWritten = false;
      try {
        const thread = await bb.sdk.threads.spawn({
          projectId: args.projectId,
          providerId: args.provider,
          title: importTitle(metadata.title),
          visibility: "hidden",
          input: [
            {
              type: "text",
              text: "Preparing this provider session for CLI history import.",
              mentions: [],
              visibility: "agent-only",
            },
          ],
          permissionMode: args.permissionMode,
          ...(preservedModel ? { model: preservedModel.model } : {}),
          ...(reasoningSupported && preservedReasoning
            ? { reasoningLevel: preservedReasoning }
            : {}),
          environment: {
            type: "host",
            hostId: args.hostId,
            workspace: { type: "unmanaged", path: metadata.cwd },
          },
        });
        threadId = thread.id;
        const targetId = await waitForProviderIdentity(bb, thread.id);
        await unloadBootstrapRuntime(bb, thread.id);

        // Archiving is the provider-runtime handoff barrier. It forgets the
        // warm runtime (and moves a Codex rollout to its archive); the next
        // user send cold-resumes from the file installed below.
        await bb.sdk.threads.archive({ threadId: thread.id });
        const target = await managedTarget(bb, {
          hostId: args.hostId,
          home,
          provider: args.provider,
          sourcePath: args.sourcePath,
          targetId,
          threadId: thread.id,
        });
        const previous = await readIfPresent(bb.sdk.files, {
          hostId: args.hostId,
          path: target.path,
          rootPath: target.root,
        });
        const rewritten = rewriteSessionContent(
          args.provider,
          file.content,
          metadata.sourceId,
          targetId,
        );
        const write = await bb.sdk.files.write({
          hostId: args.hostId,
          path: target.path,
          rootPath: target.root,
          content: rewritten,
          createParents: true,
          expectedSha256: previous?.sha256 ?? null,
          mode: 0o600,
        });
        if (write.outcome === "conflict") {
          throw new Error("The provider session changed during import; refresh and try again");
        }
        targetWritten = true;
        await bb.sdk.threads.unarchive({ threadId: thread.id });
        await bb.sdk.threads.update({
          threadId: thread.id,
          visibility: "visible",
        });
        db.prepare(
          `INSERT INTO imported_sessions
            (host_id, provider, source_id, source_path, thread_id, title, imported_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          args.hostId,
          args.provider,
          metadata.sourceId,
          args.sourcePath,
          thread.id,
          metadata.title,
          Date.now(),
        );
        bb.log.info(`Imported ${args.provider} session ${metadata.sourceId} as ${thread.id}`);
        return { threadId: thread.id };
      } catch (error) {
        if (threadId && !targetWritten) {
          await bb.sdk.threads
            .delete({ threadId, childThreadsConfirmed: true })
            .catch(() => undefined);
        } else if (threadId && targetWritten) {
          await bb.sdk.threads.unarchive({ threadId }).catch(() => undefined);
        }
        throw error;
      }
    },

    importedForThread({ threadId }) {
      const row = db
        .prepare("SELECT provider, source_id, title FROM imported_sessions WHERE thread_id = ?")
        .get(threadId) as Pick<ImportedRow, "provider" | "source_id" | "title"> | undefined;
      return row
        ? { imported: true, provider: row.provider, sourceId: row.source_id, title: row.title }
        : { imported: false, provider: null, sourceId: null, title: null };
    },
  });

  bb.events.on("thread.deleted", ({ thread }) => {
    db.prepare("DELETE FROM imported_sessions WHERE thread_id = ?").run(thread.id);
  });

  bb.cli.register({
    name: "session-import",
    summary: "Discover and continue local Claude Code, Codex, and Pi CLI sessions in BB",
    commands: [
      { name: "list", summary: "List importable CLI sessions", usage: "bb session-import list <claude-code|codex|pi> --machine <host-id>" },
    ],
    async run() {
      return {
        exitCode: 0,
        stdout: "Open Session Import in the BB sidebar to discover and continue CLI sessions.\n",
      };
    },
  });

  bb.log.info("Session Import loaded");
}
