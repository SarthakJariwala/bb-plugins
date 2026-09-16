import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  BRIDGE_JSON_RPC_ERRORS,
  BRIDGE_NOTIFICATION_METHODS,
  BRIDGE_REQUEST_METHODS,
  PROVIDER_BRIDGE_PROTOCOL_VERSION,
  THREAD_DELTA_GRAMMAR_V3,
  THREAD_DELTA_NOTIFICATION_METHOD,
  ZERO_TOKEN_USAGE,
  addTokenUsage,
  createBridgeIo,
  createBridgeLineHandler,
  experimental_commandOutput as commandOutput,
  experimental_compareVersions as compareVersions,
  experimental_defineProviderBridge,
  experimental_readCliVersion as readCliVersion,
  experimental_resolveExecutablePath as resolveExecutablePath,
  experimental_toolPresentation as toolPresentation,
  extractResultText,
  initializeParamsSchema,
  modelListParamsSchema,
  providerMaintenanceParamsSchema,
  runBridgeRequest,
  threadDiscardParamsSchema,
  threadResumeParamsSchema,
  threadStartParamsSchema,
  threadStopParamsSchema,
  turnStartParamsSchema,
  turnSteerParamsSchema,
  type BridgeExecutionOptions,
  type DeltaPresentation,
  type PromptInput,
  type ProviderHealthResult,
  type ThreadDelta,
  type ThreadEventTokenUsageBreakdown,
} from "@get-bb/plugin-sdk/provider-bridge";
import { z } from "zod";
import {
  CONFIGURED_MODEL,
  CONFIGURED_MODEL_ID,
  QUERY_RESULT_KIND,
  SQLSABER_EXECUTABLE_ENV,
  SQL_TABLE_CELL_CHARACTER_LIMIT,
  SQL_TABLE_CELL_LIMIT,
  SQL_TABLE_COLUMN_LIMIT,
  SQL_TABLE_ROW_LIMIT,
  sqlTablePayloadSchema,
  type SqlTablePayload,
  type TableCell,
} from "./vocabulary.js";
import {
  queryResultPageSchema,
  type QueryResultDescriptor,
  type SqlSaberEvent,
} from "./sqlsaber-protocol.js";
import { SqlSaberRpcClient } from "./sqlsaber-rpc.js";

const MINIMUM_SQLSABER_VERSION = "0.77.0";

const AGENT_MESSAGE_PRESENTATION: DeltaPresentation = {
  label: { pending: "Answering", completed: "Answered" },
  icon: { glyph: "Sparkles" },
};

const REASONING_PRESENTATION: DeltaPresentation = {
  label: { pending: "Thinking", completed: "Thought" },
  icon: { glyph: "Brain" },
};

const TABLE_PRESENTATION: DeltaPresentation = {
  label: { pending: "Loading query result", completed: "Query result" },
  icon: { glyph: "Table2" },
};

const resumeRecordSchema = z.object({
  providerThreadId: z.string().min(1),
  sqlsaberThreadId: z.string().min(1).nullable(),
});

type ResumeRecord = z.infer<typeof resumeRecordSchema>;
type JsonRpcId = string | number;
type OutboundMessage = { jsonrpc: "2.0" } & Record<string, unknown>;
type TextChannel = "agentMessage" | "reasoningText";

type SessionState =
  | { kind: "idle" }
  | { kind: "running"; turn: ActiveTurn }
  | { kind: "closed" };

interface Deferred {
  promise: Promise<void>;
  resolve(): void;
}

interface StreamState {
  key: string;
  channel: TextChannel;
  text: string;
}

interface ToolState {
  key: string;
  name: string;
  args: Record<string, unknown>;
  presentation: DeltaPresentation;
}

interface ActiveTurn {
  providerTurnId: string;
  messageOrdinal: number;
  streams: Map<string, StreamState>;
  tools: Map<string, ToolState>;
  pendingSql: Map<string, string>;
  queryResults: Map<string, QueryResultDescriptor>;
  done: Deferred;
  suppressed: boolean;
}

interface PromptParseSuccess {
  ok: true;
  text: string;
}

interface PromptParseFailure {
  ok: false;
  error: string;
}

const io = createBridgeIo<OutboundMessage>();
const sessions = new Map<string, BridgeSession>();
const resumeRecords = new Map<string, ResumeRecord>();
let bridgeDataDir: string | null = null;
let bridgeAbortController: AbortController | null = null;

