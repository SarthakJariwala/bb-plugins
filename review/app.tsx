import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import {
  ThreadChat,
  definePluginApp,
  useBbNavigate,
  useRealtime,
  useRpc,
  useSettings,
  type PluginThreadHeaderActionProps,
  type PluginThreadPanelProps,
} from "@bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const TARGETS = [
  ["uncommitted", "Uncommitted", "Staged, unstaged, and untracked changes"],
  ["baseBranch", "Base branch", "Changes since a branch merge base"],
  ["commit", "Commit", "Changes introduced by one commit"],
  ["pullRequest", "Pull request", "Fetch and check out a GitHub PR with gh"],
  ["folder", "Folders/files", "Review a snapshot rather than a diff"],
  ["custom", "Custom", "Supply your own review focus"],
] as const;

const REVIEW_LOOP_MAX_ITERATIONS = 10;
type TargetKind = (typeof TARGETS)[number][0];
type LoopState = "off" | "reviewing" | "fixing" | "complete" | "stopped";
type ReasoningLevel = "none" | "low" | "medium" | "high" | "xhigh" | "ultracode" | "max" | "ultra";
type ReviewExecution = {
  providerId: string;
  model: string;
  reasoningLevel: ReasoningLevel;
};
type BranchOptions = {
  branches: string[];
  defaultBranch: string | null;
  currentBranch: string | null;
  branchesTruncated: boolean;
};
type ExecutionOptions = {
  providers: Array<{ id: string; displayName: string; logoUrl: string | null }>;
  models: Array<{
    model: string;
    displayName: string;
    description: string;
    supportedReasoningEfforts: Array<{ reasoningEffort: ReasoningLevel; description: string }>;
    defaultReasoningEffort: ReasoningLevel;
  }>;
  providerId: string;
  model: string;
  reasoningLevel: ReasoningLevel;
  modelLoadError: string | null;
};
type Session = {
  runId: string;
  parentThreadId: string;
  reviewThreadId: string;
  isolated: boolean;
  targetLabel: string;
  createdAt: number;
  loopFixing: boolean;
  loopState: LoopState;
  iteration: number;
  statusMessage: string | null;
  execution?: ReviewExecution;
};

type ReviewTarget =
  | { type: "uncommitted" }
  | { type: "baseBranch"; branch: string }
  | { type: "commit"; sha: string }
  | { type: "pullRequest"; reference: string }
  | { type: "folder"; paths: string[] }
  | { type: "custom"; instructions: string };

function makeTarget(kind: TargetKind, detail: string): ReviewTarget {
  const value = detail.trim();
  switch (kind) {
    case "uncommitted":
      return { type: "uncommitted" };
    case "baseBranch":
      if (!value) throw new Error("Enter a base branch.");
      return { type: "baseBranch", branch: value };
    case "commit":
      if (!value) throw new Error("Enter a commit SHA.");
      return { type: "commit", sha: value };
    case "pullRequest":
      if (!value) throw new Error("Enter a PR number or URL.");
      return { type: "pullRequest", reference: value };
    case "folder": {
      const paths = value.split(/\s+/).filter(Boolean);
      if (paths.length === 0) throw new Error("Enter at least one path.");
      return { type: "folder", paths };
    }
    case "custom":
      if (!value) throw new Error("Enter review instructions.");
      return { type: "custom", instructions: value };
  }
}

function reasoningLabel(level: ReasoningLevel): string {
  const labels: Record<ReasoningLevel, string> = {
    none: "None",
    low: "Low",
    medium: "Medium",
    high: "High",
    xhigh: "Extra high",
    ultracode: "Ultra code",
    max: "Max",
    ultra: "Ultra",
  };
  return labels[level];
}

function detailCopy(kind: TargetKind): { placeholder: string; multiline: boolean } | null {
  switch (kind) {
    case "uncommitted":
      return null;
    case "baseBranch":
      return null;
    case "commit":
      return { placeholder: "abc123", multiline: false };
    case "pullRequest":
      return { placeholder: "123 or https://github.com/org/repo/pull/123", multiline: false };
    case "folder":
      return { placeholder: "src tests docs", multiline: false };
    case "custom":
      return { placeholder: "Focus on authentication and authorization boundaries…", multiline: true };
  }
}

