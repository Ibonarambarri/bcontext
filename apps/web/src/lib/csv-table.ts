/**
 * Clipboard → pipe table. Spreadsheet copies (Sheets, Excel, Numbers) put
 * tab-separated text on the clipboard; when it looks like a grid we offer
 * it to the editor as a Markdown table instead of a blob of text.
 * Tab-only on purpose: comma CSV needs a real parser (quotes, escapes)
 * and hand-written prose with commas would false-positive constantly.
 */

/** A Markdown pipe table for tab-separated grid text; null when the paste is not a grid. */
export function pasteTextToPipeTable(text: string): string | null {
  const trimmed = text.replace(/\r\n?/g, "\n").replace(/\n+$/, "");
  if (!trimmed.includes("\t")) return null;

  const rows = trimmed.split("\n");
  if (rows.length < 2) return null;

  const grid = rows.map((r) => r.split("\t"));
  const cols = grid[0]!.length;
  if (cols < 2) return null;
  // Every row must agree on the column count — otherwise it's just text
  // that happens to contain tabs.
  if (!grid.every((r) => r.length === cols)) return null;

  const clean = (cell: string) =>
    cell.trim().replace(/\|/g, "\\|").replace(/\n/g, " ") || " ";

  const line = (cells: string[]) => `| ${cells.map(clean).join(" | ")} |`;
  const header = line(grid[0]!);
  const sep = `| ${Array.from({ length: cols }, () => "---").join(" | ")} |`;
  const body = grid.slice(1).map(line);
  return [header, sep, ...body].join("\n");
}