function createDeferred(): Deferred {
  let resolvePromise: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

function notify(method: string, params: Record<string, unknown>): void {
  io.send({ jsonrpc: "2.0", method, params });
}

function emitDeltas(threadId: string, deltas: ThreadDelta[]): void {
  if (deltas.length > 0) {
    notify(THREAD_DELTA_NOTIFICATION_METHOD, { threadId, deltas });
  }
}

function invalidParams(id: JsonRpcId, method: string, issues: unknown): void {
  io.send({
    jsonrpc: "2.0",
    id,
    error: {
      code: BRIDGE_JSON_RPC_ERRORS.INVALID_PARAMS,
      message: `Invalid params for ${method}`,
      data: issues,
    },
  });
}

function promptText(input: readonly PromptInput[]): PromptParseSuccess | PromptParseFailure {
  const textItems = input.filter(
    (item): item is Extract<PromptInput, { type: "text" }> =>
      item.type === "text",
  );
  if (textItems.length !== input.length) {
    const unsupported = input.find((item) => item.type !== "text");
    return {
      ok: false,
      error: `SQLSaber accepts text prompts only; ${unsupported?.type ?? "unknown"} input is not supported`,
    };
  }
  const text = textItems.map((item) => item.text).join("\n\n");
  if (text.trim() === "") {
    return { ok: false, error: "SQLSaber requires a non-empty text prompt" };
  }
  return { ok: true, text };
}

function executionOptionError(options: BridgeExecutionOptions): string | null {
  if (
    options.model !== undefined &&
    options.model !== CONFIGURED_MODEL_ID
  ) {
    return `SQLSaber RPC cannot switch models; expected ${CONFIGURED_MODEL_ID}`;
  }
  if (
    options.serviceTier !== undefined &&
    options.serviceTier !== "default"
  ) {
    return "SQLSaber RPC does not support service tiers";
  }
  return null;
}

function desiredThinkingLevel(
  level: BridgeExecutionOptions["reasoningLevel"],
): string | null {
  switch (level) {
    case undefined:
      return null;
    case "none":
      return "off";
    case "low":
    case "medium":
    case "high":
      return level;
    case "max":
    case "xhigh":
    case "ultracode":
    case "ultra":
      return "maximum";
  }
}

function makeProviderThreadId(): string {
  return `sqlsaber_${randomUUID().replaceAll("-", "")}`;
}

function resumeRecordPath(providerThreadId: string): string | null {
  if (bridgeDataDir === null || !/^sqlsaber_[a-f0-9]{32}$/u.test(providerThreadId)) {
    return null;
  }
  return join(bridgeDataDir, "sessions", `${providerThreadId}.json`);
}

function saveResumeRecord(record: ResumeRecord): void {
  const path = resumeRecordPath(record.providerThreadId);
  if (path === null) {
    resumeRecords.set(record.providerThreadId, record);
    return;
  }
  mkdirSync(join(bridgeDataDir ?? "", "sessions"), {
    recursive: true,
    mode: 0o700,
  });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    renameSync(temporary, path);
    resumeRecords.set(record.providerThreadId, record);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function loadResumeRecord(providerThreadId: string): ResumeRecord | null {
  const current = resumeRecords.get(providerThreadId);
  if (current !== undefined) {
    return current;
  }
  const path = resumeRecordPath(providerThreadId);
  if (path === null) {
    return null;
  }
  try {
    const parsed = resumeRecordSchema.safeParse(
      JSON.parse(readFileSync(path, "utf8")),
    );
    if (!parsed.success || parsed.data.providerThreadId !== providerThreadId) {
      return null;
    }
    resumeRecords.set(providerThreadId, parsed.data);
    return parsed.data;
  } catch {
    return null;
  }
}

function deleteResumeRecord(providerThreadId: string): void {
  const path = resumeRecordPath(providerThreadId);
  if (path !== null) {
    rmSync(path, { force: true });
  }
  resumeRecords.delete(providerThreadId);
}

async function resolveSqlSaberExecutable(): Promise<string | null> {
  const override = process.env[SQLSABER_EXECUTABLE_ENV]?.trim();
  if (override !== undefined && override !== "") {
    return resolveExecutablePath(override);
  }
  return (await resolveExecutablePath("sqlsaber")) ?? resolveExecutablePath("saber");
}

function stripAnsi(value: string): string {
  return value.replace(/\u001B\[[0-?]*[ -/]*[@-~]/gu, "");
}

async function configuredModelName(executable: string): Promise<string | null> {
  const output = await commandOutput(executable, ["models", "current"]);
  if (output === null) {
    return null;
  }
  const plain = stripAnsi(output);
  const markdown = /\*\*Current model\*\*:\s*([^\s]+)/u.exec(plain)?.[1];
  if (markdown !== undefined) {
    return markdown;
  }
  return /Current model\s*[:│]\s*([^\s]+)/u.exec(plain)?.[1] ?? null;
}

function truncateCell(value: string): string {
  return value.length <= SQL_TABLE_CELL_CHARACTER_LIMIT
    ? value
    : `${value.slice(0, SQL_TABLE_CELL_CHARACTER_LIMIT - 3)}...`;
}

function toTableCell(value: unknown): TableCell {
  if (value === null || value === undefined) {
    return { kind: "null" };
  }
  if (typeof value === "boolean") {
    return { kind: "boolean", value };
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return { kind: "number", value };
  }
  if (typeof value === "string") {
    return { kind: "text", value: truncateCell(value) };
  }
  const serialized = JSON.stringify(value);
  return {
    kind: "text",
    value: truncateCell(serialized === undefined ? String(value) : serialized),
  };
}

class BridgeSession {
  readonly threadId: string;
  readonly providerThreadId: string;
  readonly #client: SqlSaberRpcClient;
  #state: SessionState = { kind: "idle" };
  #usageTotal: ThreadEventTokenUsageBreakdown = { ...ZERO_TOKEN_USAGE };
  #thinkingLevel: string;

  private constructor(args: {
    threadId: string;
    providerThreadId: string;
    client: SqlSaberRpcClient;
  }) {
    this.threadId = args.threadId;
    this.providerThreadId = args.providerThreadId;
    this.#client = args.client;
    this.#thinkingLevel = args.client.ready.thinkingLevel;
  }

  static async open(args: {
    threadId: string;
    providerThreadId: string;
    cwd: string;
    env: Readonly<Record<string, string>>;
    resumeThreadId: string | null;
    signal: AbortSignal;
  }): Promise<BridgeSession> {
    let session: BridgeSession | null = null;
    let earlyFailure: Error | null = null;
    const executable = await resolveSqlSaberExecutable();
    if (executable === null) {
      throw new Error(
        `SQLSaber is not installed. Install it or set ${SQLSABER_EXECUTABLE_ENV}.`,
      );
    }
    const client = await SqlSaberRpcClient.launch({
      executable,
      cwd: args.cwd,
      env: args.env,
      resumeThreadId: args.resumeThreadId,
      recordingThreadId: args.threadId,
      signal: args.signal,
      callbacks: {
        onEvent: (event) => session?.handleEvent(event),
        onUnknown: (payload) => {
          if (session !== null) {
            notify(BRIDGE_NOTIFICATION_METHODS.providerRaw, {
              threadId: session.threadId,
              coverage: "unknown",
              payload,
            });
          }
        },
        onFatal: (error) => {
          if (session === null) {
            earlyFailure = error;
          } else {
            session.handleFatal(error);
          }
        },
      },
    });
    if (earlyFailure !== null) {
      client.forceTerminate();
      throw earlyFailure;
    }
    if (args.signal.aborted) {
      client.forceTerminate();
      throw new Error("SQLSaber provider bridge is stopping");
    }
    session = new BridgeSession({
      threadId: args.threadId,
      providerThreadId: args.providerThreadId,
      client,
    });
    return session;
  }

  get isRunning(): boolean {
    return this.#state.kind === "running";
  }

  get isClosed(): boolean {
    return this.#state.kind === "closed";
  }

  get activeTurnId(): string | null {
    return this.#state.kind === "running"
      ? this.#state.turn.providerTurnId
      : null;
  }

  get sessionRestorable(): boolean {
    return this.#client.ready.threadPersistence;
  }

  beginTurn(args: {
    text: string;
    clientRequestId?: string;
    reasoningLevel: BridgeExecutionOptions["reasoningLevel"];
  }): void {
    if (this.#state.kind !== "idle") {
      throw new Error("SQLSaber already has an active turn");
    }
    const turn: ActiveTurn = {
      providerTurnId: `turn_${randomUUID().replaceAll("-", "")}`,
      messageOrdinal: 0,
      streams: new Map(),
      tools: new Map(),
      pendingSql: new Map(),
      queryResults: new Map(),
      done: createDeferred(),
      suppressed: false,
    };
    this.#state = { kind: "running", turn };
    const deltas: ThreadDelta[] = [
      ...(args.clientRequestId === undefined
        ? []
        : [
            {
              kind: "input.accepted" as const,
              clientRequestId: args.clientRequestId,
              providerTurnId: turn.providerTurnId,
            },
          ]),
      { kind: "turn.open", providerTurnId: turn.providerTurnId },
    ];
    this.#emit(turn, deltas);
    void this.#startSqlSaberTurn(turn, args.text, args.reasoningLevel);
  }

  async steer(args: {
    text: string;
    clientRequestId: string;
    expectedTurnId: string;
  }): Promise<void> {
    if (
      this.#state.kind !== "running" ||
      this.#state.turn.providerTurnId !== args.expectedTurnId
    ) {
      throw new Error(
        `No active SQLSaber turn matching ${args.expectedTurnId}`,
      );
    }
    const turn = this.#state.turn;
    await this.#client.command("steer", { message: args.text }, undefined, () => {
      if (this.#isCurrent(turn)) {
        this.#emit(turn, [
          {
            kind: "input.accepted",
            clientRequestId: args.clientRequestId,
            providerTurnId: turn.providerTurnId,
          },
        ]);
      }
    });
  }

  async interrupt(): Promise<void> {
    const running = this.#state.kind === "running" ? this.#state.turn : null;
    if (running !== null) {
      try {
        await this.#client.command("abort");
      } catch (cause) {
        this.#failTurn(running, cause instanceof Error ? cause : new Error(String(cause)));
      }
      await running.done.promise;
    }
    if (this.#state.kind !== "closed") {
      this.#state = { kind: "closed" };
      await this.#client.terminate();
    }
  }

  release(): void {
    if (this.#state.kind === "running") {
      this.#state.turn.suppressed = true;
      this.#state.turn.done.resolve();
    }
    this.#state = { kind: "closed" };
    this.#client.forceTerminate();
  }

  handleEvent(event: SqlSaberEvent): void {
    if (this.#state.kind !== "running") {
      return;
    }
    const turn = this.#state.turn;
    switch (event.type) {
      case "agent_start":
      case "message_end":
      case "queue_update":
        return;
      case "message_start":
        turn.messageOrdinal += 1;
        return;
      case "message_update":
        this.#handleMessageUpdate(turn, event.assistantMessageEvent);
        return;
      case "sql_update": {
        if (event.toolCallId === undefined) {
          return;
        }
        turn.pendingSql.set(event.toolCallId, event.sql);
        const tool = turn.tools.get(event.toolCallId);
        if (tool !== undefined) {
          this.#emit(turn, [
            {
              kind: "item.progress",
              key: { providerItemId: tool.key },
              providerTurnId: turn.providerTurnId,
              message: event.sql,
            },
          ]);
        }
        return;
      }
      case "tool_execution_start":
        this.#openTool(turn, event);
        return;
      case "tool_execution_end":
        this.#closeTool(turn, event);
        return;
      case "agent_end":
        this.#closeStreams(turn);
        if (event.status === "completed") {
          for (const result of event.queryResults) {
            turn.queryResults.set(result.id, result);
          }
          if (event.threadId !== null && this.sessionRestorable) {
            try {
              saveResumeRecord({
                providerThreadId: this.providerThreadId,
                sqlsaberThreadId: event.threadId,
              });
            } catch (cause) {
              this.#emit(turn, [
                {
                  kind: "provider.warning",
                  category: "general",
                  summary: "Could not save SQLSaber resume data",
                  details:
                    cause instanceof Error ? cause.message : String(cause),
                  vouchedTurn: true,
                },
              ]);
            }
          }
          void this.#completeTurn(turn, event.usage);
          return;
        }
        if (event.status === "aborted") {
          this.#settleTurn(turn, "interrupted");
          return;
        }
        this.#failTurn(turn, new Error(event.error));
    }
  }

  handleFatal(error: Error): void {
    if (this.#state.kind === "running") {
      this.#failTurn(this.#state.turn, error);
    }
    this.#state = { kind: "closed" };
  }

  async #startSqlSaberTurn(
    turn: ActiveTurn,
    text: string,
    reasoningLevel: BridgeExecutionOptions["reasoningLevel"],
  ): Promise<void> {
    try {
      const desired = desiredThinkingLevel(reasoningLevel);
      if (desired !== null && desired !== this.#thinkingLevel) {
        await this.#client.command("set_thinking_level", { level: desired });
        this.#thinkingLevel = desired;
      }
      await this.#client.command("prompt", { message: text });
    } catch (cause) {
      this.#failTurn(
        turn,
        cause instanceof Error ? cause : new Error(String(cause)),
      );
    }
  }

  #handleMessageUpdate(
    turn: ActiveTurn,
    event: Extract<SqlSaberEvent, { type: "message_update" }>["assistantMessageEvent"],
  ): void {
    switch (event.type) {
      case "text_start":
        this.#openStream(turn, "agentMessage", event.contentIndex);
        return;
      case "text_delta":
        this.#appendStream(turn, "agentMessage", event.contentIndex, event.delta);
        return;
      case "text_end":
        this.#closeStream(turn, "agentMessage", event.contentIndex, event.content);
        return;
      case "thinking_start":
        this.#openStream(turn, "reasoningText", event.contentIndex);
        return;
      case "thinking_delta":
        this.#appendStream(turn, "reasoningText", event.contentIndex, event.delta);
        return;
      case "thinking_end":
        this.#closeStream(turn, "reasoningText", event.contentIndex, event.content);
        return;
      case "toolcall_start":
      case "toolcall_delta":
      case "toolcall_end":
        return;
    }
  }

  #streamId(turn: ActiveTurn, channel: TextChannel, contentIndex: number): string {
    return `${turn.providerTurnId}:message:${turn.messageOrdinal}:${channel}:${contentIndex}`;
  }

  #openStream(turn: ActiveTurn, channel: TextChannel, contentIndex: number): StreamState {
    const id = this.#streamId(turn, channel, contentIndex);
    const existing = turn.streams.get(id);
    if (existing !== undefined) {
      return existing;
    }
    const stream: StreamState = { key: id, channel, text: "" };
    turn.streams.set(id, stream);
    this.#emit(turn, [
      {
        kind: "item.open",
        key: { providerItemId: id },
        providerTurnId: turn.providerTurnId,
        item:
          channel === "agentMessage"
            ? { type: "agentMessage", text: "" }
            : { type: "reasoning", content: [], summary: [] },
        presentation:
          channel === "agentMessage"
            ? AGENT_MESSAGE_PRESENTATION
            : REASONING_PRESENTATION,
      },
    ]);
    return stream;
  }

  #appendStream(
    turn: ActiveTurn,
    channel: TextChannel,
    contentIndex: number,
    text: string,
  ): void {
    if (text === "") {
      return;
    }
    const stream = this.#openStream(turn, channel, contentIndex);
    stream.text += text;
    this.#emit(turn, [
      {
        kind: "item.textDelta",
        key: { providerItemId: stream.key },
        providerTurnId: turn.providerTurnId,
        channel,
        text,
      },
    ]);
  }

  #closeStream(
    turn: ActiveTurn,
    channel: TextChannel,
    contentIndex: number,
    text: string,
  ): void {
    const stream = this.#openStream(turn, channel, contentIndex);
    stream.text = text;
    this.#emit(turn, [
      {
        kind: "item.textClose",
        key: { providerItemId: stream.key },
        providerTurnId: turn.providerTurnId,
        channel,
        text,
      },
    ]);
    turn.streams.delete(stream.key);
  }

  #closeStreams(turn: ActiveTurn): void {
    const deltas: ThreadDelta[] = [];
    for (const stream of turn.streams.values()) {
      deltas.push({
        kind: "item.textClose",
        key: { providerItemId: stream.key },
        providerTurnId: turn.providerTurnId,
        channel: stream.channel,
        text: stream.text,
      });
    }
    turn.streams.clear();
    this.#emit(turn, deltas);
  }

  #toolKey(turn: ActiveTurn, toolCallId: string): string {
    return `${turn.providerTurnId}:tool:${toolCallId}`;
  }

  #openTool(
    turn: ActiveTurn,
    event: Extract<SqlSaberEvent, { type: "tool_execution_start" }>,
  ): void {
    const tool: ToolState = {
      key: this.#toolKey(turn, event.toolCallId),
      name: event.toolName,
      args: event.args,
      presentation: toolPresentation(event.toolName),
    };
    turn.tools.set(event.toolCallId, tool);
    const deltas: ThreadDelta[] = [
      {
        kind: "item.open",
        key: { providerItemId: tool.key },
        providerTurnId: turn.providerTurnId,
        item: { type: "tool", tool: tool.name, args: tool.args },
        presentation: tool.presentation,
      },
    ];
    const sql = turn.pendingSql.get(event.toolCallId);
    if (sql !== undefined) {
      deltas.push({
        kind: "item.progress",
        key: { providerItemId: tool.key },
        providerTurnId: turn.providerTurnId,
        message: sql,
      });
    }
    this.#emit(turn, deltas);
  }

  #closeTool(
    turn: ActiveTurn,
    event: Extract<SqlSaberEvent, { type: "tool_execution_end" }>,
  ): void {
    const tool = turn.tools.get(event.toolCallId) ?? {
      key: this.#toolKey(turn, event.toolCallId),
      name: event.toolName,
      args: {},
      presentation: toolPresentation(event.toolName),
    };
    if (!turn.tools.has(event.toolCallId)) {
      this.#emit(turn, [
        {
          kind: "item.open",
          key: { providerItemId: tool.key },
          providerTurnId: turn.providerTurnId,
          item: { type: "tool", tool: tool.name, args: tool.args },
          presentation: tool.presentation,
        },
      ]);
    }
    const resultText = extractResultText(event.result);
    this.#emit(turn, [
      {
        kind: "item.close",
        key: { providerItemId: tool.key },
        providerTurnId: turn.providerTurnId,
        status: event.isError ? "failed" : "completed",
        resultText,
        item: {
          type: "tool",
          tool: tool.name,
          args: tool.args,
          ...(event.isError ? { error: resultText } : { result: event.result }),
        },
        presentation: tool.presentation,
      },
    ]);
    turn.tools.delete(event.toolCallId);
    turn.pendingSql.delete(event.toolCallId);
    if (event.queryResult !== undefined) {
      turn.queryResults.set(event.queryResult.id, event.queryResult);
    }
  }

  #closeOpenTools(
    turn: ActiveTurn,
    status: "failed" | "interrupted",
    resultText: string,
  ): void {
    const deltas: ThreadDelta[] = [];
    for (const tool of turn.tools.values()) {
      deltas.push({
        kind: "item.close",
        key: { providerItemId: tool.key },
        providerTurnId: turn.providerTurnId,
        status,
        resultText,
        item: {
          type: "tool",
          tool: tool.name,
          args: tool.args,
          ...(status === "failed" ? { error: resultText } : {}),
        },
        presentation: tool.presentation,
      });
    }
    turn.tools.clear();
    turn.pendingSql.clear();
    this.#emit(turn, deltas);
  }

  async #completeTurn(
    turn: ActiveTurn,
    usage: Extract<SqlSaberEvent, { type: "agent_end"; status: "completed" }>["usage"],
  ): Promise<void> {
    if (usage !== null && this.#isCurrent(turn)) {
      const cachedInputTokens =
        usage.cacheReadTokens + usage.cacheWriteTokens;
      const last: ThreadEventTokenUsageBreakdown = {
        ...ZERO_TOKEN_USAGE,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cachedInputTokens,
        totalTokens:
          usage.inputTokens + usage.outputTokens + cachedInputTokens,
      };
      this.#usageTotal = addTokenUsage(this.#usageTotal, last);
      this.#emit(turn, [
        {
          kind: "usage",
          providerTurnId: turn.providerTurnId,
          total: this.#usageTotal,
          last,
          modelContextWindow: null,
        },
        {
          kind: "contextWindow",
          providerTurnId: turn.providerTurnId,
          used: usage.contextTokens,
          size: null,
          estimated: false,
          attach: "open",
        },
      ]);
    }

    for (const descriptor of turn.queryResults.values()) {
      if (!this.#isCurrent(turn)) {
        return;
      }
      try {
        const payload = await this.#loadTable(descriptor);
        if (!this.#isCurrent(turn)) {
          return;
        }
        const key = `${turn.providerTurnId}:query-result:${descriptor.id}`;
        const item = {
          type: "extension" as const,
          kind: QUERY_RESULT_KIND,
          payload,
        };
        this.#emit(turn, [
          {
            kind: "item.open",
            key: { providerItemId: key },
            providerTurnId: turn.providerTurnId,
            item,
            presentation: TABLE_PRESENTATION,
          },
          {
            kind: "item.close",
            key: { providerItemId: key },
            providerTurnId: turn.providerTurnId,
            status: "completed",
            item,
            presentation: TABLE_PRESENTATION,
          },
        ]);
      } catch (cause) {
        this.#emit(turn, [
          {
            kind: "provider.warning",
            category: "general",
            summary: "Could not load the SQL result table",
            details: cause instanceof Error ? cause.message : String(cause),
            vouchedTurn: true,
          },
        ]);
      }
    }
    this.#settleTurn(turn, "completed");
  }

  async #loadTable(descriptor: QueryResultDescriptor): Promise<SqlTablePayload> {
    const sourceColumns = descriptor.columns.slice(0, SQL_TABLE_COLUMN_LIMIT);
    const rowLimit = Math.max(
      1,
      Math.min(
        SQL_TABLE_ROW_LIMIT,
        Math.floor(
          SQL_TABLE_CELL_LIMIT / Math.max(sourceColumns.length, 1),
        ),
      ),
    );
    const response = await this.#client.command("get_query_result", {
      resultId: descriptor.id,
      offset: 0,
      limit: rowLimit,
    });
    if (!response.success) {
      throw new Error(response.error);
    }
    const page = queryResultPageSchema.parse(response.data);
    if (page.result.id !== descriptor.id || page.offset !== 0) {
      throw new Error("SQLSaber returned a mismatched query-result page");
    }
    const databaseName =
      page.result.databaseName ?? descriptor.databaseName ?? null;
    const rows = page.rows.slice(0, rowLimit);
    return sqlTablePayloadSchema.parse({
      resultId: descriptor.id,
      databaseName:
        databaseName === null ? null : truncateCell(databaseName),
      columns: sourceColumns.map(truncateCell),
      columnCount: descriptor.columns.length,
      rows: rows.map((row) =>
        sourceColumns.map((column) => toTableCell(row[column])),
      ),
      rowCount: descriptor.rowCount,
      truncated:
        page.hasMore ||
        page.rows.length > rowLimit ||
        rows.length < descriptor.rowCount ||
        sourceColumns.length < descriptor.columns.length,
    });
  }

  #failTurn(turn: ActiveTurn, error: Error): void {
    if (!this.#isCurrent(turn)) {
      return;
    }
    this.#closeStreams(turn);
    this.#closeOpenTools(turn, "failed", error.message);
    this.#emit(turn, [
      {
        kind: "provider.error",
        providerTurnId: turn.providerTurnId,
        message: "SQLSaber turn failed",
        detail: error.message,
        errorInfo: {
          category: "unknown",
          httpStatusCode: null,
          providerCode: null,
        },
      },
      {
        kind: "turn.boundary",
        providerTurnId: turn.providerTurnId,
        status: "failed",
        error: { message: error.message },
      },
    ]);
    this.#state = { kind: "idle" };
    turn.done.resolve();
  }

  #settleTurn(
    turn: ActiveTurn,
    status: "completed" | "interrupted",
  ): void {
    if (!this.#isCurrent(turn)) {
      return;
    }
    if (turn.tools.size > 0) {
      this.#closeOpenTools(
        turn,
        status === "interrupted" ? "interrupted" : "failed",
        status === "interrupted"
          ? "SQLSaber was interrupted"
          : "SQLSaber ended without reporting a tool result",
      );
    }
    this.#emit(turn, [
      {
        kind: "turn.boundary",
        providerTurnId: turn.providerTurnId,
        status,
        claimIfIdle: true,
      },
    ]);
    this.#state = { kind: "idle" };
    turn.done.resolve();
  }

  #isCurrent(turn: ActiveTurn): boolean {
    return (
      this.#state.kind === "running" &&
      this.#state.turn === turn &&
      !turn.suppressed
    );
  }

  #emit(turn: ActiveTurn, deltas: ThreadDelta[]): void {
    if (!turn.suppressed) {
      emitDeltas(this.threadId, deltas);
    }
  }
}

