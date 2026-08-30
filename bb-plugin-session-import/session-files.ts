export const providerKinds = ["claude-code", "codex", "pi"] as const;
export type ProviderKind = (typeof providerKinds)[number];

export interface SessionMetadata {
  sourceId: string;
  cwd: string;
  title: string;
  model: string | null;
  reasoningLevel: string | null;
  createdAt: number;
  modifiedAt: number;
  messageCount: number;
}

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function timestamp(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 10_000_000_000 ? value * 1000 : value;
  }
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function textContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map((part) => {
      const item = record(part);
      if (!item) return "";
      return typeof item.text === "string"
        ? item.text
        : typeof item.content === "string"
          ? item.content
          : "";
    })
    .filter(Boolean)
    .join("\n");
}

function cleanTitle(value: string): string {
  const compact = value.replace(/\s+/gu, " ").trim();
  if (!compact) return "Untitled CLI session";
  return compact.length > 140 ? `${compact.slice(0, 137)}…` : compact;
}

function parseLines(content: string): JsonRecord[] {
  const rows: JsonRecord[] = [];
  for (const line of content.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    try {
      const parsed = record(JSON.parse(line));
      if (parsed) rows.push(parsed);
    } catch {
      // Session logs are append-only and may end in one incomplete line after
      // a crash. Earlier complete records remain importable.
    }
  }
  return rows;
}

function parseClaude(rows: JsonRecord[]): SessionMetadata {
  let sourceId = "";
  let cwd = "";
  let title = "";
  let model: string | null = null;
  let createdAt = 0;
  let modifiedAt = 0;
  let messageCount = 0;

  for (const row of rows) {
    if (!sourceId && typeof row.sessionId === "string") sourceId = row.sessionId;
    if (!cwd && typeof row.cwd === "string") cwd = row.cwd;
    const at = timestamp(row.timestamp);
    if (at !== null) {
      if (createdAt === 0 || at < createdAt) createdAt = at;
      if (at > modifiedAt) modifiedAt = at;
    }
    if (row.type !== "user" && row.type !== "assistant") continue;
    messageCount += 1;
    const message = record(row.message);
    if (!title && row.type === "user") {
      title = textContent(message?.content ?? row.content);
    }
    if (row.type === "assistant" && typeof message?.model === "string") {
      model = message.model;
    }
  }
  if (!sourceId) throw new Error("This is not a Claude Code session file");
  if (!cwd) throw new Error("Claude Code session has no workspace path");
  return {
    sourceId,
    cwd,
    title: cleanTitle(title),
    model,
    reasoningLevel: null,
    createdAt,
    modifiedAt: modifiedAt || createdAt,
    messageCount,
  };
}

function parseCodex(rows: JsonRecord[]): SessionMetadata {
  let sourceId = "";
  let cwd = "";
  let title = "";
  let model: string | null = null;
  let reasoningLevel: string | null = null;
  let createdAt = 0;
  let modifiedAt = 0;
  let messageCount = 0;

  for (const row of rows) {
    const payload = record(row.payload);
    if (row.type === "session_meta" && payload) {
      const candidate = payload.id ?? payload.session_id;
      if (typeof candidate === "string") sourceId = candidate;
      if (typeof payload.cwd === "string") cwd = payload.cwd;
      const at = timestamp(payload.timestamp ?? row.timestamp);
      if (at !== null) createdAt = at;
    }
    if (row.type === "turn_context" && payload) {
      if (typeof payload.cwd === "string") cwd = payload.cwd;
      if (typeof payload.model === "string") model = payload.model;
      if (typeof payload.effort === "string") reasoningLevel = payload.effort;
    }
    if (row.type === "event_msg" && payload?.type === "user_message") {
      messageCount += 1;
      if (!title && typeof payload.message === "string") title = payload.message;
    }
    const at = timestamp(row.timestamp);
    if (at !== null) modifiedAt = Math.max(modifiedAt, at);
  }
  if (!sourceId) throw new Error("This is not a Codex session file");
  if (!cwd) throw new Error("Codex session has no workspace path");
  return {
    sourceId,
    cwd,
    title: cleanTitle(title),
    model,
    reasoningLevel,
    createdAt,
    modifiedAt: modifiedAt || createdAt,
    messageCount,
  };
}

function parsePi(rows: JsonRecord[]): SessionMetadata {
  const header = rows.find((row) => row.type === "session");
  if (!header || typeof header.id !== "string") {
    throw new Error("This is not a Pi session file");
  }
  if (typeof header.cwd !== "string") throw new Error("Pi session has no workspace path");

  let title = "";
  let model: string | null = null;
  let reasoningLevel: string | null = null;
  let messageCount = 0;
  let modifiedAt = timestamp(header.timestamp) ?? 0;
  for (const row of rows) {
    const at = timestamp(row.timestamp);
    if (at !== null) modifiedAt = Math.max(modifiedAt, at);
    if (row.type === "model_change" && typeof row.modelId === "string") {
      model =
        typeof row.provider === "string" && !row.modelId.includes("/")
          ? `${row.provider}/${row.modelId}`
          : row.modelId;
    }
    if (
      row.type === "thinking_level_change" &&
      typeof row.thinkingLevel === "string"
    ) {
      reasoningLevel = row.thinkingLevel;
    }
    if (row.type !== "message") continue;
    const message = record(row.message);
    if (message?.role === "user" || message?.role === "assistant") messageCount += 1;
    if (!title && message?.role === "user") title = textContent(message.content);
  }
  const createdAt = timestamp(header.timestamp) ?? 0;
  return {
    sourceId: header.id,
    cwd: header.cwd,
    title: cleanTitle(title),
    model,
    reasoningLevel,
    createdAt,
    modifiedAt: modifiedAt || createdAt,
    messageCount,
  };
}

export function parseSessionContent(
  provider: ProviderKind,
  content: string,
): SessionMetadata {
  const rows = parseLines(content);
  if (rows.length === 0) throw new Error("Session file is empty or invalid");
  switch (provider) {
    case "claude-code":
      return parseClaude(rows);
    case "codex":
      return parseCodex(rows);
    case "pi":
      return parsePi(rows);
  }
}

function replaceMatchingKeys(
  value: unknown,
  keys: ReadonlySet<string>,
  sourceId: string,
  targetId: string,
): unknown {
  if (Array.isArray(value)) {
    return value.map((item) =>
      replaceMatchingKeys(item, keys, sourceId, targetId),
    );
  }
  const item = record(value);
  if (!item) return value;
  return Object.fromEntries(
    Object.entries(item).map(([key, child]) => [
      key,
      keys.has(key) && child === sourceId
        ? targetId
        : replaceMatchingKeys(child, keys, sourceId, targetId),
    ]),
  );
}

export function rewriteSessionContent(
  provider: ProviderKind,
  content: string,
  sourceId: string,
  targetId: string,
): string {
  // Pi's bridge deliberately names the managed file after the BB thread while
  // preserving Pi's own session UUID in the header. Claude and Codex resolve
  // by their internal session id, so those ids must follow the new BB-owned
  // target file.
  if (provider === "pi") return content.endsWith("\n") ? content : `${content}\n`;

  const keys =
    provider === "claude-code"
      ? new Set(["sessionId"])
      : new Set(["id", "session_id"]);
  const output: string[] = [];
  for (const line of content.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      output.push(
        JSON.stringify(
          replaceMatchingKeys(parsed, keys, sourceId, targetId),
        ),
      );
    } catch {
      output.push(line);
    }
  }
  return `${output.join("\n")}\n`;
}
