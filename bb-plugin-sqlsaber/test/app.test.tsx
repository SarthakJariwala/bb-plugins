// @vitest-environment jsdom

import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { expect, it } from "vitest";
import { QUERY_RESULT_KIND } from "../src/vocabulary.js";

it("renders a validated SQL result as a semantic table", async () => {
  const app = await loadPluginApp(() => import("../app.js"));
  const renderer = app.timelineRenderers.find(
    (candidate) => candidate.kind === QUERY_RESULT_KIND,
  );
  if (renderer === undefined) {
    throw new Error("SQLSaber did not register its query-result renderer");
  }

  const slot = renderSlot(renderer, {
    row: {
      id: "item-1",
      threadId: "thread-1",
      turnId: "turn-1",
      kind: QUERY_RESULT_KIND,
      toolName: null,
      status: "completed",
      startedAt: 1,
      completedAt: 2,
    },
    payload: {
      resultId: `qr_${"f".repeat(32)}`,
      databaseName: "warehouse",
      columns: ["customer", "revenue", "active", "note"],
      columnCount: 4,
      rows: [
        [
          { kind: "text", value: "Acme" },
          { kind: "number", value: 120.5 },
          { kind: "boolean", value: true },
          { kind: "null" },
        ],
      ],
      rowCount: 3,
      truncated: true,
    },
    presentation: {
      label: { pending: "Loading query result", completed: "Query result" },
      icon: { glyph: "Table2" },
    },
    thread: { id: "thread-1", providerId: "sqlsaber" },
    Original: () => <div>Fallback result</div>,
  });

  expect(slot.getByRole("table", { name: "SQL query result with 3 rows" })).toBeTruthy();
  expect(slot.getByRole("columnheader", { name: "customer" })).toBeTruthy();
  expect(slot.getByRole("cell", { name: "Acme" })).toBeTruthy();
  expect(slot.getByRole("cell", { name: "120.5" })).toBeTruthy();
  expect(slot.getByRole("cell", { name: "true" })).toBeTruthy();
  expect(slot.getByRole("cell", { name: "NULL" })).toBeTruthy();
  expect(slot.getByText("Showing 1 of 3 rows from warehouse")).toBeTruthy();

  slot.lifecycle.unmount();
});