async function openSession(args: {
  threadId: string;
  providerThreadId: string;
  cwd: string;
  options: BridgeExecutionOptions;
  resumeThreadId: string | null;
}): Promise<BridgeSession> {
  const signal = bridgeAbortController?.signal;
  if (signal === undefined || signal.aborted) {
    throw new Error("SQLSaber provider bridge is not running");
  }
  const existing = sessions.get(args.threadId);
  if (existing !== undefined) {
    existing.release();
    sessions.delete(args.threadId);
  }
  const session = await BridgeSession.open({
    threadId: args.threadId,
    providerThreadId: args.providerThreadId,
    cwd: args.cwd,
    env: args.options.envVars ?? {},
    resumeThreadId: args.resumeThreadId,
    signal,
  });
  sessions.set(args.threadId, session);
  notify(BRIDGE_NOTIFICATION_METHODS.threadIdentity, {
    threadId: args.threadId,
    providerThreadId: args.providerThreadId,
    sessionRestorable: session.sessionRestorable,
  });
  emitDeltas(args.threadId, [{ kind: "session.reset" }]);
  return session;
}

const SQLSABER_NOT_INSTALLED: ProviderHealthResult = {
  supported: true,
  health: {
    status: "not_installed",
    statusMessage: "Install SQLSaber or set SQLSABER_EXECUTABLE on this machine.",
    accountEmail: null,
    planLabel: null,
    installedVersion: null,
    minimumSupportedVersion: MINIMUM_SQLSABER_VERSION,
    canInstall: false,
    canUpdate: false,
    loginCommand: null,
  },
};

