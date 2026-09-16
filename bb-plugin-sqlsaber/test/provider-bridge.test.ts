import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PromptInput } from "@get-bb/plugin-sdk/provider-bridge";
import {
  experimental_captureBridgeJsonRpcOutput as captureBridgeJsonRpcOutput,
  experimental_createBridgeDeltaEventCollector as createBridgeDeltaEventCollector,
  experimental_createBridgeJsonRpcTestHarness as createBridgeJsonRpcTestHarness,
  experimental_formatConformanceReport as formatConformanceReport,
  experimental_runBridgeConformance as runBridgeConformance,
  type BridgeDeltaEventCollector,
  type BridgeJsonRpcObject,
  type BridgeJsonRpcOutputMessage,
  type BridgeJsonRpcTestHarness,
  type CapturedBridgeJsonRpcOutput,
  type ThreadEvent,
} from "@get-bb/plugin-sdk/provider-bridge/testing";
import {
  closeBridgeSessions,
  experimental_providerBridge,
  handleLine,
} from "../src/provider-bridge.js";
import {
  PROVIDER_ID,
  QUERY_RESULT_KIND,
  SQLSABER_EXECUTABLE_ENV,
} from "../src/vocabulary.js";

const fixtureExecutable = fileURLToPath(
  new URL("./fixtures/fake-sqlsaber.mjs", import.meta.url),
);
const fullOptions = {
  model: "configured",
  reasoningLevel: "medium",
  permissionMode: "full",
  permissionScope: "full",
  approvalReviewer: null,
  permissionEscalation: null,
} satisfies BridgeJsonRpcObject;

let workspaceDir: string;
let dataDir: string;
let processTempDir: string;
let previousExecutable: string | undefined;

function textInput(text: string): PromptInput[] {
  return [{ type: "text", text, mentions: [] }];
}

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "bb-sqlsaber-workspace-"));
  dataDir = mkdtempSync(join(tmpdir(), "bb-sqlsaber-data-"));
  processTempDir = mkdtempSync(join(tmpdir(), "bb-sqlsaber-process-"));
  previousExecutable = process.env[SQLSABER_EXECUTABLE_ENV];
  process.env[SQLSABER_EXECUTABLE_ENV] = fixtureExecutable;
  experimental_providerBridge.start?.({
    pluginId: "sqlsaber",
    dataDir,
    tempDir: processTempDir,
  });
});

