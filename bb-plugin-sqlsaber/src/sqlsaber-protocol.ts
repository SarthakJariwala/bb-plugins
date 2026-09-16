import { z } from "zod";

export const SQLSABER_PROTOCOL_VERSION = 1;
export const MAX_SQLSABER_LINE_BYTES = 8 * 1024 * 1024;

const requestIdSchema = z.union([z.string(), z.number()]);

const responseSchema = z.union([
  z.object({
    type: z.literal("response"),
    command: z.string(),
    success: z.literal(true),
    id: requestIdSchema.optional(),
    data: z.unknown().optional(),
  }),
  z.object({
    type: z.literal("response"),
    command: z.string(),
    success: z.literal(false),
    id: requestIdSchema.optional(),
    error: z.string(),
  }),
]);

const stateSchema = z.object({
  state: z.enum(["idle", "running"]),
  database: z.object({
    name: z.string(),
    type: z.string(),
    names: z.array(z.string()),
  }),
  model: z.object({ name: z.string(), id: z.string().nullable() }),
  thinkingLevel: z.string(),
  thinkingLevels: z.array(z.string()),
  dangerousMode: z.boolean(),
  csvToolResults: z.boolean(),
  threadId: z.string().nullable(),
  threadPersistence: z.boolean(),
  messageCount: z.number().int().nonnegative(),
  pendingSteers: z.array(z.string()),
});

const readySchema = stateSchema.extend({
  type: z.literal("ready"),
  protocolVersion: z.number().int(),
});

const assistantMessageEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text_start"), contentIndex: z.number().int() }),
  z.object({
    type: z.literal("text_delta"),
    contentIndex: z.number().int(),
    delta: z.string(),
  }),
  z.object({
    type: z.literal("text_end"),
    contentIndex: z.number().int(),
    content: z.string(),
  }),
  z.object({ type: z.literal("thinking_start"), contentIndex: z.number().int() }),
  z.object({
    type: z.literal("thinking_delta"),
    contentIndex: z.number().int(),
    delta: z.string(),
  }),
  z.object({
    type: z.literal("thinking_end"),
    contentIndex: z.number().int(),
    content: z.string(),
  }),
  z.object({
    type: z.literal("toolcall_start"),
    contentIndex: z.number().int(),
    id: z.string(),
    toolName: z.string(),
  }),
  z.object({
    type: z.literal("toolcall_delta"),
    contentIndex: z.number().int(),
    delta: z.string(),
  }),
  z.object({
    type: z.literal("toolcall_end"),
    contentIndex: z.number().int(),
    toolCall: z.unknown(),
  }),
]);

export const queryResultDescriptorSchema = z.object({
  id: z.string().regex(/^qr_[a-f0-9]{32}$/u),
  file: z.string(),
  rowCount: z.number().int().nonnegative(),
  columns: z.array(z.string()),
  size: z.number().nonnegative(),
  sha256: z.string(),
  mediaType: z.string(),
  databaseName: z.string().optional(),
  createdAt: z.number().optional(),
});

const usageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
  cacheWriteTokens: z.number().int().nonnegative(),
  requests: z.number().int().nonnegative(),
  toolCalls: z.number().int().nonnegative(),
  contextTokens: z.number().int().nonnegative(),
});

const agentEndSchema = z.union([
  z.object({
    type: z.literal("agent_end"),
    status: z.literal("completed"),
    text: z.string(),
    messages: z.array(z.unknown()),
    usage: usageSchema.nullable(),
    queryResults: z.array(queryResultDescriptorSchema),
    artifacts: z.array(z.unknown()),
    threadId: z.string().nullable(),
  }),
  z.object({ type: z.literal("agent_end"), status: z.literal("aborted") }),
  z.object({
    type: z.literal("agent_end"),
    status: z.literal("error"),
    error: z.string(),
  }),
]);