type RequestHandler = (
  id: JsonRpcId,
  params: unknown,
) => void | Promise<void>;

const handlers: Record<string, RequestHandler> = {
  [BRIDGE_REQUEST_METHODS.initialize]: (id, params) => {
    const parsed = initializeParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(id, BRIDGE_REQUEST_METHODS.initialize, parsed.error.issues);
      return;
    }
    io.sendResult(id, {
      protocolVersion: PROVIDER_BRIDGE_PROTOCOL_VERSION,
      capabilities: {
        grammarVersions: [THREAD_DELTA_GRAMMAR_V3, THREAD_DELTA_GRAMMAR_V3],
        sessionRestore: true,
        threadArchive: false,
        threadRename: false,
        threadGoalClear: false,
        fork: "none",
        approvalEnforcedBy: "provider",
        steerMode: "queue",
        skills: { configure: false },
      },
    });
  },

  [BRIDGE_REQUEST_METHODS.modelList]: async (id, params) => {
    const parsed = modelListParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(id, BRIDGE_REQUEST_METHODS.modelList, parsed.error.issues);
      return;
    }
    const executable = await resolveSqlSaberExecutable();
    const configured =
      executable === null ? null : await configuredModelName(executable);
    io.sendResult(id, {
      models: [
        {
          ...CONFIGURED_MODEL,
          model: CONFIGURED_MODEL_ID,
          displayName:
            configured === null
              ? CONFIGURED_MODEL.displayName
              : `SQLSaber · ${configured}`,
          description:
            configured === null
              ? CONFIGURED_MODEL.description
              : `Current SQLSaber model. Change it with \`sqlsaber models set\`.`,
        },
      ],
      selectedOnlyModels: [],
    });
  },

  [BRIDGE_REQUEST_METHODS.providerHealth]: async (id, params) => {
    const parsed = providerMaintenanceParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(
        id,
        BRIDGE_REQUEST_METHODS.providerHealth,
        parsed.error.issues,
      );
      return;
    }
    const executable = await resolveSqlSaberExecutable();
    if (executable === null) {
      io.sendResult(id, SQLSABER_NOT_INSTALLED);
      return;
    }
    const version = await readCliVersion(executable);
    const unsupported =
      version !== null && compareVersions(version, MINIMUM_SQLSABER_VERSION) < 0;
    io.sendResult(id, {
      supported: true,
      health: {
        status: unsupported ? "unsupported_version" : "ready",
        statusMessage: unsupported
          ? `SQLSaber ${MINIMUM_SQLSABER_VERSION} or newer is required.`
          : null,
        accountEmail: null,
        planLabel: null,
        installedVersion: version,
        minimumSupportedVersion: MINIMUM_SQLSABER_VERSION,
        canInstall: false,
        canUpdate: false,
        loginCommand: null,
      },
    } satisfies ProviderHealthResult);
  },

  [BRIDGE_REQUEST_METHODS.threadStart]: async (id, params) => {
    const parsed = threadStartParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(
        id,
        BRIDGE_REQUEST_METHODS.threadStart,
        parsed.error.issues,
      );
      return;
    }
    const optionError = executionOptionError(parsed.data.options);
    if (optionError !== null) {
      io.sendError(id, BRIDGE_JSON_RPC_ERRORS.INVALID_PARAMS, optionError);
      return;
    }
    let initialText: string | null = null;
    if (parsed.data.input !== undefined && parsed.data.input.length > 0) {
      const prompt = promptText(parsed.data.input);
      if (!prompt.ok) {
        io.sendError(id, BRIDGE_JSON_RPC_ERRORS.INVALID_PARAMS, prompt.error);
        return;
      }
      initialText = prompt.text;
    }
    const providerThreadId = makeProviderThreadId();
    saveResumeRecord({ providerThreadId, sqlsaberThreadId: null });
    try {
      const session = await openSession({
        threadId: parsed.data.threadId,
        providerThreadId,
        cwd: parsed.data.cwd,
        options: parsed.data.options,
        resumeThreadId: null,
      });
      io.sendResult(id, {
        providerThreadId,
        sessionRestorable: session.sessionRestorable,
      });
      if (initialText !== null) {
        session.beginTurn({
          text: initialText,
          reasoningLevel: parsed.data.options.reasoningLevel,
        });
      }
    } catch (cause) {
      deleteResumeRecord(providerThreadId);
      throw cause;
    }
  },

  [BRIDGE_REQUEST_METHODS.threadResume]: async (id, params) => {
    const parsed = threadResumeParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(
        id,
        BRIDGE_REQUEST_METHODS.threadResume,
        parsed.error.issues,
      );
      return;
    }
    const optionError = executionOptionError(parsed.data.options);
    if (optionError !== null) {
      io.sendError(id, BRIDGE_JSON_RPC_ERRORS.INVALID_PARAMS, optionError);
      return;
    }
    const record = loadResumeRecord(parsed.data.providerThreadId);
    if (record === null) {
      io.sendError(
        id,
        BRIDGE_JSON_RPC_ERRORS.SESSION_NOT_RESTORABLE,
        `SQLSaber session ${parsed.data.providerThreadId} cannot be restored`,
      );
      return;
    }
    const session = await openSession({
      threadId: parsed.data.threadId,
      providerThreadId: parsed.data.providerThreadId,
      cwd: parsed.data.cwd,
      options: parsed.data.options,
      resumeThreadId: record.sqlsaberThreadId,
    });
    io.sendResult(id, {
      providerThreadId: parsed.data.providerThreadId,
      sessionRestorable: session.sessionRestorable,
    });
  },

  [BRIDGE_REQUEST_METHODS.turnStart]: (id, params) => {
    const parsed = turnStartParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(id, BRIDGE_REQUEST_METHODS.turnStart, parsed.error.issues);
      return;
    }
    const optionError = executionOptionError(parsed.data.options);
    if (optionError !== null) {
      io.sendError(id, BRIDGE_JSON_RPC_ERRORS.INVALID_PARAMS, optionError);
      return;
    }
    const session = sessions.get(parsed.data.threadId);
    if (
      session === undefined ||
      session.providerThreadId !== parsed.data.providerThreadId ||
      session.isClosed
    ) {
      io.sendError(
        id,
        BRIDGE_JSON_RPC_ERRORS.INVALID_PARAMS,
        `No SQLSaber session for thread ${parsed.data.threadId}`,
      );
      return;
    }
    if (session.isRunning) {
      io.sendError(
        id,
        BRIDGE_JSON_RPC_ERRORS.INVALID_PARAMS,
        "SQLSaber already has an active turn",
      );
      return;
    }
    const prompt = promptText(parsed.data.input);
    if (!prompt.ok) {
      io.sendError(id, BRIDGE_JSON_RPC_ERRORS.INVALID_PARAMS, prompt.error);
      return;
    }
    session.beginTurn({
      text: prompt.text,
      clientRequestId: parsed.data.clientRequestId,
      reasoningLevel: parsed.data.options.reasoningLevel,
    });
    io.sendResult(id, {});
  },

  [BRIDGE_REQUEST_METHODS.turnSteer]: async (id, params) => {
    const parsed = turnSteerParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(id, BRIDGE_REQUEST_METHODS.turnSteer, parsed.error.issues);
      return;
    }
    const optionError = executionOptionError(parsed.data.options);
    if (optionError !== null) {
      io.sendError(id, BRIDGE_JSON_RPC_ERRORS.INVALID_PARAMS, optionError);
      return;
    }
    const session = sessions.get(parsed.data.threadId);
    if (
      session === undefined ||
      session.providerThreadId !== parsed.data.providerThreadId ||
      !session.isRunning
    ) {
      io.sendError(
        id,
        BRIDGE_JSON_RPC_ERRORS.NO_ACTIVE_TURN,
        `No active SQLSaber turn to steer (expected ${parsed.data.expectedTurnId})`,
      );
      return;
    }
    const prompt = promptText(parsed.data.input);
    if (!prompt.ok) {
      io.sendError(id, BRIDGE_JSON_RPC_ERRORS.INVALID_PARAMS, prompt.error);
      return;
    }
    try {
      await session.steer({
        text: prompt.text,
        clientRequestId: parsed.data.clientRequestId,
        expectedTurnId: parsed.data.expectedTurnId,
      });
      io.sendResult(id, {});
    } catch (cause) {
      io.sendError(
        id,
        BRIDGE_JSON_RPC_ERRORS.NO_ACTIVE_TURN,
        cause instanceof Error ? cause.message : String(cause),
      );
    }
  },

  [BRIDGE_REQUEST_METHODS.threadStop]: async (id, params) => {
    const parsed = threadStopParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(id, BRIDGE_REQUEST_METHODS.threadStop, parsed.error.issues);
      return;
    }
    const session = sessions.get(parsed.data.threadId);
    if (
      session !== undefined &&
      session.providerThreadId !== parsed.data.providerThreadId
    ) {
      io.sendError(
        id,
        BRIDGE_JSON_RPC_ERRORS.INVALID_PARAMS,
        `SQLSaber session identity does not match thread ${parsed.data.threadId}`,
      );
      return;
    }
    if (
      session !== undefined &&
      parsed.data.intent === "interrupt" &&
      parsed.data.activeTurnId !== null &&
      session.activeTurnId !== null &&
      session.activeTurnId !== parsed.data.activeTurnId
    ) {
      io.sendError(
        id,
        BRIDGE_JSON_RPC_ERRORS.NO_ACTIVE_TURN,
        `No active SQLSaber turn matching ${parsed.data.activeTurnId}`,
      );
      return;
    }
    if (session !== undefined) {
      if (parsed.data.intent === "interrupt") {
        await session.interrupt();
      } else {
        session.release();
      }
      sessions.delete(parsed.data.threadId);
    }
    io.sendResult(id, {});
  },

  [BRIDGE_REQUEST_METHODS.threadDiscard]: (id, params) => {
    const parsed = threadDiscardParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(
        id,
        BRIDGE_REQUEST_METHODS.threadDiscard,
        parsed.error.issues,
      );
      return;
    }
    const session = sessions.get(parsed.data.threadId);
    if (
      session !== undefined &&
      session.providerThreadId !== parsed.data.providerThreadId
    ) {
      io.sendError(
        id,
        BRIDGE_JSON_RPC_ERRORS.INVALID_PARAMS,
        `SQLSaber session identity does not match thread ${parsed.data.threadId}`,
      );
      return;
    }
    session?.release();
    sessions.delete(parsed.data.threadId);
    deleteResumeRecord(parsed.data.providerThreadId);
    io.sendResult(id, {});
  },
};

