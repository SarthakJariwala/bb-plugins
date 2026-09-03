import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  ROLE_DEFINITIONS,
  defaultModelConfig,
  modelConfigSchema,
  modelSelectionSchema,
  normalizeModelConfig,
  roleIdSchema,
  selectionForRole,
  validateCompleteModelConfig,
  type ModelConfig,
} from "./model-config.js";

const roleDefinitionSchema = z.object({
  id: roleIdSchema,
  label: z.string(),
  description: z.string(),
  panel: z.boolean(),
});

export const rpcContract = defineRpcContract({
  config_get: {
    input: z.null(),
    output: z.object({
      roles: z.array(roleDefinitionSchema),
      config: modelConfigSchema,
    }),
  },
  config_save: {
    input: z.object({ config: modelConfigSchema }).strict(),
    output: z.object({ config: modelConfigSchema }),
  },
  config_reset: {
    input: z.null(),
    output: z.object({ config: modelConfigSchema }),
  },
});

const PSTACK_SKILLS = [
  "architect",
  "arena",
  "automate-me",
  "blast-radius",
  "bro",
  "create-verification-skill",
  "figure-it-out",
  "how",
  "interrogate",
  "maintain-verification-skill",
  "make-bot-ui",
  "no-comments",
  "poteto-mode",
  "principle-boundary-discipline",
  "principle-build-the-lever",
  "principle-encode-lessons-in-structure",
  "principle-exhaust-the-design-space",
  "principle-experience-first",
  "principle-fix-root-causes",
  "principle-foundational-thinking",
  "principle-guard-the-context-window",
  "principle-laziness-protocol",
  "principle-make-operations-idempotent",
  "principle-migrate-callers-then-delete-legacy-apis",
  "principle-minimize-reader-load",
  "principle-model-the-domain",
  "principle-never-block-on-the-human",
  "principle-outcome-oriented-execution",
  "principle-prove-it-works",
  "principle-redesign-from-first-principles",
  "principle-separate-before-serializing-shared-state",
  "principle-sequence-verifiable-units",
  "principle-subtract-before-you-add",
  "principle-type-system-discipline",
  "recall",
  "reflect",
  "setup-pstack",
  "show-me-your-work",
  "swarm",
  "tdd",
  "teach",
  "technical-writing",
  "typescript-best-practices",
  "unslop",
  "why",
] as const;

const PSTACK_TOOLS = [
  "pstack_get_model_config",
  "pstack_update_model_config",
  "pstack_spawn_threads",
  "pstack_finish_threads",
] as const;

const POTETO_AGENT_PROMPT = `You are a pstack Poteto worker. Before doing any work, read the Poteto Mode skill's SKILL.md in full, including its inline Principles index. Follow the matched playbook and navigate to each leaf principle skill you apply. Return a concise report to the parent thread with evidence and file pointers; do not forward raw dumps.`;

const COMMENT_SICKO_PROMPT = `Your first output is exactly: Yes... Ha ha ha... Yes!

You are Comment Sicko, a read-only comment reviewer. Read the supplied scope or the current diff against main. Condemn narration, banners, commented-out code, workaround sermons, suppressions that hide correctness rules, and long justifications. Keep only legal headers, non-obvious constraints forced by an external dependency or protocol, prettier-ignore, public API contract docs, and issue or RFC links for constraints code cannot express. Never write application code. Report touched files, deletion count, MUST KILL flags with one line each, and skips.`;

const COORDINATOR_RULE =
  "One owner per scope. While children run, the parent may only coordinate them or work on a disjoint scope. Do not investigate or edit delegated scope unless the brief declares an explicit race. After spawn, stop or continue only disjoint work. Do not wait with a tool, `bb thread wait`, or polling. BB posts child-completion, failure, interruption, and needs-attention messages into this thread. Those messages are the barrier. Dependent work, review, verification, or finalization waits until they cover every required child. If a batched update is status-only, read `bb thread output <id>`. Read-only advisers do not satisfy mandatory implementation delegation.";

const BRIEF_RULE =
  "Keep briefs compact. Point children to files and artifacts instead of inlining large payloads.";