afterEach(() => {
  closeBridgeSessions();
  if (previousExecutable === undefined) {
    delete process.env[SQLSABER_EXECUTABLE_ENV];
  } else {
    process.env[SQLSABER_EXECUTABLE_ENV] = previousExecutable;
  }
  rmSync(workspaceDir, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(processTempDir, { recursive: true, force: true });
});

describe("SQLSaber provider bridge conformance", () => {
  it("passes the canonical bridge suite", async () => {
    const output: CapturedBridgeJsonRpcOutput = captureBridgeJsonRpcOutput();
    try {
      const report = await runBridgeConformance({
        transport: {
          send: handleLine,
          takeMessages: output.takeMessages,
          close: closeBridgeSessions,
        },
        providerId: PROVIDER_ID,
        session: {
          cwd: workspaceDir,
          promptInput: textInput("show the fixture rows"),
          zeroWorkPromptInput: textInput("/noop"),
          interruptiblePromptInput: textInput("hang until stopped"),
        },
        timeoutMs: 10_000,
      });

      if (!report.passed) {
        throw new Error(formatConformanceReport(report));
      }
      expect(
        Object.fromEntries(
          report.results.map((result) => [result.id, result.status]),
        ),
      ).toEqual({
        "rpc/unknown-method": "pass",
        "rpc/invalid-params": "pass",
        "rpc/non-json-ignored": "pass",
        "rpc/response-not-request": "pass",
        "handshake/initialize": "pass",
        "skills/configure-declared": "pass",
        "session/start-identity": "pass",
        "turn/lifecycle": "pass",
        "events/schema-valid": "pass",
        "item/opens-before-delta": "pass",
        "stop/release-not-interrupted": "pass",
        "session/resume-identity": "pass",
        "session/resume-id-uniqueness": "pass",
        "turn/settles-without-activity": "pass",
        "session/threads-independent": "pass",
        "stop/interrupt-settles-before-result": "pass",
      });
    } finally {
      output.restore();
    }
  }, 30_000);
});

describe("SQLSaber stream translation", () => {
  let harness: BridgeJsonRpcTestHarness;
  let collector: BridgeDeltaEventCollector;
  let cursor: number;
  let events: ThreadEvent[];
  let requestCounter: number;

  beforeEach(() => {
    harness = createBridgeJsonRpcTestHarness(handleLine);
    collector = createBridgeDeltaEventCollector(PROVIDER_ID);
    cursor = 0;
    events = [];
    requestCounter = 0;
  });

  afterEach(() => {
    harness.restore();
  });

  async function request(
    method: string,
    params: BridgeJsonRpcObject,
  ): Promise<BridgeJsonRpcOutputMessage> {
    requestCounter += 1;
    const id = `request-${requestCounter}`;
    harness.sendRequest(id, method, params);
    const response = await harness.waitForResponse(id);
    expect(response.error, `${method} returned an error`).toBeUndefined();
    return response;
  }

  function drainEvents(): ThreadEvent[] {
    const next = harness.messages.slice(cursor);
    cursor = harness.messages.length;
    for (const message of next) {
      events.push(...collector.assembleMessage(message));
    }
    return events;
  }

  function latestProviderTurnId(threadId: string): string {
    const notificationSchema = z.object({
      params: z.object({
        threadId: z.string(),
        deltas: z.array(
          z.object({
            kind: z.string(),
            providerTurnId: z.string().optional(),
          }),
        ),
      }),
    });
    for (const message of [...harness.messages].reverse()) {
      const parsed = notificationSchema.safeParse(message);
      if (!parsed.success || parsed.data.params.threadId !== threadId) {
        continue;
      }
      for (const delta of [...parsed.data.params.deltas].reverse()) {
        if (delta.kind === "turn.open" && delta.providerTurnId !== undefined) {
          return delta.providerTurnId;
        }
      }
    }
    throw new Error(`No provider turn id was emitted for ${threadId}`);
  }

  async function initialize(): Promise<void> {
    await request("initialize", {
      protocolVersion: 2,
      client: { name: "sqlsaber-test", version: "0.0.0" },
      grammarVersions: [3, 3],
    });
  }

  async function startSession(threadId: string): Promise<string> {
    const response = await request("thread/start", {
      threadId,
      cwd: workspaceDir,
      instructionMode: "append",
      options: fullOptions,
    });
    return z
      .object({ providerThreadId: z.string().min(1) })
      .parse(response.result).providerThreadId;
  }

  it("assembles streamed reasoning, tools, text, usage, and a table row", async () => {
    await initialize();
    const modelResponse = await request("model/list", { cwd: workspaceDir });
    expect(modelResponse.result).toMatchObject({
      models: [{ id: "configured", displayName: "SQLSaber · fake:sql-model" }],
    });

    const threadId = "thr_sqlsaber_stream";
    const providerThreadId = await startSession(threadId);
    await request("turn/start", {
      threadId,
      providerThreadId,
      input: textInput("show the fixture rows"),
      clientRequestId: "creq_23456789ab",
      options: fullOptions,
    });

    await vi.waitFor(() => {
      expect(
        drainEvents().some(
          (event) =>
            event.type === "turn/completed" && event.status === "completed",
        ),
      ).toBe(true);
    });

    const completedItems = events.filter(
      (event) => event.type === "item/completed",
    );
    expect(
      completedItems.find((event) => event.item.type === "agentMessage")?.item,
    ).toMatchObject({ text: "Two rows matched." });
    expect(
      completedItems.find((event) => event.item.type === "reasoning")?.item,
    ).toMatchObject({ content: ["Checking the schema"] });
    expect(
      completedItems.find((event) => event.item.type === "toolCall")?.item,
    ).toMatchObject({
      tool: "execute_sql",
      status: "completed",
      arguments: {
        query: "SELECT name, total, active, metadata FROM sales",
      },
    });

    const tableEvent = completedItems.find(
      (event) =>
        event.item.type === "extension" && event.item.kind === QUERY_RESULT_KIND,
    );
    expect(tableEvent?.item).toMatchObject({
      type: "extension",
      kind: QUERY_RESULT_KIND,
      status: "completed",
      payload: {
        databaseName: "fixture",
        columns: ["name", "total", "active", "metadata"],
        columnCount: 4,
        rowCount: 2,
        truncated: false,
        rows: [
          [
            { kind: "text", value: "Ada" },
            { kind: "number", value: 12.5 },
            { kind: "boolean", value: true },
            { kind: "text", value: '{"region":"west"}' },
          ],
          [
            { kind: "text", value: "Lin" },
            { kind: "number", value: 9 },
            { kind: "boolean", value: false },
            { kind: "null" },
          ],
        ],
      },
      presentation: {
        label: { completed: "Query result" },
        icon: { glyph: "Table2" },
      },
    });
    expect(
      events.find((event) => event.type === "thread/tokenUsage/updated"),
    ).toMatchObject({
      tokenUsage: {
        last: {
          inputTokens: 11,
          outputTokens: 7,
          cachedInputTokens: 4,
          totalTokens: 22,
        },
      },
    });
  });

  it("rejects a per-session model switch that SQLSaber RPC cannot apply", async () => {
    await initialize();
    const id = "unsupported-model";
    harness.sendRequest(id, "thread/start", {
      threadId: "thr_sqlsaber_unsupported_model",
      cwd: workspaceDir,
      instructionMode: "append",
      options: { ...fullOptions, model: "another-model" },
    });
    const response = await harness.waitForResponse(id);
    expect(response.error).toMatchObject({
      code: -32602,
      message: "SQLSaber RPC cannot switch models; expected configured",
    });
  });

  it("restores the persisted SQLSaber thread after a bridge restart", async () => {
    await initialize();
    const firstThreadId = "thr_sqlsaber_before_restart";
    const providerThreadId = await startSession(firstThreadId);
    await request("turn/start", {
      threadId: firstThreadId,
      providerThreadId,
      input: textInput("show the fixture rows"),
      clientRequestId: "creq_23456789ae",
      options: fullOptions,
    });
    await vi.waitFor(() => {
      expect(
        drainEvents().some(
          (event) =>
            event.type === "turn/completed" && event.status === "completed",
        ),
      ).toBe(true);
    });

    expect(
      JSON.parse(
        readFileSync(
          join(dataDir, "sessions", `${providerThreadId}.json`),
          "utf8",
        ),
      ),
    ).toEqual({
      providerThreadId,
      sqlsaberThreadId: "fake-sqlsaber-thread",
    });
    await request("thread/stop", {
      threadId: firstThreadId,
      providerThreadId,
      activeTurnId: null,
      intent: "release",
    });

    experimental_providerBridge.start?.({
      pluginId: "sqlsaber",
      dataDir,
      tempDir: processTempDir,
    });
    await initialize();
    const resumedThreadId = "thr_sqlsaber_after_restart";
    const resumed = await request("thread/resume", {
      threadId: resumedThreadId,
      providerThreadId,
      cwd: workspaceDir,
      instructionMode: "append",
      options: fullOptions,
    });
    expect(resumed.result).toMatchObject({
      providerThreadId,
      sessionRestorable: true,
    });
  });

  it("treats repeated release and disposal as safe no-ops", async () => {
    await initialize();
    const threadId = "thr_sqlsaber_repeated_stop";
    const providerThreadId = await startSession(threadId);
    const stopParams = {
      threadId,
      providerThreadId,
      activeTurnId: null,
      intent: "release",
    } satisfies BridgeJsonRpcObject;

    await request("thread/stop", stopParams);
    await request("thread/stop", stopParams);
    expect(() => {
      closeBridgeSessions();
      closeBridgeSessions();
    }).not.toThrow();
  });

  it.each([
    ["/error", "fixture model failure"],
    ["/exit", "fixture transport failure"],
  ])("settles a turn when SQLSaber reports %s", async (prompt, detail) => {
    await initialize();
    const threadId = `thr_sqlsaber_failure_${prompt.slice(1)}`;
    const providerThreadId = await startSession(threadId);
    await request("turn/start", {
      threadId,
      providerThreadId,
      input: textInput(prompt),
      clientRequestId:
        prompt === "/error" ? "creq_23456789af" : "creq_23456789ag",
      options: fullOptions,
    });

    await vi.waitFor(() => {
      expect(
        drainEvents().some(
          (event) =>
            event.type === "turn/completed" && event.status === "failed",
        ),
      ).toBe(true);
    });
    expect(JSON.stringify(harness.messages)).toContain(detail);
    if (prompt === "/exit") {
      expect(
        events.find(
          (event) =>
            event.type === "item/completed" &&
            event.item.type === "toolCall",
        ),
      ).toMatchObject({ item: { status: "failed" } });
    }
  });

  it("queues a steer on the active SQLSaber turn", async () => {
    await initialize();
    const threadId = "thr_sqlsaber_steer";
    const providerThreadId = await startSession(threadId);
    await request("turn/start", {
      threadId,
      providerThreadId,
      input: textInput("hang"),
      clientRequestId: "creq_23456789ac",
      options: fullOptions,
    });
    await request("turn/steer", {
      threadId,
      providerThreadId,
      input: textInput("only active accounts"),
      clientRequestId: "creq_23456789ad",
      expectedTurnId: latestProviderTurnId(threadId),
      options: fullOptions,
    });

    await vi.waitFor(() => {
      expect(
        drainEvents().some(
          (event) =>
            event.type === "turn/completed" && event.status === "completed",
        ),
      ).toBe(true);
    });
    expect(
      events.filter((event) => event.type === "turn/input/accepted"),
    ).toHaveLength(2);
    expect(
      events.find(
        (event) =>
          event.type === "item/completed" &&
          event.item.type === "agentMessage",
      ),
    ).toMatchObject({ item: { text: "Steered: only active accounts" } });
  });
});
