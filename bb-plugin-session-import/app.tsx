import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ChangeEvent,
} from "react";
import {
  definePluginApp,
  useBbContext,
  useBbNavigate,
  useComposerView,
  useRpc,
  type PluginNavPanelProps,
} from "@bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "./server";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const PROVIDERS = [
  { id: "claude-code", label: "Claude Code", mark: "C" },
  { id: "codex", label: "Codex", mark: "X" },
  { id: "pi", label: "Pi", mark: "π" },
] as const;

type Provider = (typeof PROVIDERS)[number]["id"];
type Session = {
  provider: Provider;
  sourceId: string;
  sourcePath: string;
  title: string;
  cwd: string | null;
  createdAt: number;
  modifiedAt: number;
  messageCount: number;
  importedThreadId: string | null;
};
type InspectedSession = Session & {
  cwd: string;
  model: string | null;
  reasoningLevel: string | null;
  sizeBytes: number;
};

type Host = { id: string; name: string; status: "connected" | "disconnected" };
type Project = {
  id: string;
  name: string;
  kind: "standard" | "personal";
  sources: Array<{ hostId: string; path: string }>;
};

const selectClass =
  "h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground shadow-xs outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-50";

function providerInfo(provider: Provider) {
  return PROVIDERS.find((item) => item.id === provider)!;
}

function relativeTime(value: number): string {
  if (!value) return "Unknown date";
  const delta = Date.now() - value;
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(value).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: new Date(value).getFullYear() === new Date().getFullYear() ? undefined : "numeric",
  });
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function ProviderMark({ provider, small = false }: { provider: Provider; small?: boolean }) {
  const info = providerInfo(provider);
  return (
    <span
      aria-hidden="true"
      className={`grid shrink-0 place-items-center rounded-md border border-border bg-muted font-semibold text-foreground ${
        small ? "size-6 text-[11px]" : "size-9 text-sm"
      }`}
    >
      {info.mark}
    </span>
  );
}

function EmptyState({ provider, searching }: { provider: Provider; searching: boolean }) {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center px-6 py-20 text-center">
      <ProviderMark provider={provider} />
      <h2 className="mt-4 text-base font-medium text-foreground">
        {searching ? "No matching sessions" : `No ${providerInfo(provider).label} sessions found`}
      </h2>
      <p className="mt-1 text-sm leading-6 text-muted-foreground">
        {searching
          ? "Try a session id, workspace path, or words from the first prompt."
          : "Start a session from the CLI on this machine, then refresh this page."}
      </p>
    </div>
  );
}

function SessionRow({
  session,
  onContinue,
  onOpen,
}: {
  session: Session;
  onContinue: (session: Session) => void;
  onOpen: (threadId: string) => void;
}) {
  return (
    <article className="group flex gap-3 border-b border-border px-4 py-4 transition-colors hover:bg-muted/35 md:px-5">
      <ProviderMark provider={session.provider} />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="truncate text-sm font-medium text-foreground">{session.title}</h3>
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
              <span>{relativeTime(session.modifiedAt)}</span>
              {session.messageCount > 0 ? <span>{session.messageCount} messages</span> : null}
              <span className="font-mono">{session.sourceId.slice(0, 8)}</span>
            </div>
          </div>
          {session.importedThreadId ? (
            <Button size="sm" variant="outline" onClick={() => onOpen(session.importedThreadId!)}>
              Open in BB
            </Button>
          ) : (
            <Button size="sm" onClick={() => onContinue(session)}>
              Continue in BB
            </Button>
          )}
        </div>
        <p className="mt-2 truncate text-xs text-muted-foreground" title={session.cwd ?? session.sourcePath}>
          {session.cwd ?? session.sourcePath}
        </p>
      </div>
    </article>
  );
}

