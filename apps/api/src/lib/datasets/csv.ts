/**
 * A CSV parser, in the repo rather than from npm.
 *
 * Not out of taste: the whole job is ~120 lines of state machine, and the
 * alternative is a dependency in the API image for something whose entire
 * contract is "quotes, doubled quotes, embedded commas and newlines, CRLF".
 * Those four rules are the ones every naive `split(",")` gets wrong and the
 * ones tested below; anything past them (streaming, type coercion, dialect
 * sniffing beyond the delimiter) is a library's problem and not ours, because
 * a dataset arrives once, bounded by DATASET_MAX_ROWS, and is then rows.
 *
 * Everything here returns raw strings. Typing is `inferSchema`'s job and lives
 * in the contract, so the API and the web agree on what a column holds.
 */

/** Delimiters worth guessing between. Not user-configurable: see `detectDelimiter`. */
const DELIMITERS = [",", ";", "\t"] as const;
export type CsvDelimiter = (typeof DELIMITERS)[number];

export interface CsvTable {
  header: string[];
  /** One array of cells per data row, already padded/truncated to `header`. */
  rows: string[][];
  delimiter: CsvDelimiter;
}

export class CsvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CsvError";
  }
}

/**
 * Which delimiter the first line is written with, decided by counting
 * separators OUTSIDE quotes — `name,"Acme, Inc",3` has three commas by a naive
 * count and one by this one. Exports from European spreadsheets use `;` often
 * enough that refusing them means the agent has to know it needs to re-export.
 */
export function detectDelimiter(text: string): CsvDelimiter {
  let best: CsvDelimiter = ",";
  let bestCount = -1;
  for (const delimiter of DELIMITERS) {
    let count = 0;
    let quoted = false;
    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      if (char === '"') {
        if (quoted && text[i + 1] === '"') i += 1;
        else quoted = !quoted;
        continue;
      }
      if (quoted) continue;
      if (char === "\n" || char === "\r") break; // first line only
      if (char === delimiter) count += 1;
    }
    if (count > bestCount) {
      bestCount = count;
      best = delimiter;
    }
  }
  return best;
}

/**
 * Cells, as written. The parser is a character loop rather than a regex
 * because a quoted field may contain the delimiter, a newline, or a doubled
 * quote, and no single regex reads all three without backtracking games.
 *
 * Lenient in exactly one place: text after a closing quote but before the next
 * delimiter (`"a"b,c`) is appended rather than rejected. A real export never
 * writes that, and a human-edited file that does is better ingested than
 * refused — the alternative is an agent stuck with a file it cannot fix.
 */
export function parseCsvRows(text: string, delimiter: CsvDelimiter): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let sawField = false;

  const endField = () => {
    row.push(field);
    field = "";
    sawField = false;
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"' && !sawField) {
      quoted = true;
      sawField = true;
      continue;
    }
    if (char === delimiter) {
      endField();
      continue;
    }
    if (char === "\r") {
      // CRLF and a lone CR are both row ends; the LF of a CRLF is consumed here
      // so it cannot open an empty row of its own.
      if (text[i + 1] === "\n") i += 1;
      endRow();
      continue;
    }
    if (char === "\n") {
      endRow();
      continue;
    }
    field += char;
    sawField = true;
  }
  // A file that does not end in a newline still has a last row; one that does
  // must not gain an empty one.
  if (field !== "" || row.length > 0 || quoted) endRow();
  return rows;
}

/**
 * Header names, made usable as jsonb keys: unique and non-empty.
 *
 * Duplicates are real (an export with two `notes` columns), and silently
 * keeping one of them would drop a column's data with nothing to show for it.
 * Suffixing is the only option that loses nothing.
 */
export function normalizeHeader(cells: readonly string[]): string[] {
  const out: string[] = [];
  const taken = new Set<string>();
  cells.forEach((raw, index) => {
    let name = raw.trim();
    if (name === "") name = `column_${index + 1}`;
    let candidate = name;
    let n = 2;
    while (taken.has(candidate)) candidate = `${name}_${n++}`;
    taken.add(candidate);
    out.push(candidate);
  });
  return out;
}

export interface ParseCsvOptions {
  delimiter?: CsvDelimiter;
  /** Rows past this are dropped and reported by the caller, never silently kept. */
  maxRows?: number;
}

/**
 * The whole file: header plus rectangular rows.
 *
 * Rows are padded to the header's width and extra cells are dropped. A ragged
 * export is normal (trailing commas, a comment line) and rectangular is what
 * every consumer downstream assumes; being strict here would reject files that
 * are perfectly readable.
 */
export function parseCsv(text: string, opts: ParseCsvOptions = {}): CsvTable {
  // A UTF-8 BOM belongs to the encoding, not to the first column's name — left
  // in, it makes `﻿id` a column nobody can ever name in a query.
  const body = text.replace(/^﻿/, "");
  if (body.trim() === "") throw new CsvError("the CSV is empty");
  const delimiter = opts.delimiter ?? detectDelimiter(body);
  const raw = parseCsvRows(body, delimiter).filter(
    (row) => !(row.length === 1 && row[0]!.trim() === ""),
  );
  if (raw.length === 0) throw new CsvError("the CSV is empty");
  const header = normalizeHeader(raw[0]!);
  if (header.length === 0) throw new CsvError("the CSV has no columns");
  const limit = opts.maxRows ?? Number.POSITIVE_INFINITY;
  const rows: string[][] = [];
  for (let i = 1; i < raw.length && rows.length < limit; i++) {
    const cells = raw[i]!;
    rows.push(header.map((_, index) => cells[index] ?? ""));
  }
  return { header, rows, delimiter };
}
