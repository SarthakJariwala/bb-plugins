import { definePluginApp } from "@get-bb/plugin-sdk/app";
import type { PluginTimelineRendererProps } from "@get-bb/plugin-sdk/app";
import {
  QUERY_RESULT_KIND,
  sqlTablePayloadSchema,
  type TableCell,
} from "./src/vocabulary";

function cellText(cell: TableCell): string {
  switch (cell.kind) {
    case "null":
      return "NULL";
    case "boolean":
      return cell.value ? "true" : "false";
    case "number":
      return String(cell.value);
    case "text":
      return cell.value;
  }
}

function QueryResultTable({ payload, Original }: PluginTimelineRendererProps) {
  const parsed = sqlTablePayloadSchema.safeParse(payload);
  if (!parsed.success) {
    return <Original />;
  }
  const table = parsed.data;
  if (table.columns.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        The query returned no columns.
      </p>
    );
  }
  return (
    <div className="space-y-2">
      <div className="max-h-96 overflow-auto rounded-md border border-border">
        <table className="w-full border-collapse text-left text-xs">
          <caption className="sr-only">
            SQL query result with {table.rowCount} rows
          </caption>
          <thead className="sticky top-0 z-10 bg-muted text-muted-foreground">
            <tr>
              {table.columns.map((column, index) => (
                <th
                  key={`${index}:${column}`}
                  scope="col"
                  className="whitespace-nowrap border-b border-border px-3 py-2 font-medium"
                >
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {table.rows.map((row, rowIndex) => (
              <tr key={rowIndex} className="align-top hover:bg-muted/30">
                {table.columns.map((column, columnIndex) => {
                  const cell: TableCell = row[columnIndex] ?? { kind: "null" };
                  return (
                    <td
                      key={`${columnIndex}:${column}`}
                      className={
                        cell.kind === "number"
                          ? "whitespace-pre px-3 py-2 text-right font-mono tabular-nums"
                          : cell.kind === "null"
                            ? "whitespace-pre px-3 py-2 font-mono italic text-muted-foreground"
                            : "max-w-80 whitespace-pre-wrap break-words px-3 py-2 font-mono"
                      }
                    >
                      {cellText(cell)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted-foreground">
        {table.rows.length === table.rowCount && !table.truncated
          ? `${table.rowCount} ${table.rowCount === 1 ? "row" : "rows"}`
          : `Showing ${table.rows.length} of ${table.rowCount} rows`}
        {table.columnCount > table.columns.length
          ? ` and ${table.columns.length} of ${table.columnCount} columns`
          : ""}
        {table.databaseName === null ? "" : ` from ${table.databaseName}`}
      </p>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.experimental_timelineRenderer({
    kind: QUERY_RESULT_KIND,
    component: QueryResultTable,
  });
});
