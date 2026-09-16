import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { parseSqlSaberLine } from "../src/sqlsaber-protocol.js";

it("launches the installed SQLSaber RPC without user config or credentials", () => {
  const home = mkdtempSync(join(tmpdir(), "bb-sqlsaber-smoke-"));
  try {
    const env = {
      PATH: process.env.PATH ?? "",
      HOME: home,
      XDG_CONFIG_HOME: join(home, "config"),
      XDG_DATA_HOME: join(home, "data"),
      TMPDIR: home,
      NO_COLOR: "1",
      LANG: "C.UTF-8",
    };
    const version = spawnSync("sqlsaber", ["--version"], {
      encoding: "utf8",
      env,
      timeout: 10_000,
    });
    expect(version.error).toBeUndefined();
    expect(version.status).toBe(0);
    expect(version.stdout.trim()).toMatch(/^0\.77\.0$/u);

    const rpc = spawnSync("sqlsaber", ["rpc"], {
      encoding: "utf8",
      env,
      timeout: 15_000,
    });
    expect(rpc.error).toBeUndefined();
    expect(rpc.status).toBe(1);
    const lines = rpc.stdout.trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(parseSqlSaberLine(lines[0] ?? "")).toEqual({
      kind: "message",
      message: {
        type: "response",
        command: "startup",
        success: false,
        error:
          "No database connections configured. Use 'sqlsaber db add <name>' to add one.",
      },
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