function ImportDialog({
  session,
  hostId,
  projects,
  preferredProjectId,
  onClose,
  onImported,
}: {
  session: Session | null;
  hostId: string;
  projects: Project[];
  preferredProjectId: string | null;
  onClose: () => void;
  onImported: (threadId: string) => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [details, setDetails] = useState<InspectedSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [projectId, setProjectId] = useState("");
  const [permissionMode, setPermissionMode] = useState<"accept-edits" | "auto" | "full">("auto");
  const [migrating, setMigrating] = useState(false);

  useEffect(() => {
    if (!session) return;
    setDetails(null);
    setError(null);
    setProjectId(
      (preferredProjectId && projects.some((project) => project.id === preferredProjectId)
        ? preferredProjectId
        : projects[0]?.id) ?? "",
    );
    setPermissionMode(session.provider === "pi" ? "full" : "auto");
    void rpc
      .call("inspectSession", {
        hostId,
        provider: session.provider,
        sourcePath: session.sourcePath,
      })
      .then((result) => {
        const inspected = result as InspectedSession;
        setDetails(inspected);
        if (!preferredProjectId) {
          const matchingProject = projects.find((project) =>
            project.sources.some(
              (source) =>
                source.hostId === hostId &&
                (source.path === inspected.cwd ||
                  inspected.cwd.startsWith(`${source.path}/`) ||
                  inspected.cwd.startsWith(`${source.path}\\`)),
            ),
          );
          if (matchingProject) setProjectId(matchingProject.id);
        }
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, [hostId, preferredProjectId, projects, rpc, session]);

  async function migrate() {
    if (!session || !projectId) return;
    setMigrating(true);
    setError(null);
    try {
      const result = await rpc.call("migrateSession", {
        hostId,
        provider: session.provider,
        sourcePath: session.sourcePath,
        projectId,
        permissionMode,
      });
      toast.success("CLI session is ready in BB");
      onImported(result.threadId);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message);
      toast.error("Session import failed");
    } finally {
      setMigrating(false);
    }
  }

  return (
    <Dialog open={session !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Continue in BB</DialogTitle>
          <DialogDescription>
            BB creates an empty managed session, installs this CLI history into it, and resumes it on your first message.
          </DialogDescription>
        </DialogHeader>

        {session ? (
          <div className="space-y-4 py-1">
            <div className="rounded-lg border border-border bg-muted/30 p-3">
              <div className="flex items-start gap-3">
                <ProviderMark provider={session.provider} small />
                <div className="min-w-0">
                  <p className="text-sm font-medium text-foreground">{details?.title ?? session.title}</p>
                  <p className="mt-1 break-all text-xs text-muted-foreground">
                    {details?.cwd ?? session.cwd ?? session.sourcePath}
                  </p>
                  {details ? (
                    <p className="mt-2 text-xs text-muted-foreground">
                      {details.messageCount} messages · {formatBytes(details.sizeBytes)}
                      {details.model ? ` · ${details.model}` : ""}
                    </p>
                  ) : error ? null : (
                    <p className="mt-2 text-xs text-muted-foreground">Reading session metadata…</p>
                  )}
                </div>
              </div>
            </div>

            <label className="block space-y-1.5">
              <span className="text-sm font-medium text-foreground">BB project</span>
              <select
                className={selectClass}
                value={projectId}
                onChange={(event: ChangeEvent<HTMLSelectElement>) => setProjectId(event.target.value)}
              >
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}{project.kind === "personal" ? " (Personal)" : ""}
                  </option>
                ))}
              </select>
            </label>

            <label className="block space-y-1.5">
              <span className="text-sm font-medium text-foreground">Permission mode</span>
              <select
                className={selectClass}
                value={permissionMode}
                onChange={(event: ChangeEvent<HTMLSelectElement>) =>
                  setPermissionMode(event.target.value as "accept-edits" | "auto" | "full")
                }
                disabled={session.provider === "pi"}
              >
                <option value="accept-edits">Accept edits</option>
                <option value="auto">Approve for me</option>
                <option value="full">Full access</option>
              </select>
              {session.provider === "pi" ? (
                <span className="block text-xs text-muted-foreground">Pi sessions currently run with Full access in BB.</span>
              ) : null}
            </label>

            <div className="rounded-md border border-border px-3 py-2 text-xs leading-5 text-muted-foreground">
              The original CLI session is left untouched. Its full provider history remains context, while the visible BB timeline begins with your next message.
            </div>

            {error ? <p className="text-sm text-destructive">{error}</p> : null}
          </div>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={migrating}>
            Cancel
          </Button>
          <Button
            onClick={() => void migrate()}
            disabled={!details || !projectId || migrating || Boolean(error)}
          >
            {migrating ? "Migrating…" : "Continue in BB"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SessionImportPanel(_props: PluginNavPanelProps) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const context = useBbContext();
  const [hosts, setHosts] = useState<Host[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [hostId, setHostId] = useState("");
  const [provider, setProvider] = useState<Provider>("claude-code");
  const [query, setQuery] = useState("");
  const [sessions, setSessions] = useState<Session[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Session | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    void rpc
      .call("bootstrap")
      .then((result) => {
        const nextHosts = result.hosts as Host[];
        setHosts(nextHosts);
        setProjects(result.projects as Project[]);
        setHostId(nextHosts.find((host) => host.status === "connected")?.id ?? nextHosts[0]?.id ?? "");
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, [rpc]);

  const load = useCallback(async () => {
    if (!hostId) return;
    setLoading(true);
    setError(null);
    try {
      const result = await rpc.call("listSessions", { hostId, provider, query });
      setSessions(result.sessions as Session[]);
      setTruncated(result.truncated);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setSessions([]);
    } finally {
      setLoading(false);
    }
  }, [hostId, provider, query, rpc]);

  useEffect(() => {
    const timer = setTimeout(() => void load(), query ? 250 : 0);
    return () => clearTimeout(timer);
  }, [load, refreshKey, query]);

  const connectedHosts = useMemo(() => hosts.filter((host) => host.status === "connected"), [hosts]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="shrink-0 border-b border-border px-4 py-3 md:px-5">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex rounded-lg bg-muted p-1">
            {PROVIDERS.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`rounded-md px-3 py-1.5 text-sm transition-colors ${
                  provider === item.id
                    ? "bg-background font-medium text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                }`}
                onClick={() => setProvider(item.id)}
              >
                {item.label}
              </button>
            ))}
          </div>
          <div className="ml-auto flex items-center gap-2">
            {hosts.length > 1 ? (
              <select
                aria-label="Machine"
                className={`${selectClass} max-w-48`}
                value={hostId}
                onChange={(event) => setHostId(event.target.value)}
              >
                {hosts.map((host) => (
                  <option key={host.id} value={host.id} disabled={host.status !== "connected"}>
                    {host.name}{host.status !== "connected" ? " (offline)" : ""}
                  </option>
                ))}
              </select>
            ) : null}
            <Button size="sm" variant="outline" onClick={() => setRefreshKey((value) => value + 1)}>
              Refresh
            </Button>
          </div>
        </div>
        <Input
          className="mt-3"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search prompts, paths, or session IDs…"
          aria-label="Search CLI sessions"
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading ? (
          <div className="space-y-0">
            {Array.from({ length: 5 }, (_, index) => (
              <div key={index} className="flex gap-3 border-b border-border px-5 py-4">
                <div className="size-9 animate-pulse rounded-md bg-muted" />
                <div className="flex-1 space-y-2 py-0.5">
                  <div className="h-4 w-2/3 animate-pulse rounded bg-muted" />
                  <div className="h-3 w-1/3 animate-pulse rounded bg-muted" />
                  <div className="h-3 w-1/2 animate-pulse rounded bg-muted" />
                </div>
              </div>
            ))}
          </div>
        ) : error ? (
          <div className="mx-auto max-w-lg px-6 py-16 text-center">
            <p className="text-sm font-medium text-destructive">Could not load CLI sessions</p>
            <p className="mt-2 text-sm text-muted-foreground">{error}</p>
            <Button className="mt-4" size="sm" variant="outline" onClick={() => void load()}>
              Try again
            </Button>
          </div>
        ) : sessions.length === 0 ? (
          <EmptyState provider={provider} searching={Boolean(query.trim())} />
        ) : (
          <>
            {sessions.map((session) => (
              <SessionRow
                key={`${session.provider}:${session.sourcePath}`}
                session={session}
                onContinue={setSelected}
                onOpen={(threadId) => navigate.toThread(threadId)}
              />
            ))}
            {truncated ? (
              <p className="px-5 py-4 text-center text-xs text-muted-foreground">
                Showing the newest matches. Search to narrow the session list.
              </p>
            ) : null}
          </>
        )}
      </div>

      <ImportDialog
        session={selected}
        hostId={hostId}
        projects={projects}
        preferredProjectId={context.projectId}
        onClose={() => setSelected(null)}
        onImported={(threadId) => {
          setSelected(null);
          navigate.toThread(threadId);
        }}
      />

      {connectedHosts.length === 0 && hosts.length > 0 ? (
        <div className="border-t border-border bg-muted/40 px-4 py-2 text-xs text-muted-foreground">
          Connect a machine to browse its CLI sessions.
        </div>
      ) : null}
    </div>
  );
}

function ImportedSessionBanner() {
  const rpc = useRpc<typeof rpcContract>();
  const view = useComposerView();
  const threadId = view.scope.kind === "thread" ? view.scope.threadId : null;
  const [info, setInfo] = useState<{
    imported: boolean;
    provider: Provider | null;
    sourceId: string | null;
    title: string | null;
  } | null>(null);

  useEffect(() => {
    setInfo(null);
    if (!threadId) return;
    let cancelled = false;
    void rpc
      .call("importedForThread", { threadId })
      .then((result) => {
        if (!cancelled) setInfo(result as typeof info);
      })
      .catch(() => {
        if (!cancelled) setInfo(null);
      });
    return () => {
      cancelled = true;
    };
  }, [rpc, threadId]);

  if (!info?.imported || !info.provider) return null;
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <ProviderMark provider={info.provider} small />
      <span>
        Continued from {providerInfo(info.provider).label} CLI
        {info.sourceId ? <span className="ml-1 font-mono">{info.sourceId.slice(0, 8)}</span> : null}.
        Provider history is loaded; the BB timeline starts here.
      </span>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "session-import",
    title: "CLI Sessions",
    icon: "History",
    path: "sessions",
    component: SessionImportPanel,
  });

  app.composer.customize({
    id: "imported-session-context",
    scopes: ["thread"],
    banners: [
      {
        id: "imported-session-banner",
        chrome: "card",
        component: ImportedSessionBanner,
      },
    ],
  });
});
