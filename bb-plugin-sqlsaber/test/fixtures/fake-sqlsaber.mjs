#!/usr/bin/env node

import { createInterface } from "node:readline";

const args = process.argv.slice(2);

if (args[0] === "--version") {
  process.stdout.write("0.77.0\n");
  process.exit(0);
}

if (args[0] === "models" && args[1] === "current") {
  process.stdout.write("- **Current model**: fake:sql-model\n- **Thinking**: enabled (medium)\n");
  process.exit(0);
}

if (args[0] !== "rpc") {
  process.stderr.write("unsupported fake SQLSaber command\n");
  process.exit(2);
}

const threadFlag = args.indexOf("--thread");
const sqlsaberThreadId =
  threadFlag === -1 ? "fake-sqlsaber-thread" : (args[threadFlag + 1] ?? "fake-sqlsaber-thread");
let thinkingLevel = "medium";
let running = null;
let turnCounter = 0;

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function response(command, id, data) {
  send({ type: "response", command, success: true, ...(data === undefined ? {} : { data }), id });
}

function queryResultDescriptor(turn) {
  return {
    id: `qr_${String(turn).padStart(32, "0")}`,
    file: `query-${turn}.json`,
    rowCount: 2,
    columns: ["name", "total", "active", "metadata"],
    size: 256,
    sha256: "a".repeat(64),
    mediaType: "application/vnd.sqlsaber.query-result+json",
    databaseName: "fixture",
  };
}

function finishCompleted(text, withTable) {
  const active = running;
  if (active === null) return;
  const descriptor = queryResultDescriptor(active.turn);
  if (withTable) {
    send({ type: "message_start" });
    send({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_start", contentIndex: 0 },
    });
    send({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "Checking the schema" },
    });
    send({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: "Checking the schema" },
    });
    send({ type: "sql_update", toolCallId: `tool-${active.turn}`, sql: "SELECT name, total, active, metadata FROM sales" });
    send({
      type: "tool_execution_start",
      toolCallId: `tool-${active.turn}`,
      toolName: "execute_sql",
      args: { query: "SELECT name, total, active, metadata FROM sales" },
    });
    send({
      type: "tool_execution_end",
      toolCallId: `tool-${active.turn}`,
      toolName: "execute_sql",
      result: { row_count: 2, preview_rows: 2 },
      isError: false,
      queryResult: descriptor,
    });
  }
  send({ type: "message_start" });
  send({
    type: "message_update",
    assistantMessageEvent: { type: "text_start", contentIndex: 0 },
  });
  const midpoint = Math.floor(text.length / 2);
  send({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text.slice(0, midpoint) },
  });
  send({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text.slice(midpoint) },
  });
  send({
    type: "message_update",
    assistantMessageEvent: { type: "text_end", contentIndex: 0, content: text },
  });
  send({ type: "message_end", message: { role: "assistant", content: [] } });
  send({
    type: "agent_end",
    status: "completed",
    text,
    messages: [],
    usage: {
      inputTokens: 11,
      outputTokens: 7,
      cacheReadTokens: 3,
      cacheWriteTokens: 1,
      requests: withTable ? 2 : 1,
      toolCalls: withTable ? 1 : 0,
      contextTokens: 21,
    },
    queryResults: withTable ? [descriptor] : [],
    artifacts: [],
    threadId: sqlsaberThreadId,
  });
  running = null;
}

send({
  type: "ready",
  protocolVersion: 1,
  state: "idle",
  database: { name: "fixture", type: "SQLite", names: ["fixture"] },
  model: { name: "fake:sql-model", id: "fake:sql-model" },
  thinkingLevel,
  thinkingLevels: ["off", "minimal", "low", "medium", "high", "maximum"],
  dangerousMode: false,
  csvToolResults: false,
  threadId: threadFlag === -1 ? null : sqlsaberThreadId,
  threadPersistence: true,
  messageCount: threadFlag === -1 ? 0 : 2,
  pendingSteers: [],
});

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  if (line.trim() === "") return;
  const command = JSON.parse(line);
  switch (command.type) {
    case "set_thinking_level":
      thinkingLevel = command.level;
      response("set_thinking_level", command.id, { thinkingLevel });
      return;
    case "prompt": {
      turnCounter += 1;
      running = { turn: turnCounter, text: command.message };
      response("prompt", command.id);
      send({ type: "agent_start", promptId: command.id });
      if (command.message.includes("/noop")) {
        send({
          type: "agent_end",
          status: "completed",
          text: "",
          messages: [],
          usage: null,
          queryResults: [],
          artifacts: [],
          threadId: sqlsaberThreadId,
        });
        running = null;
      } else if (command.message.includes("/error")) {
        setImmediate(() => {
          send({
            type: "agent_end",
            status: "error",
            error: "fixture model failure",
          });
          running = null;
        });
      } else if (command.message.includes("/exit")) {
        send({
          type: "tool_execution_start",
          toolCallId: `tool-${turnCounter}`,
          toolName: "execute_sql",
          args: { query: "SELECT interrupted" },
        });
        setImmediate(() => {
          process.stderr.write("fixture transport failure\n");
          process.exit(23);
        });
      } else if (!command.message.includes("hang")) {
        setImmediate(() => finishCompleted("Two rows matched.", true));
      }
      return;
    }
    case "steer":
      if (running === null) {
        send({ type: "response", command: "steer", success: false, error: "No query is running.", id: command.id });
        return;
      }
      response("steer", command.id, { enqueueId: "steer-1", pendingSteers: [command.message] });
      send({ type: "queue_update", steering: [command.message] });
      finishCompleted(`Steered: ${command.message}`, false);
      return;
    case "abort":
      if (running === null) {
        response("abort", command.id, { aborted: false });
        return;
      }
      send({ type: "agent_end", status: "aborted" });
      running = null;
      response("abort", command.id, { aborted: true });
      return;
    case "get_query_result": {
      const turn = Number(String(command.resultId).slice(3));
      response("get_query_result", command.id, {
        result: queryResultDescriptor(turn),
        offset: command.offset ?? 0,
        limit: command.limit ?? 500,
        rows: [
          { name: "Ada", total: 12.5, active: true, metadata: { region: "west" } },
          { name: "Lin", total: 9, active: false, metadata: null },
        ],
        hasMore: false,
      });
      return;
    }
    case "shutdown":
      if (running !== null) {
        send({ type: "agent_end", status: "aborted" });
        running = null;
      }
      response("shutdown", command.id);
      lines.close();
      process.stdin.unref();
      setImmediate(() => process.exit(0));
      return;
    default:
      send({ type: "response", command: command.type, success: false, error: `Unknown command: ${command.type}`, id: command.id });
  }
});

process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