const eventSchema = z.union([
  z.object({ type: z.literal("agent_start"), promptId: requestIdSchema.optional() }),
  z.object({ type: z.literal("message_start") }),
  z.object({
    type: z.literal("message_update"),
    assistantMessageEvent: assistantMessageEventSchema,
  }),
  z.object({ type: z.literal("message_end"), message: z.unknown() }),
  z.object({
    type: z.literal("sql_update"),
    sql: z.string(),
    toolCallId: z.string().optional(),
  }),
  z.object({
    type: z.literal("tool_execution_start"),
    toolCallId: z.string(),
    toolName: z.string(),
    args: z.record(z.string(), z.unknown()),
  }),
  z.object({
    type: z.literal("tool_execution_end"),
    toolCallId: z.string(),
    toolName: z.string(),
    result: z.unknown(),
    isError: z.boolean(),
    queryResult: queryResultDescriptorSchema.optional(),
  }),
  agentEndSchema,
  z.object({ type: z.literal("queue_update"), steering: z.array(z.string()) }),
]);

const messageSchema = z.union([responseSchema, readySchema, eventSchema]);

const KNOWN_MESSAGE_TYPES = new Set([
  "response",
  "ready",
  "agent_start",
  "message_start",
  "message_update",
  "message_end",
  "sql_update",
  "tool_execution_start",
  "tool_execution_end",
  "agent_end",
  "queue_update",
]);

export const queryResultPageSchema = z.object({
  result: queryResultDescriptorSchema,
  offset: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  rows: z.array(z.record(z.string(), z.unknown())),
  hasMore: z.boolean(),
});

export type SqlSaberResponse = z.infer<typeof responseSchema>;
export type SqlSaberReady = z.infer<typeof readySchema>;
export type SqlSaberEvent = z.infer<typeof eventSchema>;
export type SqlSaberMessage = z.infer<typeof messageSchema>;
export type QueryResultDescriptor = z.infer<typeof queryResultDescriptorSchema>;
export type QueryResultPage = z.infer<typeof queryResultPageSchema>;

export type ParsedSqlSaberLine =
  | { kind: "message"; message: SqlSaberMessage }
  | { kind: "unknown"; payload: Record<string, unknown> };

export class SqlSaberProtocolError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseSqlSaberLine(line: string): ParsedSqlSaberLine {
  let decoded: unknown;
  try {
    decoded = JSON.parse(line);
  } catch (cause) {
    throw new SqlSaberProtocolError(
      cause instanceof Error ? `Invalid SQLSaber JSON: ${cause.message}` : "Invalid SQLSaber JSON",
    );
  }

  const parsed = messageSchema.safeParse(decoded);
  if (parsed.success) {
    return { kind: "message", message: parsed.data };
  }
  if (isRecord(decoded) && typeof decoded.type === "string") {
    if (!KNOWN_MESSAGE_TYPES.has(decoded.type)) {
      return { kind: "unknown", payload: decoded };
    }
  }
  throw new SqlSaberProtocolError("SQLSaber emitted a malformed protocol record");
}

export class JsonLineDecoder {
  readonly #maximumBytes: number;
  #pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  readonly #decoder = new TextDecoder("utf-8", { fatal: true });

  constructor(maximumBytes = MAX_SQLSABER_LINE_BYTES) {
    this.#maximumBytes = maximumBytes;
  }

  feed(chunk: Buffer): string[] {
    const data = this.#pending.length === 0 ? chunk : Buffer.concat([this.#pending, chunk]);
    const lines: string[] = [];
    let start = 0;

    for (let index = data.indexOf(0x0a, start); index !== -1; index = data.indexOf(0x0a, start)) {
      let end = index;
      if (end > start && data[end - 1] === 0x0d) {
        end -= 1;
      }
      const line = data.subarray(start, end);
      if (line.length > this.#maximumBytes) {
        throw new SqlSaberProtocolError(
          `SQLSaber emitted a line larger than ${this.#maximumBytes} bytes`,
        );
      }
      lines.push(this.#decode(line));
      start = index + 1;
    }

    this.#pending = data.subarray(start);
    if (this.#pending.length > this.#maximumBytes) {
      throw new SqlSaberProtocolError(
        `SQLSaber emitted a line larger than ${this.#maximumBytes} bytes`,
      );
    }
    return lines;
  }

  finish(): string[] {
    if (this.#pending.length === 0) {
      return [];
    }
    const line = this.#decode(this.#pending);
    this.#pending = Buffer.alloc(0);
    return [line];
  }

  #decode(value: Buffer): string {
    try {
      return this.#decoder.decode(value);
    } catch {
      throw new SqlSaberProtocolError("SQLSaber emitted invalid UTF-8");
    }
  }
}
