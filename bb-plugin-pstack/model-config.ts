import { z } from "zod";

export const reasoningLevelSchema = z.enum([
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
  "ultracode",
]);
export type ReasoningLevel = z.infer<typeof reasoningLevelSchema>;

export const modelSelectionSchema = z
  .object({
    model: z.string().trim().min(1),
    reasoningLevel: reasoningLevelSchema,
  })
  .strict();
export type ModelSelection = z.infer<typeof modelSelectionSchema>;

export const ROLE_DEFINITIONS = [
  {
    id: "feature-refactoring",
    label: "Feature and refactoring",
    description: "Precisely scoped implementation and mechanical refactors.",
    panel: false,
  },
  {
    id: "bug-fix",
    label: "Bug fix",
    description: "Root-cause analysis and implementation.",
    panel: false,
  },
  {
    id: "perf-issue",
    label: "Performance issue",
    description: "Trace-guided performance work.",
    panel: false,
  },
  {
    id: "hillclimb",
    label: "Hillclimb",
    description: "Repeated measured improvement loops.",
    panel: false,
  },
  {
    id: "judgment-prose",
    label: "Judgment and prose",
    description: "Synthesis, explanation, and writing.",
    panel: false,
  },
  {
    id: "hardest-tasks",
    label: "Hardest tasks",
    description: "Cross-cutting design, concurrency, and subtle algorithms.",
    panel: false,
  },
  {
    id: "how-explorer",
    label: "How explorer",
    description: "Read-only subsystem exploration.",
    panel: false,
  },
  {
    id: "how-explainer",
    label: "How explainer",
    description: "Architectural synthesis and explanation.",
    panel: false,
  },
  {
    id: "how-critics",
    label: "How critics",
    description: "One architectural critic thread per entry.",
    panel: true,
  },
  {
    id: "why-investigators",
    label: "Why investigators",
    description: "Parallel evidence-source investigation.",
    panel: false,
  },
  {
    id: "why-synthesizer",
    label: "Why synthesizer",
    description: "Evidence reconciliation and final rationale.",
    panel: false,
  },
  {
    id: "reflect-tooling",
    label: "Reflect tooling",
    description: "Tooling and workflow review.",
    panel: false,
  },
  {
    id: "reflect-judgment",
    label: "Reflect judgment, divergent, and synthesis",
    description: "Judgment-led transcript review and synthesis.",
    panel: false,
  },
  {
    id: "arena-runners",
    label: "Arena runners",
    description: "One independent candidate thread per entry.",
    panel: true,
  },
  {
    id: "arena-cross-judge",
    label: "Arena cross-judge pool",
    description: "Candidates for the blinded cross-judge.",
    panel: true,
  },
  {
    id: "swarm-workers",
    label: "Swarm workers",
    description: "Default for coverage and race workers.",
    panel: false,
  },
  {
    id: "architect-runners",
    label: "Architect runners",
    description: "One design runner thread per entry.",
    panel: true,
  },
  {
    id: "interrogate-reviewers",
    label: "Interrogate reviewers",
    description: "One adversarial reviewer thread per entry.",
    panel: true,
  },
] as const;

export const roleIdSchema = z.enum(
  ROLE_DEFINITIONS.map((role) => role.id) as [
    (typeof ROLE_DEFINITIONS)[number]["id"],
    ...(typeof ROLE_DEFINITIONS)[number]["id"][],
  ],
);
export type RoleId = z.infer<typeof roleIdSchema>;

export const modelConfigSchema = z.record(
  roleIdSchema,
  z.array(modelSelectionSchema).min(1).max(12),
);
export type ModelConfig = Record<RoleId, ModelSelection[]>;

const GPT_56_SOL = "openai-codex/gpt-5.6-sol";
const sol = (reasoningLevel: ReasoningLevel): ModelSelection => ({
  model: GPT_56_SOL,
  reasoningLevel,
});

const fourWayPanel = (): ModelSelection[] => [
  sol("max"),
  sol("max"),
  sol("xhigh"),
  sol("xhigh"),
];

export function defaultModelConfig(): ModelConfig {
  return {
    "feature-refactoring": [sol("xhigh")],
    "bug-fix": [sol("max")],
    "perf-issue": [sol("max")],
    hillclimb: [sol("max")],
    "judgment-prose": [sol("max")],
    "hardest-tasks": [sol("max")],
    "how-explorer": [sol("xhigh")],
    "how-explainer": [sol("max")],
    "how-critics": fourWayPanel(),
    "why-investigators": [sol("xhigh")],
    "why-synthesizer": [sol("max")],
    "reflect-tooling": [sol("max")],
    "reflect-judgment": [sol("max")],
    "arena-runners": fourWayPanel(),
    "arena-cross-judge": fourWayPanel(),
    "swarm-workers": [sol("xhigh")],
    "architect-runners": fourWayPanel(),
    "interrogate-reviewers": fourWayPanel(),
  };
}

export function normalizeModelConfig(value: unknown): ModelConfig {
  const defaults = defaultModelConfig();
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return defaults;
  }

  const candidate = value as Record<string, unknown>;
  for (const role of ROLE_DEFINITIONS) {
    const parsed = z.array(modelSelectionSchema).min(1).max(12).safeParse(candidate[role.id]);
    if (parsed.success && (role.panel || parsed.data.length === 1)) {
      defaults[role.id] = parsed.data;
    }
  }
  return defaults;
}

export function validateCompleteModelConfig(value: unknown): ModelConfig {
  const parsed = modelConfigSchema.parse(value);
  const expected = new Set(ROLE_DEFINITIONS.map((role) => role.id));
  if (Object.keys(parsed).length !== expected.size) {
    throw new Error("Model configuration must include every pstack role.");
  }
  for (const role of ROLE_DEFINITIONS) {
    const selections = parsed[role.id];
    if (!role.panel && selections.length !== 1) {
      throw new Error(`${role.label} accepts exactly one model.`);
    }
  }
  return parsed as ModelConfig;
}

export function selectionForRole(
  config: ModelConfig,
  role: RoleId,
  selectionIndex = 0,
): ModelSelection {
  const selections = config[role];
  return selections[selectionIndex % selections.length] ?? selections[0]!;
}