function ReviewPanel({ threadId }: PluginThreadPanelProps) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const { values } = useSettings();
  const [session, setSession] = useState<Session | null>(null);
  const [kind, setKind] = useState<TargetKind>("uncommitted");
  const [detail, setDetail] = useState("");
  const [mode, setMode] = useState<"isolated" | "current">("isolated");
  const [loopFixing, setLoopFixing] = useState(false);
  const [branchOptions, setBranchOptions] = useState<BranchOptions | null>(null);
  const [branchOptionsLoading, setBranchOptionsLoading] = useState(true);
  const [branchOptionsError, setBranchOptionsError] = useState<string | null>(null);
  const [executionOptions, setExecutionOptions] = useState<ExecutionOptions | null>(null);
  const [providerId, setProviderId] = useState("");
  const [model, setModel] = useState("");
  const [reasoningLevel, setReasoningLevel] = useState<ReasoningLevel>("high");
  const [loading, setLoading] = useState(true);
  const [optionsLoading, setOptionsLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const detailConfig = useMemo(() => detailCopy(kind), [kind]);

  const refreshSession = useCallback(async () => {
    const result = await rpc.call("getSession", { parentThreadId: threadId });
    setSession(result.session);
  }, [rpc, threadId]);

  useEffect(() => {
    if (typeof values?.isolatedByDefault === "boolean") {
      setMode(values.isolatedByDefault ? "isolated" : "current");
    }
    if (typeof values?.loopFixingEnabled === "boolean") {
      setLoopFixing(values.loopFixingEnabled);
    }
  }, [values?.isolatedByDefault, values?.loopFixingEnabled]);

  useEffect(() => {
    if (loopFixing) setMode("isolated");
  }, [loopFixing]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void refreshSession()
      .catch((error: unknown) => {
        if (!cancelled) setMessage(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [refreshSession]);

  useEffect(() => {
    let cancelled = false;
    setBranchOptionsLoading(true);
    setBranchOptionsError(null);
    void rpc
      .call("getBranchOptions", { parentThreadId: threadId })
      .then((result) => {
        if (!cancelled) setBranchOptions(result);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setBranchOptions(null);
          setBranchOptionsError(error instanceof Error ? error.message : String(error));
        }
      })
      .finally(() => {
        if (!cancelled) setBranchOptionsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [rpc, threadId]);

  useEffect(() => {
    if (kind !== "baseBranch" || detail || !branchOptions) return;
    setDetail(branchOptions.defaultBranch ?? branchOptions.branches[0] ?? "");
  }, [branchOptions, detail, kind]);

  useEffect(() => {
    let cancelled = false;
    setOptionsLoading(true);
    void rpc
      .call("getExecutionOptions", { parentThreadId: threadId })
      .then((result) => {
        if (cancelled) return;
        setExecutionOptions(result);
        setProviderId(result.providerId);
        setModel(result.model);
        setReasoningLevel(result.reasoningLevel);
      })
      .catch((error: unknown) => {
        if (!cancelled) setMessage(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (!cancelled) setOptionsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [rpc, threadId]);

  useRealtime("session", (payload) => {
    if (
      payload &&
      typeof payload === "object" &&
      "parentThreadId" in payload &&
      payload.parentThreadId === threadId
    ) {
      void refreshSession();
    }
  });

  async function changeProvider(nextProviderId: string) {
    if (!nextProviderId) return;
    setProviderId(nextProviderId);
    setMessage(null);
    setOptionsLoading(true);
    try {
      const result = await rpc.call("getExecutionOptions", {
        parentThreadId: threadId,
        providerId: nextProviderId,
      });
      setExecutionOptions(result);
      setProviderId(result.providerId);
      setModel(result.model);
      setReasoningLevel(result.reasoningLevel);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setOptionsLoading(false);
    }
  }

  function changeModel(nextModel: string) {
    if (!nextModel) return;
    setModel(nextModel);
    const selected = executionOptions?.models.find((candidate) => candidate.model === nextModel);
    if (!selected) return;
    const supported = selected.supportedReasoningEfforts.map((effort) => effort.reasoningEffort);
    if (!supported.includes(reasoningLevel)) setReasoningLevel(selected.defaultReasoningEffort);
  }

  async function start(event: FormEvent) {
    event.preventDefault();
    setMessage(null);
    setWorking(true);
    try {
      const target = makeTarget(kind, detail);
      const isolated = loopFixing || mode === "isolated";
      if (isolated && (!providerId || !model)) throw new Error("Choose a reviewer harness and model.");
      const result = await rpc.call("startReview", {
        parentThreadId: threadId,
        mode,
        loopFixing,
        target,
        ...(isolated
          ? { execution: { providerId, model, reasoningLevel } }
          : {}),
      });
      setSession(result.session);
      setMessage(
        result.session.loopFixing
          ? "Loop fixing started with review pass 1."
          : result.session.isolated
            ? "Review started in a child thread."
            : "Review prompt sent to this thread.",
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setWorking(false);
    }
  }

  async function applyFindings() {
    setMessage(null);
    setWorking(true);
    try {
      await rpc.call("applyFindings", { parentThreadId: threadId });
      setMessage("Queued the review findings in the parent thread.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setWorking(false);
    }
  }

  async function stopLoop() {
    setMessage(null);
    setWorking(true);
    try {
      await rpc.call("stopLoop", { parentThreadId: threadId });
      await refreshSession();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setWorking(false);
    }
  }

  async function startAnother() {
    setWorking(true);
    try {
      await rpc.call("clearSession", { parentThreadId: threadId });
      setSession(null);
      setMessage(null);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setWorking(false);
    }
  }

  if (loading) {
    return <div className="p-4 text-sm text-muted-foreground">Loading review…</div>;
  }

  if (session?.isolated && session.reviewThreadId !== threadId) {
    const loopActive = session.loopFixing && ["reviewing", "fixing"].includes(session.loopState);
    return (
      <div className="flex h-full min-h-0 flex-col bg-background">
        <div className="flex flex-wrap items-center gap-2 border-b border-border p-3">
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium">{session.targetLabel}</div>
            <div className="text-xs text-muted-foreground">
              {session.loopFixing
                ? `Loop ${session.loopState} · pass ${session.iteration}/${REVIEW_LOOP_MAX_ITERATIONS}`
                : "Separate review thread"}
              {session.execution
                ? ` · ${session.execution.model} · ${reasoningLabel(session.execution.reasoningLevel)}`
                : ""}
            </div>
          </div>
          <Button size="sm" variant="outline" onClick={() => navigate.toThread(session.reviewThreadId)}>
            Open
          </Button>
          {loopActive ? (
            <Button size="sm" variant="outline" onClick={() => void stopLoop()} disabled={working}>
              Stop loop
            </Button>
          ) : !session.loopFixing ? (
            <Button size="sm" onClick={() => void applyFindings()} disabled={working}>
              Apply findings
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" onClick={() => void startAnother()} disabled={working || loopActive}>
            New review
          </Button>
        </div>
        {session.statusMessage || message ? (
          <div className="border-b border-border px-3 py-2 text-xs text-muted-foreground">
            {message ?? session.statusMessage}
          </div>
        ) : null}
        <div className="min-h-0 flex-1">
          <ThreadChat threadId={session.reviewThreadId} variant="compact" layout="contained" className="h-full" />
        </div>
      </div>
    );
  }

  if (session && !session.isolated) {
    return (
      <div className="space-y-4 p-4">
        <div>
          <h2 className="text-base font-semibold">Review running in this thread</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            The review prompt was added to the current conversation. Continue in the main timeline.
          </p>
        </div>
        {message ? <p className="text-sm text-muted-foreground">{message}</p> : null}
        <Button variant="outline" onClick={() => void startAnother()} disabled={working}>
          Start another review
        </Button>
      </div>
    );
  }

  return (
    <form className="h-full min-h-0 space-y-5 overflow-y-auto p-4" onSubmit={(event) => void start(event)}>
      <div>
        <h2 className="text-base font-semibold">Start code review</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Uses the current project and environment. Choose the harness, model, and reasoning for an isolated reviewer.
        </p>
      </div>

      <fieldset className="space-y-2">
        <legend className="mb-2 text-sm font-medium">Review target</legend>
        {TARGETS.map(([value, label, description]) => (
          <label key={value} className="flex cursor-pointer gap-3 rounded-md border border-border p-3 hover:bg-state-hover">
            <input
              className="mt-1 accent-foreground"
              type="radio"
              name="target"
              value={value}
              checked={kind === value}
              onChange={() => {
                setKind(value);
                setDetail("");
                if (value === "commit") setLoopFixing(false);
              }}
            />
            <span>
              <span className="block text-sm font-medium">{label}</span>
              <span className="block text-xs text-muted-foreground">{description}</span>
            </span>
          </label>
        ))}
      </fieldset>

      {kind === "baseBranch" ? (
        <label className="block space-y-2 text-sm font-medium">
          Base branch
          <Select
            value={detail}
            onValueChange={setDetail}
            disabled={branchOptionsLoading || !branchOptions?.branches.length}
          >
            <SelectTrigger aria-label="Base branch">
              <SelectValue
                placeholder={branchOptionsLoading ? "Loading branches…" : "Choose a branch"}
              />
            </SelectTrigger>
            <SelectContent>
              {branchOptions?.branches.map((branch) => (
                <SelectItem key={branch} value={branch}>
                  {branch}
                  {branch === branchOptions.defaultBranch ? " (default)" : ""}
                  {branch === branchOptions.currentBranch ? " (current)" : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {branchOptionsError ? (
            <span className="block text-xs font-normal text-destructive">{branchOptionsError}</span>
          ) : branchOptions && branchOptions.branches.length === 0 ? (
            <span className="block text-xs font-normal text-muted-foreground">No branches found.</span>
          ) : branchOptions?.branchesTruncated ? (
            <span className="block text-xs font-normal text-muted-foreground">
              Showing the first 500 available branches.
            </span>
          ) : null}
        </label>
      ) : detailConfig ? (
        <label className="block space-y-2 text-sm font-medium">
          {kind === "custom" ? "Instructions" : kind === "folder" ? "Paths" : "Value"}
          {detailConfig.multiline ? (
            <textarea
              className="min-h-28 w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              value={detail}
              placeholder={detailConfig.placeholder}
              onChange={(event) => setDetail(event.target.value)}
            />
          ) : (
            <Input value={detail} placeholder={detailConfig.placeholder} onChange={(event) => setDetail(event.target.value)} />
          )}
        </label>
      ) : null}

      <label className="flex cursor-pointer items-start gap-3 rounded-md border border-border p-3 text-sm">
        <input
          className="mt-1"
          type="checkbox"
          checked={loopFixing}
          disabled={kind === "commit"}
          onChange={(event) => setLoopFixing(event.target.checked)}
        />
        <span>
          <span className="block font-medium">Loop fixing</span>
          <span className="block text-xs text-muted-foreground">
            Alternate isolated review and parent-thread fix passes until no P0-P2 findings remain, capped at 10 reviews.
            {kind === "commit" ? " Not available for commit reviews." : ""}
          </span>
        </span>
      </label>

      <fieldset className="space-y-2" disabled={loopFixing}>
        <legend className="mb-2 text-sm font-medium">Run review in</legend>
        <label className="flex cursor-pointer items-start gap-3 text-sm">
          <input type="radio" name="mode" checked={mode === "isolated"} onChange={() => setMode("isolated")} />
          <span>
            <span className="block font-medium">Separate child thread</span>
            <span className="block text-xs text-muted-foreground">Recommended. Required for loop fixing.</span>
          </span>
        </label>
        <label className="flex cursor-pointer items-start gap-3 text-sm">
          <input type="radio" name="mode" checked={mode === "current"} onChange={() => setMode("current")} />
          <span>
            <span className="block font-medium">Current thread</span>
            <span className="block text-xs text-muted-foreground">Adds the review prompt to the current conversation.</span>
          </span>
        </label>
      </fieldset>

      <fieldset className="space-y-3" disabled={mode === "current" || optionsLoading}>
        <legend className="text-sm font-medium">Reviewer</legend>
        <p className="text-xs text-muted-foreground">
          {mode === "current"
            ? "Current-thread reviews keep that thread's existing harness and execution settings."
            : "These settings are reused for every pass in a review/fix loop."}
        </p>
        <label className="block space-y-1.5 text-xs font-medium">
          Harness
          <Select
            value={providerId}
            onValueChange={(value) => void changeProvider(value)}
            disabled={mode === "current" || optionsLoading || !executionOptions}
          >
            <SelectTrigger aria-label="Reviewer harness">
              <SelectValue placeholder={optionsLoading ? "Loading harnesses…" : "Choose harness"} />
            </SelectTrigger>
            <SelectContent>
              {executionOptions?.providers.map((provider) => (
                <SelectItem key={provider.id} value={provider.id}>
                  {provider.displayName}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
        <label className="block space-y-1.5 text-xs font-medium">
          Model
          <Select
            value={model}
            onValueChange={changeModel}
            disabled={mode === "current" || optionsLoading || !executionOptions}
          >
            <SelectTrigger aria-label="Reviewer model">
              <SelectValue placeholder={optionsLoading ? "Loading models…" : "Choose model"} />
            </SelectTrigger>
            <SelectContent>
              {executionOptions?.models.map((option) => (
                <SelectItem key={option.model} value={option.model}>
                  {option.displayName}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
        <label className="block space-y-1.5 text-xs font-medium">
          Reasoning
          <Select
            value={reasoningLevel}
            onValueChange={(value) => {
              if (value) setReasoningLevel(value as ReasoningLevel);
            }}
            disabled={mode === "current" || optionsLoading || !executionOptions}
          >
            <SelectTrigger aria-label="Reviewer reasoning level">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {executionOptions?.models
                .find((option) => option.model === model)
                ?.supportedReasoningEfforts.map((effort) => (
                  <SelectItem key={effort.reasoningEffort} value={effort.reasoningEffort}>
                    {reasoningLabel(effort.reasoningEffort)}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        </label>
        {executionOptions?.modelLoadError ? (
          <p className="text-xs text-destructive">Model discovery: {executionOptions.modelLoadError}</p>
        ) : null}
      </fieldset>

      {message ? <p className="text-sm text-destructive">{message}</p> : null}
      <Button
        type="submit"
        disabled={
          working ||
          (mode === "isolated" && optionsLoading) ||
          (kind === "baseBranch" && (branchOptionsLoading || !detail))
        }
        className="w-full"
      >
        {working ? "Starting…" : loopFixing ? "Start review/fix loop" : "Start review"}
      </Button>
    </form>
  );
}

function ReviewHeaderButton({ isCompactViewport }: PluginThreadHeaderActionProps) {
  const navigate = useBbNavigate();
  return (
    <Button
      variant="ghost"
      size={isCompactViewport ? "icon" : "sm"}
      className="h-7"
      aria-label="Open code review"
      onClick={() => navigate.openThreadPanel({ actionId: "review", title: "Code review" })}
    >
      {isCompactViewport ? "R" : "Review"}
    </Button>
  );
}

export default definePluginApp((app) => {
  app.slots.threadPanelAction({
    id: "review",
    title: "Code review",
    icon: "Search",
    layout: "flush",
    component: ReviewPanel,
  });

  app.slots.experimental_threadHeaderAction({
    id: "review-header",
    title: "Code review",
    component: ReviewHeaderButton,
  });
});
