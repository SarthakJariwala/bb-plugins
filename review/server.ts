import { randomUUID } from "node:crypto";
import { defineRpcContract, type BbPluginApi } from "@bb/plugin-sdk";
import { z } from "zod";
import {
  REVIEW_FIX_FINDINGS_PROMPT,
  buildReviewPrompt,
  reviewTargetLabel,
  type ReviewTarget,
} from "./prompts";
import { hasBlockingReviewFindings } from "./review-result";
import {
  assertCanStartReview,
  buildIsolatedReviewPrompt,
  reviewAgentConfiguration,
} from "./review-agent";

const REVIEW_LOOP_MAX_ITERATIONS = 10;
const REVIEW_LOOP_POLL_MS = 1_000;

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

const reviewExecutionSchema = z
  .object({
    providerId: z.string().min(1),
    model: z.string().min(1),
    reasoningLevel: reasoningLevelSchema,
  })
  .strict();

const reviewTargetSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("uncommitted") }).strict(),
  z.object({ type: z.literal("baseBranch"), branch: z.string().min(1) }).strict(),
  z.object({ type: z.literal("commit"), sha: z.string().min(1), title: z.string().optional() }).strict(),
  z.object({ type: z.literal("pullRequest"), reference: z.string().min(1) }).strict(),
  z.object({ type: z.literal("folder"), paths: z.array(z.string().min(1)).min(1) }).strict(),
  z.object({ type: z.literal("custom"), instructions: z.string().min(1) }).strict(),
]);

const reviewSessionSchema = z.object({
  runId: z.string(),
  parentThreadId: z.string(),
  reviewThreadId: z.string(),
  isolated: z.boolean(),
  target: reviewTargetSchema,
  targetLabel: z.string(),
  createdAt: z.number().int(),
  loopFixing: z.boolean(),
  loopState: z.enum(["off", "reviewing", "fixing", "complete", "stopped"]),
  iteration: z.number().int().min(1),
  statusMessage: z.string().nullable(),
  parentOutputBeforeFix: z.string().nullable(),
  fixObservedActive: z.boolean(),
  execution: reviewExecutionSchema.optional(),
});

type ReviewSession = z.infer<typeof reviewSessionSchema>;
type ReviewExecution = z.infer<typeof reviewExecutionSchema>;
type ReviewMode = "isolated" | "current";

const branchOptionsOutputSchema = z.object({
  branches: z.array(z.string()),
  defaultBranch: z.string().nullable(),
  currentBranch: z.string().nullable(),
  branchesTruncated: z.boolean(),
});

const executionOptionsOutputSchema = z.object({
  providers: z.array(
    z.object({
      id: z.string(),
      displayName: z.string(),
      logoUrl: z.string().nullable(),
    }),
  ),
  models: z.array(
    z.object({
      model: z.string(),
      displayName: z.string(),
      description: z.string(),
      supportedReasoningEfforts: z.array(
        z.object({
          reasoningEffort: reasoningLevelSchema,
          description: z.string(),
        }),
      ),
      defaultReasoningEffort: reasoningLevelSchema,
    }),
  ),
  providerId: z.string(),
  model: z.string(),
  reasoningLevel: reasoningLevelSchema,
  modelLoadError: z.string().nullable(),
});

export const rpcContract = defineRpcContract({
  getSession: {
    input: z.object({ parentThreadId: z.string().min(1) }).strict(),
    output: z.object({ session: reviewSessionSchema.nullable() }),
  },
  getExecutionOptions: {
    input: z
      .object({
        parentThreadId: z.string().min(1),
        providerId: z.string().min(1).optional(),
      })
      .strict(),
    output: executionOptionsOutputSchema,
  },
  getBranchOptions: {
    input: z.object({ parentThreadId: z.string().min(1) }).strict(),
    output: branchOptionsOutputSchema,
  },
  startReview: {
    input: z
      .object({
        parentThreadId: z.string().min(1),
        mode: z.enum(["isolated", "current"]),
        loopFixing: z.boolean(),
        target: reviewTargetSchema,
        execution: reviewExecutionSchema.optional(),
      })
      .strict(),
    output: z.object({ session: reviewSessionSchema }),
  },
  applyFindings: {
    input: z.object({ parentThreadId: z.string().min(1) }).strict(),
    output: z.object({ queued: z.literal(true) }),
  },
  stopLoop: {
    input: z.object({ parentThreadId: z.string().min(1) }).strict(),
    output: z.object({ stopped: z.literal(true) }),
  },
  clearSession: {
    input: z.object({ parentThreadId: z.string().min(1) }).strict(),
    output: z.object({ cleared: z.literal(true) }),
  },
});

