import { describe, expect, it } from "vitest";
import {
  JsonLineDecoder,
  SqlSaberProtocolError,
  parseSqlSaberLine,
} from "../src/sqlsaber-protocol.js";

describe("SQLSaber JSONL decoding", () => {
  it("preserves split UTF-8 and returns coalesced records in order", () => {
    const decoder = new JsonLineDecoder();
    const wire = Buffer.from(
      '{"type":"queue_update","steering":["café ☕"]}\n{"type":"agent_end","status":"aborted"}\r\n',
      "utf8",
    );
    const split = wire.indexOf(Buffer.from("☕")) + 1;

    expect(decoder.feed(wire.subarray(0, split))).toEqual([]);
    expect(decoder.feed(wire.subarray(split))).toEqual([
      '{"type":"queue_update","steering":["café ☕"]}',
      '{"type":"agent_end","status":"aborted"}',
    ]);
    expect(decoder.finish()).toEqual([]);
  });

  it("returns the final unterminated record", () => {
    const decoder = new JsonLineDecoder();
    expect(decoder.feed(Buffer.from("partial"))).toEqual([]);
    expect(decoder.finish()).toEqual(["partial"]);
  });

  it("rejects a record above its byte limit", () => {
    const decoder = new JsonLineDecoder(4);
    expect(() => decoder.feed(Buffer.from("12345"))).toThrow(
      SqlSaberProtocolError,
    );
  });
});

describe("SQLSaber protocol parsing", () => {
  it("parses typed stream events", () => {
    const parsed = parseSqlSaberLine(
      '{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"hi"}}',
    );
    expect(parsed).toEqual({
      kind: "message",
      message: {
        type: "message_update",
        assistantMessageEvent: {
          type: "text_delta",
          contentIndex: 0,
          delta: "hi",
        },
      },
    });
  });

  it("keeps future event records as unknown JSON", () => {
    expect(parseSqlSaberLine('{"type":"future_event","value":1}')).toEqual({
      kind: "unknown",
      payload: { type: "future_event", value: 1 },
    });
  });

  it("rejects malformed known records", () => {
    expect(() => parseSqlSaberLine('{"type":"agent_end"}')).toThrow(
      "malformed protocol record",
    );
  });
});