function workerPrompt(
  prompt: string,
  preset: "poteto-agent" | "general" | "comment-sicko",
  readOnly: boolean,
): string {
  const presetPrompt =
    preset === "poteto-agent"
      ? POTETO_AGENT_PROMPT
      : preset === "comment-sicko"
        ? COMMENT_SICKO_PROMPT
        : "You are a pstack worker. Complete the brief independently and return a compact, evidenced report to the parent thread.";
  const readOnlyPrompt = readOnly
    ? "\n\nThis is read-only work. Do not modify files, branches, tickets, or external state."
    : "";
  return `${presetPrompt}${readOnlyPrompt}\n\n## Brief\n\n${prompt}`;
}

function printableConfig(config: ModelConfig): string {
  return ROLE_DEFINITIONS.map((role) => {
    const value = config[role.id]
      .map((selection) => {
        const tier = selection.serviceTier === undefined ? "" : `, ${selection.serviceTier} tier`;
        return `${selection.providerId}: ${selection.model} (${selection.reasoningLevel}${tier})`;
      })
      .join(", ");
    return `${role.label}: ${value}`;
  }).join("\n");
}

export default async function plugin(bb: BbPluginApi) {
  bb.log.info("loaded");

  async function readConfig(): Promise<ModelConfig> {
    return normalizeModelConfig(await bb.storage.kv.get("model-config"));
  }

  async function writeConfig(config: ModelConfig): Promise<ModelConfig> {
    const validated = validateCompleteModelConfig(config);
    await bb.storage.kv.set("model-config", validated);
    bb.realtime.publish("model-config-changed", null);
    return validated;
  }

  async function resetConfig(): Promise<ModelConfig> {
    const config = defaultModelConfig();
    await bb.storage.kv.set("model-config", config);
    bb.realtime.publish("model-config-changed", null);
    return config;
  }

  async function providerCatalogsForThread(threadId: string, signal?: AbortSignal) {
    const parent = await bb.sdk.threads.get({ threadId, signal });
    const routing =
      parent.environmentId === null ? {} : { environmentId: parent.environmentId };
    const providers = await bb.sdk.providers.list({ ...routing, signal });

    return Promise.all(
      providers.map(async (provider) => {
        try {
          const catalog = await bb.sdk.providers.models({
            ...routing,
            providerId: provider.id,
            signal,
          });
          return {
            id: provider.id,
            displayName: provider.displayName,
            available: provider.available,
            serviceTiers: provider.serviceTiers?.map((tier) => tier.id) ?? [],
            models: catalog.models.map((model) => ({
              id: model.id,
              displayName: model.displayName,
              isDefault: model.isDefault,
              reasoningLevels: model.supportedReasoningEfforts.map(
                (effort) => effort.reasoningEffort,
              ),
            })),
            modelLoadError: catalog.modelLoadError,
          };
        } catch (cause) {
          return {
            id: provider.id,
            displayName: provider.displayName,
            available: provider.available,
            serviceTiers: provider.serviceTiers?.map((tier) => tier.id) ?? [],
            models: [],
            modelLoadError: {
              code: "failed",
              providerId: provider.id,
              message: cause instanceof Error ? cause.message : String(cause),
            },
          };
        }
      }),
    );
  }

  bb.rpc.register(rpcContract, {
    config_get: async () => ({
      roles: [...ROLE_DEFINITIONS],
      config: await readConfig(),
    }),
    config_save: async ({ config }) => ({ config: await writeConfig(config as ModelConfig) }),
    config_reset: async () => ({ config: await resetConfig() }),
  });

  bb.agents.registerTool({
    name: "pstack_get_model_config",
    description:
      "Read pstack's per-role provider and model configuration plus the providers and models available in this thread's environment. Use before planning pstack fan-out and during setup-pstack.",
    presentation: {
      label: { pending: "Reading pstack models", completed: "Read pstack models" },
    },
    parameters: z.object({}).strict(),
    async execute(_params, { threadId, signal }) {
      const [config, providers] = await Promise.all([
        readConfig(),
        providerCatalogsForThread(threadId, signal),
      ]);
      return JSON.stringify({
        roles: ROLE_DEFINITIONS,
        config,
        providers,
      });
    },
  });

  bb.agents.registerTool({
    name: "pstack_update_model_config",
    description:
      "Update one or more pstack role provider and model selections after the user chooses them, or reset all roles to BB defaults.",
    presentation: {
      label: { pending: "Saving pstack models", completed: "Saved pstack models" },
    },
    parameters: z
      .object({
        reset: z.boolean().optional(),
        updates: z
          .array(
            z
              .object({
                role: roleIdSchema,
                selections: z.array(modelSelectionSchema).min(1).max(12),
              })
              .strict(),
          )
          .max(18)
          .optional(),
      })
      .strict(),
    async execute({ reset, updates }) {
      if (reset === true) return JSON.stringify(await resetConfig());
      if (updates === undefined || updates.length === 0) {
        throw new Error("Provide at least one role update or set reset to true.");
      }
      const config = await readConfig();
      for (const update of updates) {
        const role = ROLE_DEFINITIONS.find((candidate) => candidate.id === update.role)!;
        if (!role.panel && update.selections.length !== 1) {
          throw new Error(`${role.label} accepts exactly one model.`);
        }
        config[update.role] = update.selections;
      }
      return JSON.stringify(await writeConfig(config));
    },
  });

  const workerSchema = z
    .object({
      title: z.string().trim().min(1).max(120).optional(),
      prompt: z.string().trim().min(1).max(100_000),
      role: roleIdSchema,
      selectionIndex: z.number().int().min(0).max(11).optional(),
      preset: z.enum(["poteto-agent", "general", "comment-sicko"]).optional(),
      readOnly: z.boolean().optional(),
      workspace: z.enum(["reuse", "new-worktree", "project-default"]).optional(),
    })
    .strict();

  bb.agents.registerTool({
    name: "pstack_spawn_threads",
    description:
      "Spawn one or more visible BB child threads concurrently as pstack workers. Every child uses the configured provider and model for its role. Returns immediately with thread IDs. BB notifies this parent when a child completes, fails, is interrupted, or needs attention.",
    instructions: [
      "Use this instead of a provider-native subagent, Task tool, or `bb thread spawn`. Batch independent workers in one call. Use readOnly for reviewers and explorers. Give concurrent writers separate new-worktree workspaces.",
      COORDINATOR_RULE,
      BRIEF_RULE,
    ].join(" "),
    presentation: {
      label: { pending: "Spawning pstack workers", completed: "Spawned pstack workers" },
      icon: { glyph: "Workflow" },
    },
    parameters: z.object({ workers: z.array(workerSchema).min(1).max(24) }).strict(),
    async execute({ workers }, { threadId, projectId, signal }) {
      const sharedWriters = workers.flatMap((worker, index) => {
        const workspace = worker.workspace ?? "reuse";
        return worker.readOnly === true || workspace === "new-worktree"
          ? []
          : [{ index, workspace }];
      });
      if (sharedWriters.length > 1) {
        throw new Error(
          `A spawn batch may contain at most one writable worker in a shared workspace. Set readOnly: true or workspace: "new-worktree" for the other workers. ${JSON.stringify({
            code: "PSTACK_SHARED_WRITER_BATCH",
            workers: sharedWriters,
          })}`,
        );
      }

      const [parent, config] = await Promise.all([
        bb.sdk.threads.get({ threadId, signal }),
        readConfig(),
      ]);
      if (!parent.canSpawnChild) {
        throw new Error("This thread cannot spawn child threads.");
      }

      let parentHostId: string | undefined;
      if (workers.some((worker) => worker.workspace === "new-worktree")) {
        if (parent.environmentId !== null) {
          const environment = await bb.sdk.environments.get({
            environmentId: parent.environmentId,
            signal,
          });
          parentHostId = environment.hostId;
        }
      }

      const results = await Promise.allSettled(
        workers.map(async (worker, index) => {
          const selection = selectionForRole(
            config,
            worker.role,
            worker.selectionIndex ?? index,
          );
          const workspace = worker.workspace ?? "reuse";
          const environment =
            workspace === "new-worktree"
              ? {
                  type: "host" as const,
                  ...(parentHostId === undefined ? {} : { hostId: parentHostId }),
                  workspace: {
                    type: "managed-worktree" as const,
                    baseBranch: { kind: "default" as const },
                  },
                }
              : workspace === "project-default" || parent.environmentId === null
                ? ({ type: "project-default" as const } as const)
                : ({ type: "reuse" as const, environmentId: parent.environmentId } as const);
          const child = await bb.sdk.threads.spawn({
            projectId,
            parentThreadId: threadId,
            providerId: selection.providerId,
            model: selection.model,
            reasoningLevel: selection.reasoningLevel,
            ...(selection.serviceTier === undefined
              ? {}
              : { serviceTier: selection.serviceTier }),
            environment,
            visibility: "visible",
            title: worker.title,
            prompt: workerPrompt(
              worker.prompt,
              worker.preset ?? "poteto-agent",
              worker.readOnly ?? false,
            ),
          });
          return {
            index,
            threadId: child.id,
            title: child.title ?? child.titleFallback,
            role: worker.role,
            providerId: selection.providerId,
            model: selection.model,
            reasoningLevel: selection.reasoningLevel,
            ...(selection.serviceTier === undefined
              ? {}
              : { serviceTier: selection.serviceTier }),
            workspace,
          };
        }),
      );

      return JSON.stringify(
        results.map((result, index) =>
          result.status === "fulfilled"
            ? { ok: true, ...result.value }
            : {
                ok: false,
                index,
                error:
                  result.reason instanceof Error
                    ? result.reason.message
                    : String(result.reason),
              },
        ),
      );
    },
  });

  bb.agents.registerTool({
    name: "pstack_finish_threads",
    description: "Archive and stop pstack child threads when the user explicitly requests cleanup.",
    instructions:
      "Use only after the user asks to remove completed pstack child threads. Completed children stay visible by default.",
    presentation: {
      label: { pending: "Stopping pstack workers", completed: "Stopped pstack workers" },
      icon: { glyph: "Workflow" },
      suppress: true,
    },
    parameters: z
      .object({ threadIds: z.array(z.string().min(1)).min(1).max(50) })
      .strict(),
    async execute({ threadIds }) {
      const results = await Promise.allSettled(
        threadIds.map(async (childThreadId) => {
          await bb.sdk.threads.archive({ threadId: childThreadId });
          await bb.sdk.threads.stop({ threadId: childThreadId });
          return childThreadId;
        }),
      );
      return JSON.stringify(
        results.map((result, index) =>
          result.status === "fulfilled"
            ? { threadId: result.value, ok: true }
            : {
                threadId: threadIds[index],
                ok: false,
                error:
                  result.reason instanceof Error
                    ? result.reason.message
                    : String(result.reason),
              },
        ),
      );
    },
  });

  bb.agents.configure(() => ({
    tools: [...PSTACK_TOOLS],
    skills: [...PSTACK_SKILLS],
    instructions: [
      "Pstack runs delegation through visible BB child threads. When a pstack skill says Task, subagent, worker agent, or model panel, use pstack_spawn_threads instead of a provider-native subagent or `bb thread spawn`. Spawn applies the role's configured provider, model, workspace, and preset. Children remain visible unless the user asks to finish them. Read role choices with pstack_get_model_config; never read ~/.cursor/rules/pstack-models.mdc.",
      COORDINATOR_RULE,
      BRIEF_RULE,
    ].join(" "),
  }));

  const usage = [
    "Usage:",
    "  bb pstack setup",
    "  bb pstack config [--json]",
    "  bb pstack reset [--json]",
  ].join("\n");
  bb.cli.register({
    name: "pstack",
    summary: "Inspect and reset pstack's provider and model configuration",
    commands: [
      {
        name: "setup",
        summary: "Show how to run interactive model setup",
        usage: "bb pstack setup",
      },
      {
        name: "config",
        summary: "Show the current per-role model configuration",
        usage: "bb pstack config [--json]",
      },
      {
        name: "reset",
        summary: "Reset every role to the BB pstack defaults",
        usage: "bb pstack reset [--json]",
      },
    ],
    async run(argv) {
      const json = argv.includes("--json");
      const [command] = argv.filter((arg) => arg !== "--json");
      if (command === "setup") {
        return {
          exitCode: 0,
          stdout:
            "Run /setup-pstack in a BB thread for guided setup, or open Pstack in Settings → Plugins to edit every role.",
        };
      }
      if (command === "config") {
        const config = await readConfig();
        return {
          exitCode: 0,
          stdout: json ? JSON.stringify(config) : printableConfig(config),
        };
      }
      if (command === "reset") {
        const config = await resetConfig();
        return {
          exitCode: 0,
          stdout: json ? JSON.stringify(config) : printableConfig(config),
        };
      }
      return { exitCode: command === undefined ? 0 : 1, [command === undefined ? "stdout" : "stderr"]: usage };
    },
  });
}
