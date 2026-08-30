import { describe, expect, it } from "vitest";
import { parseSessionContent, rewriteSessionContent } from "./session-files";

function jsonl(...rows: unknown[]) {
  return `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
}

describe("parseSessionContent", () => {
  it("reads Claude Code identity, workspace, prompt, and model", () => {
    const content = jsonl(
      { type: "mode", sessionId: "claude-old" },
      {
        type: "user",
        sessionId: "claude-old",
        cwd: "/work/app",
        timestamp: "2026-01-01T00:00:00.000Z",
        message: { role: "user", content: "Fix the flaky test" },
      },
      {
        type: "assistant",
        sessionId: "claude-old",
        cwd: "/work/app",
        timestamp: "2026-01-01T00:01:00.000Z",
        message: { role: "assistant", model: "claude-opus-4-1", content: [] },
      },
    );

    expect(parseSessionContent("claude-code", content)).toMatchObject({
      sourceId: "claude-old",
      cwd: "/work/app",
      title: "Fix the flaky test",
      model: "claude-opus-4-1",
      messageCount: 2,
    });
  });

  it("reads Codex metadata and the first user message", () => {
    const content = jsonl(
      {
        type: "session_meta",
        timestamp: "2026-01-01T00:00:00.000Z",
        payload: { id: "codex-old", session_id: "codex-old", cwd: "/work/api" },
      },
      {
        type: "turn_context",
        timestamp: "2026-01-01T00:00:01.000Z",
        payload: { cwd: "/work/api", model: "gpt-5.4", effort: "high" },
      },
      {
        type: "event_msg",
        timestamp: "2026-01-01T00:00:02.000Z",
        payload: { type: "user_message", message: "Trace the request path" },
      },
    );

    expect(parseSessionContent("codex", content)).toMatchObject({
      sourceId: "codex-old",
      cwd: "/work/api",
      title: "Trace the request path",
      model: "gpt-5.4",
      reasoningLevel: "high",
      messageCount: 1,
    });
  });

  it("reads Pi session settings and text content", () => {
    const content = jsonl(
      { type: "session", id: "pi-old", cwd: "/work/web", timestamp: "2026-01-01T00:00:00.000Z" },
      { type: "model_change", provider: "openai-codex", modelId: "gpt-5.4", timestamp: "2026-01-01T00:00:01.000Z" },
      { type: "thinking_level_change", thinkingLevel: "xhigh", timestamp: "2026-01-01T00:00:02.000Z" },
      {
        type: "message",
        timestamp: "2026-01-01T00:00:03.000Z",
        message: { role: "user", content: [{ type: "text", text: "Improve this layout" }] },
      },
    );

    expect(parseSessionContent("pi", content)).toMatchObject({
      sourceId: "pi-old",
      cwd: "/work/web",
      title: "Improve this layout",
      model: "openai-codex/gpt-5.4",
      reasoningLevel: "xhigh",
      messageCount: 1,
    });
  });
});

describe("rewriteSessionContent", () => {
  it("rekeys Claude sessionId fields without changing message ids", () => {
    const content = jsonl({
      type: "user",
      sessionId: "old",
      uuid: "message-1",
      nested: { sessionId: "old" },
    });
    const row = JSON.parse(rewriteSessionContent("claude-code", content, "old", "new").trim());
    expect(row).toEqual({
      type: "user",
      sessionId: "new",
      uuid: "message-1",
      nested: { sessionId: "new" },
    });
  });

  it("rekeys only matching Codex identity values", () => {
    const content = jsonl({
      type: "session_meta",
      payload: { id: "old", session_id: "old", turn_id: "turn-1", nested: { id: "other" } },
    });
    const row = JSON.parse(rewriteSessionContent("codex", content, "old", "new").trim());
    expect(row.payload).toEqual({
      id: "new",
      session_id: "new",
      turn_id: "turn-1",
      nested: { id: "other" },
    });
  });

  it("preserves Pi's internal session id", () => {
    const content = jsonl({ type: "session", id: "pi-old", cwd: "/work" });
    expect(rewriteSessionContent("pi", content, "pi-old", "bb-thread")).toBe(content);
  });
});
