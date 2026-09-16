import type { PluginProviderFallbackModel } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const PLUGIN_ID = "sqlsaber";
export const PROVIDER_ID = "sqlsaber";
export const CONFIGURED_MODEL_ID = "configured";
export const SQLSABER_EXECUTABLE_ENV = "SQLSABER_EXECUTABLE";
export const QUERY_RESULT_KIND = `${PLUGIN_ID}/query-result` as const;
export const SQL_TABLE_ROW_LIMIT = 100;
export const SQL_TABLE_COLUMN_LIMIT = 100;
export const SQL_TABLE_CELL_LIMIT = 1_000;
export const SQL_TABLE_CELL_CHARACTER_LIMIT = 1_000;

export const REASONING_LEVELS = ["none", "low", "medium", "high", "max"] as const;

export const CONFIGURED_MODEL = {
  id: CONFIGURED_MODEL_ID,
  displayName: "SQLSaber configured model",
  description: "Uses the model selected by `sqlsaber models set` on this machine.",
  supportedReasoningEfforts: [
    { reasoningEffort: "none", description: "Disable extended thinking." },
    { reasoningEffort: "low", description: "Use low reasoning effort." },
    { reasoningEffort: "medium", description: "Use medium reasoning effort." },
    { reasoningEffort: "high", description: "Use high reasoning effort." },
    { reasoningEffort: "max", description: "Use SQLSaber's maximum reasoning effort." },
  ],
  defaultReasoningEffort: "medium",
  isDefault: true,
} satisfies PluginProviderFallbackModel;

export const tableCellSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("null") }),
  z.object({ kind: z.literal("boolean"), value: z.boolean() }),
  z.object({ kind: z.literal("number"), value: z.number() }),
  z.object({
    kind: z.literal("text"),
    value: z.string().max(SQL_TABLE_CELL_CHARACTER_LIMIT),
  }),
]);

export const sqlTablePayloadSchema = z
  .object({
    resultId: z.string().regex(/^qr_[a-f0-9]{32}$/u),
    databaseName: z
      .string()
      .min(1)
      .max(SQL_TABLE_CELL_CHARACTER_LIMIT)
      .nullable(),
    columns: z
      .array(z.string().max(SQL_TABLE_CELL_CHARACTER_LIMIT))
      .max(SQL_TABLE_COLUMN_LIMIT),
    columnCount: z.number().int().nonnegative(),
    rows: z
      .array(z.array(tableCellSchema).max(SQL_TABLE_COLUMN_LIMIT))
      .max(SQL_TABLE_ROW_LIMIT),
    rowCount: z.number().int().nonnegative(),
    truncated: z.boolean(),
  })
  .refine(
    (table) =>
      table.rows.reduce((total, row) => total + row.length, 0) <=
      SQL_TABLE_CELL_LIMIT,
    { message: "A SQL table preview cannot exceed 1,000 cells", path: ["rows"] },
  );

export type TableCell = z.infer<typeof tableCellSchema>;
export type SqlTablePayload = z.infer<typeof sqlTablePayloadSchema>;

export const sqlsaberExtensionKinds = {
  "query-result": { item: sqlTablePayloadSchema },
} as const;