function handleParsedMessage(message: unknown): void {
  if (typeof message !== "object" || message === null || Array.isArray(message)) {
    return;
  }
  const record = z.record(z.string(), z.unknown()).parse(message);
  const id = record.id;
  const method = record.method;
  if (typeof method !== "string") {
    return;
  }
  if (typeof id !== "string" && typeof id !== "number") {
    return;
  }
  const handler = handlers[method];
  if (handler === undefined) {
    io.sendError(
      id,
      BRIDGE_JSON_RPC_ERRORS.METHOD_NOT_FOUND,
      `Method not found: ${method}`,
    );
    return;
  }
  runBridgeRequest({
    request: { id, method, params: record.params },
    sendError: io.sendError,
    handleRequest: async (request) => handler(request.id, request.params),
  });
}

export const handleLine = createBridgeLineHandler({ handleParsedMessage });

export function closeBridgeSessions(): void {
  for (const session of sessions.values()) {
    session.release();
  }
  sessions.clear();
}

function stopBridge(): void {
  bridgeAbortController?.abort();
  bridgeAbortController = null;
  closeBridgeSessions();
  resumeRecords.clear();
  bridgeDataDir = null;
}

export const experimental_providerBridge = experimental_defineProviderBridge({
  handleLine,
  start(context) {
    stopBridge();
    bridgeAbortController = new AbortController();
    bridgeDataDir = context.dataDir;
  },
  onClose: stopBridge,
  onSigterm: stopBridge,
  onSigint: stopBridge,
});