const sessionKey = (parentThreadId: string) => `session:${parentThreadId}`;

function parseCliTarget(argv: string[]): ReviewTarget {
  const [kind = "uncommitted", ...rest] = argv;
  const value = rest.join(" ").trim();

  switch (kind) {
    case "uncommitted":
      return { type: "uncommitted" };
    case "branch":
      if (!value) throw new Error("branch requires a base branch name");
      return { type: "baseBranch", branch: value };
    case "commit": {
      const [sha, ...titleParts] = rest;
      if (!sha) throw new Error("commit requires a SHA");
      const title = titleParts.join(" ").trim() || undefined;
      return { type: "commit", sha, ...(title ? { title } : {}) };
    }
    case "pr":
      if (!value) throw new Error("pr requires a PR number or URL");
      return { type: "pullRequest", reference: value };
    case "folder": {
      const paths = rest.filter(Boolean);
      if (paths.length === 0) throw new Error("folder requires at least one path");
      return { type: "folder", paths };
    }
    case "custom":
      if (!value) throw new Error("custom requires review instructions");
      return { type: "custom", instructions: value };
    default:
      throw new Error(`unknown review target: ${kind}`);
  }
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

export default async function plugin(bb: BbPluginApi) {
  bb.log.info("loaded");

  const settings = bb.settings.define({
    isolatedByDefault: {
      type: "boolean",
      label: "Start reviews in a separate child thread",
      default: true,
    },
    loopFixingEnabled: {
      type: "boolean",
      label: "Enable review/fix loop by default",
      default: false,
    },
    guidelinesFile: {
      type: "string",
      label: "Project review guidelines filename",
      default: "REVIEW_GUIDELINES.md",
    },
  });

  async function getSession(parentThreadId: string): Promise<ReviewSession | null> {
    const value = await bb.storage.kv.get<ReviewSession>(sessionKey(parentThreadId));
    const parsed = reviewSessionSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
  }

  async function persistSession(session: ReviewSession): Promise<void> {
    await bb.storage.kv.set(sessionKey(session.parentThreadId), session);
    bb.realtime.publish("session", {
      parentThreadId: session.parentThreadId,
      runId: session.runId,
      loopState: session.loopState,
      iteration: session.iteration,
    });
  }

  async function persistIfCurrent(
    expected: ReviewSession,
    next: ReviewSession,
  ): Promise<boolean> {
    const current = await getSession(expected.parentThreadId);
    if (
      !current ||
      current.runId !== expected.runId ||
      current.loopState !== expected.loopState ||
      current.iteration !== expected.iteration
    ) {
      return false;
    }
    await persistSession(next);
    return true;
  }

  async function loadProjectReviewGuidelines(
    environmentId: string | null,
    filename: string,
  ): Promise<string | null> {
    if (!environmentId || !filename.trim() || /[/\\]/.test(filename)) return null;

    try {
      const environment = await bb.sdk.environments.get({ environmentId });
      if (!environment.path) return null;
      const separator = environment.path.endsWith("/") ? "" : "/";
      const file = await bb.sdk.files.read({
        hostId: environment.hostId,
        rootPath: environment.path,
        path: `${environment.path}${separator}${filename}`,
      });
      if (file.contentEncoding !== "utf8") return null;
      const trimmed = file.content.trim();
      return trimmed || null;
    } catch {
      return null;
    }
  }

  async function getBranchOptions(
    parentThreadId: string,
  ): Promise<z.infer<typeof branchOptionsOutputSchema>> {
    const parent = await bb.sdk.threads.get({ threadId: parentThreadId });
    if (!parent.environmentId) {
      throw new Error("This thread has no environment to load branches from.");
    }

    const environment = await bb.sdk.environments.get({ environmentId: parent.environmentId });
    if (!environment.isGitRepo) {
      throw new Error("This thread's environment is not a Git repository.");
    }

    const result = await bb.sdk.projects.branches({
      projectId: parent.projectId,
      hostId: environment.hostId,
      limit: "500",
    });
    const preferredCandidates = [
      environment.mergeBaseBranch,
      environment.baseBranch,
      result.defaultWorktreeBaseBranch,
      result.defaultBranch,
      result.originDefaultBranch,
    ].filter((branch): branch is string => Boolean(branch?.trim()));
    const defaultBranch =
      preferredCandidates.find((branch) => branch !== environment.branchName) ??
      preferredCandidates[0] ??
      null;
    const branches = Array.from(
      new Set(
        [defaultBranch, ...result.branches, ...result.remoteBranches]
          .filter((branch): branch is string => Boolean(branch?.trim()))
          .map((branch) => branch.trim()),
      ),
    );

    return {
      branches,
      defaultBranch,
      currentBranch: environment.branchName,
      branchesTruncated: result.branchesTruncated || result.remoteBranchesTruncated,
    };
  }

  async function getExecutionOptions(
    parentThreadId: string,
    requestedProviderId?: string,
  ): Promise<z.infer<typeof executionOptionsOutputSchema>> {
    const parent = await bb.sdk.threads.get({ threadId: parentThreadId });
    const defaults = await bb.sdk.threads.defaultExecutionOptions({ threadId: parentThreadId });
    const routing = parent.environmentId ? { environmentId: parent.environmentId } : {};
    const result = await bb.sdk.providers.models({
      ...routing,
      providerId: requestedProviderId ?? parent.providerId,
    });
    const providers = result.providers.filter((provider) => provider.available);
    const providerId = providers.some((provider) => provider.id === requestedProviderId)
      ? requestedProviderId!
      : providers.some((provider) => provider.id === parent.providerId)
        ? parent.providerId
        : providers[0]?.id;
    if (!providerId) throw new Error("No agent harness is available in this environment.");

    const selectedResult =
      providerId === (requestedProviderId ?? parent.providerId)
        ? result
        : await bb.sdk.providers.models({ ...routing, providerId });
    const models = [...selectedResult.models];
    for (const model of selectedResult.selectedOnlyModels) {
      if (!models.some((candidate) => candidate.model === model.model)) models.push(model);
    }
    if (models.length === 0) {
      throw new Error(`No models are available for ${providers.find((provider) => provider.id === providerId)?.displayName ?? providerId}.`);
    }

    const preferredModel =
      providerId === parent.providerId && defaults?.model
        ? models.find((model) => model.model === defaults.model)
        : undefined;
    const selectedModel = preferredModel ?? models.find((model) => model.isDefault) ?? models[0]!;
    const supportedReasoning = selectedModel.supportedReasoningEfforts.map(
      (effort) => effort.reasoningEffort,
    );
    const reasoningLevel =
      providerId === parent.providerId && defaults?.reasoningLevel && supportedReasoning.includes(defaults.reasoningLevel)
        ? defaults.reasoningLevel
        : selectedModel.defaultReasoningEffort;

    return {
      providers: providers.map(({ id, displayName, logoUrl }) => ({ id, displayName, logoUrl })),
      models: models.map(
        ({ model, displayName, description, supportedReasoningEfforts, defaultReasoningEffort }) => ({
          model,
          displayName,
          description,
          supportedReasoningEfforts,
          defaultReasoningEffort,
        }),
      ),
      providerId,
      model: selectedModel.model,
      reasoningLevel,
      modelLoadError: selectedResult.modelLoadError
        ? `${selectedResult.modelLoadError.code.replaceAll("_", " ")}`
        : null,
    };
  }

  async function spawnReviewThread(
    parent: Awaited<ReturnType<typeof bb.sdk.threads.get>>,
    target: ReviewTarget,
    includeLocalChanges: boolean,
    execution?: ReviewExecution,
  ): Promise<string> {
    const { guidelinesFile } = await settings.get();
    const projectGuidelines = await loadProjectReviewGuidelines(parent.environmentId, guidelinesFile);
    const prompt = buildIsolatedReviewPrompt(
      buildReviewPrompt(target, { includeLocalChanges, projectGuidelines }),
    );
    const targetLabel = reviewTargetLabel(target);
    const reviewThread = await bb.sdk.threads.spawn({
      projectId: parent.projectId,
      providerId: execution?.providerId ?? parent.providerId,
      ...(execution
        ? {
            model: execution.model,
            reasoningLevel: execution.reasoningLevel,
            executionInputSources: {
              providerId: "explicit" as const,
              model: "explicit" as const,
              reasoningLevel: "explicit" as const,
            },
          }
        : {}),
      environment: parent.environmentId
        ? { type: "reuse", environmentId: parent.environmentId }
        : { type: "project-default" },
      ...(parent.canSpawnChild ? { parentThreadId: parent.id } : {}),
      title: `Review: ${targetLabel}`,
      visibility: "visible",
      prompt,
    });
    return reviewThread.id;
  }

  async function startReview(
    parentThreadId: string,
    target: ReviewTarget,
    mode: ReviewMode,
    loopFixing: boolean,
    execution?: ReviewExecution,
  ): Promise<ReviewSession> {
    if (loopFixing && target.type === "commit") {
      throw new Error("Loop mode does not work with commit review.");
    }

    const parent = await bb.sdk.threads.get({ threadId: parentThreadId });
    assertCanStartReview(bb.pluginId, parent.originPluginId);
    const isolated = loopFixing || mode === "isolated";
    let resolvedExecution: ReviewExecution | undefined;
    if (isolated && execution) {
      const available = await getExecutionOptions(parentThreadId, execution.providerId);
      const selectedModel = available.models.find((model) => model.model === execution.model);
      if (available.providerId !== execution.providerId || !selectedModel) {
        throw new Error("The selected reviewer harness or model is no longer available.");
      }
      if (
        !selectedModel.supportedReasoningEfforts.some(
          (effort) => effort.reasoningEffort === execution.reasoningLevel,
        )
      ) {
        throw new Error("The selected model does not support that reasoning level.");
      }
      resolvedExecution = execution;
    }

    let reviewThreadId = parentThreadId;
    if (isolated) {
      reviewThreadId = await spawnReviewThread(parent, target, loopFixing, resolvedExecution);
    } else {
      const { guidelinesFile } = await settings.get();
      const projectGuidelines = await loadProjectReviewGuidelines(parent.environmentId, guidelinesFile);
      await bb.sdk.threads.send({
        threadId: parentThreadId,
        mode: "auto",
        input: [
          {
            type: "text",
            text: buildReviewPrompt(target, { projectGuidelines }),
            mentions: [],
          },
        ],
      });
    }

    const session: ReviewSession = {
      runId: randomUUID(),
      parentThreadId,
      reviewThreadId,
      isolated,
      target,
      targetLabel: reviewTargetLabel(target),
      createdAt: Date.now(),
      loopFixing,
      loopState: loopFixing ? "reviewing" : "off",
      iteration: 1,
      statusMessage: loopFixing ? "Review pass 1 is running." : null,
      parentOutputBeforeFix: null,
      fixObservedActive: false,
      ...(resolvedExecution ? { execution: resolvedExecution } : {}),
    };
    await persistSession(session);
    return session;
  }

  async function applyFindings(parentThreadId: string): Promise<void> {
    const session = await getSession(parentThreadId);
    if (!session) throw new Error("No review session is linked to this thread.");
    if (!session.isolated || session.reviewThreadId === parentThreadId) {
      throw new Error("The review already ran in the current thread.");
    }
    if (session.loopFixing && ["reviewing", "fixing"].includes(session.loopState)) {
      throw new Error("Loop fixing is still running.");
    }

    const review = await bb.sdk.threads.get({ threadId: session.reviewThreadId });
    if (review.status !== "idle") {
      throw new Error(`Review thread is ${review.status}; wait until it is idle.`);
    }

    const { output } = await bb.sdk.threads.output({ threadId: session.reviewThreadId });
    if (!output?.trim()) throw new Error("The review thread has no assistant output yet.");

    await bb.sdk.threads.send({
      threadId: parentThreadId,
      mode: "queue-if-active",
      input: [
        {
          type: "text",
          mentions: [],
          text: `${REVIEW_FIX_FINDINGS_PROMPT}\n\n---\n\n## Review output\n\n${output}`,
        },
      ],
    });
  }

  async function stopLoop(parentThreadId: string, message = "Loop fixing stopped by the user."): Promise<void> {
    const session = await getSession(parentThreadId);
    if (!session) throw new Error("No review session is linked to this thread.");
    if (!session.loopFixing || !["reviewing", "fixing"].includes(session.loopState)) return;
    await persistSession({ ...session, loopState: "stopped", statusMessage: message });
  }

  async function processLoopSession(session: ReviewSession): Promise<void> {
    if (!session.loopFixing) return;

    if (session.loopState === "reviewing") {
      const review = await bb.sdk.threads.get({ threadId: session.reviewThreadId });
      if (["active", "starting", "stopping"].includes(review.status)) return;
      if (review.status === "error") {
        await persistIfCurrent(session, {
          ...session,
          loopState: "stopped",
          statusMessage: `Loop fixing stopped: review pass ${session.iteration} failed.`,
        });
        return;
      }

      const { output } = await bb.sdk.threads.output({ threadId: session.reviewThreadId });
      if (!output?.trim()) return;

      if (!hasBlockingReviewFindings(output)) {
        await persistIfCurrent(session, {
          ...session,
          loopState: "complete",
          statusMessage: `Loop fixing complete after ${session.iteration} review pass${session.iteration === 1 ? "" : "es"}: no blocking findings remain.`,
        });
        return;
      }

      const parentBeforeFix = await bb.sdk.threads.output({ threadId: session.parentThreadId });
      await bb.sdk.threads.send({
        threadId: session.parentThreadId,
        mode: "queue-if-active",
        input: [
          {
            type: "text",
            mentions: [],
            text: `${REVIEW_FIX_FINDINGS_PROMPT}\n\n---\n\n## Review output\n\n${output}`,
          },
        ],
      });
      await persistIfCurrent(session, {
        ...session,
        loopState: "fixing",
        statusMessage: `Review pass ${session.iteration} found blocking findings; fix pass is running.`,
        parentOutputBeforeFix: parentBeforeFix.output,
        fixObservedActive: false,
      });
      return;
    }

    if (session.loopState === "fixing") {
      const parent = await bb.sdk.threads.get({ threadId: session.parentThreadId });
      if (["active", "starting", "stopping"].includes(parent.status)) {
        if (!session.fixObservedActive) {
          await persistIfCurrent(session, { ...session, fixObservedActive: true });
        }
        return;
      }
      if (parent.status === "error") {
        await persistIfCurrent(session, {
          ...session,
          loopState: "stopped",
          statusMessage: `Loop fixing stopped: fix pass ${session.iteration} failed.`,
        });
        return;
      }

      const parentOutput = await bb.sdk.threads.output({ threadId: session.parentThreadId });
      if (!parentOutput.output || parentOutput.output === session.parentOutputBeforeFix) return;

      if (session.iteration >= REVIEW_LOOP_MAX_ITERATIONS) {
        await persistIfCurrent(session, {
          ...session,
          loopState: "stopped",
          statusMessage: `Loop fixing stopped after ${REVIEW_LOOP_MAX_ITERATIONS} passes (safety limit reached).`,
        });
        return;
      }

      const reviewThreadId = await spawnReviewThread(parent, session.target, true, session.execution);
      await persistIfCurrent(session, {
        ...session,
        reviewThreadId,
        loopState: "reviewing",
        iteration: session.iteration + 1,
        statusMessage: `Review pass ${session.iteration + 1} is running.`,
        parentOutputBeforeFix: null,
        fixObservedActive: false,
      });
    }
  }

  bb.agents.configure((context) =>
    reviewAgentConfiguration(bb.pluginId, context.origin.pluginId),
  );

  bb.rpc.register(rpcContract, {
    getSession: async ({ parentThreadId }) => ({ session: await getSession(parentThreadId) }),
    getExecutionOptions: async ({ parentThreadId, providerId }) =>
      getExecutionOptions(parentThreadId, providerId),
    getBranchOptions: async ({ parentThreadId }) => getBranchOptions(parentThreadId),
    startReview: async ({ parentThreadId, target, mode, loopFixing, execution }) => ({
      session: await startReview(parentThreadId, target, mode, loopFixing, execution),
    }),
    applyFindings: async ({ parentThreadId }) => {
      await applyFindings(parentThreadId);
      return { queued: true as const };
    },
    stopLoop: async ({ parentThreadId }) => {
      await stopLoop(parentThreadId);
      return { stopped: true as const };
    },
    clearSession: async ({ parentThreadId }) => {
      await bb.storage.kv.delete(sessionKey(parentThreadId));
      bb.realtime.publish("session", { parentThreadId, cleared: true });
      return { cleared: true as const };
    },
  });

  bb.background.service("review-loop", {
    async start(signal) {
      while (!signal.aborted) {
        const keys = await bb.storage.kv.list("session:");
        await Promise.allSettled(
          keys.map(async (key) => {
            const value = await bb.storage.kv.get<ReviewSession>(key);
            const parsed = reviewSessionSchema.safeParse(value);
            if (!parsed.success || !["reviewing", "fixing"].includes(parsed.data.loopState)) return;
            try {
              await processLoopSession(parsed.data);
            } catch (error) {
              bb.log.error(`loop ${parsed.data.runId}: ${error instanceof Error ? error.message : String(error)}`);
              await persistIfCurrent(parsed.data, {
                ...parsed.data,
                loopState: "stopped",
                statusMessage: `Loop fixing stopped: ${error instanceof Error ? error.message : String(error)}`,
              });
            }
          }),
        );
        await abortableSleep(REVIEW_LOOP_POLL_MS, signal);
      }
    },
  });

  bb.cli.register({
    name: "review",
    summary: "Start and manage code-review threads",
    commands: [
      { name: "start", summary: "Start a review", usage: "bb review start [--current] [--loop|--no-loop] <uncommitted|branch|commit|pr|folder|custom> [value...]" },
      { name: "status", summary: "Show the linked review", usage: "bb review status" },
      { name: "apply", summary: "Send findings to the parent thread for fixing", usage: "bb review apply" },
      { name: "stop", summary: "Stop loop fixing", usage: "bb review stop" },
      { name: "clear", summary: "Forget the linked review", usage: "bb review clear" },
    ],
    async run(argv, ctx) {
      if (!ctx.threadId) {
        return { exitCode: 2, stderr: "Run this command from a bb thread so the plugin can resolve its project and environment.\n" };
      }

      try {
        const [command = "start", ...rawArgs] = argv;
        if (command === "status") {
          const session = await getSession(ctx.threadId);
          return {
            exitCode: 0,
            stdout: session
              ? `${session.isolated ? "isolated" : "current"} review ${session.reviewThreadId}: ${session.targetLabel}${session.loopFixing ? `; loop=${session.loopState}; pass=${session.iteration}/${REVIEW_LOOP_MAX_ITERATIONS}` : ""}${session.statusMessage ? `; ${session.statusMessage}` : ""}\n`
              : "No linked review.\n",
          };
        }
        if (command === "apply") {
          await applyFindings(ctx.threadId);
          return { exitCode: 0, stdout: "Queued the review findings in the parent thread.\n" };
        }
        if (command === "stop") {
          await stopLoop(ctx.threadId);
          return { exitCode: 0, stdout: "Stopped loop fixing.\n" };
        }
        if (command === "clear") {
          await bb.storage.kv.delete(sessionKey(ctx.threadId));
          bb.realtime.publish("session", { parentThreadId: ctx.threadId, cleared: true });
          return { exitCode: 0, stdout: "Cleared the linked review.\n" };
        }
        if (command !== "start") throw new Error(`unknown command: ${command}`);

        const args = [...rawArgs];
        const currentIndex = args.indexOf("--current");
        const loopIndex = args.indexOf("--loop");
        const noLoopIndex = args.indexOf("--no-loop");
        if (currentIndex >= 0) args.splice(currentIndex, 1);
        const loopFlagIndex = args.indexOf("--loop");
        if (loopFlagIndex >= 0) args.splice(loopFlagIndex, 1);
        const noLoopFlagIndex = args.indexOf("--no-loop");
        if (noLoopFlagIndex >= 0) args.splice(noLoopFlagIndex, 1);

        const configured = await settings.get();
        const loopFixing = loopIndex >= 0 ? true : noLoopIndex >= 0 ? false : configured.loopFixingEnabled;
        const mode: ReviewMode = loopFixing
          ? "isolated"
          : currentIndex >= 0
            ? "current"
            : configured.isolatedByDefault
              ? "isolated"
              : "current";
        const target = parseCliTarget(args);
        const session = await startReview(ctx.threadId, target, mode, loopFixing);
        return {
          exitCode: 0,
          stdout: `Started ${session.isolated ? "isolated" : "current-thread"} review ${session.reviewThreadId}: ${session.targetLabel}${session.loopFixing ? " (loop fixing enabled)" : ""}\n`,
        };
      } catch (error) {
        return { exitCode: 1, stderr: `${error instanceof Error ? error.message : String(error)}\n` };
      }
    },
  });

  bb.onDispose(() => bb.log.info("disposed"));
}
