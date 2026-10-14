import { describe, expect, it } from "vitest";
import { detectDelimiter, normalizeHeader, parseCsv, parseCsvRows, CsvError } from "./csv";

describe("parseCsv", () => {
  it("keeps a comma that lives inside quotes in one cell", () => {
    const table = parseCsv('name,city\n"Acme, Inc",Bilbao\n');
    expect(table.header).toEqual(["name", "city"]);
    expect(table.rows).toEqual([["Acme, Inc", "Bilbao"]]);
  });

  it("reads a doubled quote as one literal quote", () => {
    const table = parseCsv('name\n"She said ""hello"""\n');
    expect(table.rows).toEqual([['She said "hello"']]);
  });

  it("keeps a newline inside a quoted cell instead of starting a row", () => {
    const table = parseCsv('id,note\n1,"line one\nline two"\n2,plain\n');
    expect(table.rows).toEqual([
      ["1", "line one\nline two"],
      ["2", "plain"],
    ]);
  });

  it("treats CRLF, a lone CR and LF as the same row end", () => {
    expect(parseCsv("a,b\r\n1,2\r\n").rows).toEqual([["1", "2"]]);
    expect(parseCsv("a,b\r1,2\r").rows).toEqual([["1", "2"]]);
    expect(parseCsv("a,b\n1,2").rows).toEqual([["1", "2"]]);
  });

  it("does not invent an empty last row for a trailing newline", () => {
    expect(parseCsv("a\n1\n2\n").rows).toEqual([["1"], ["2"]]);
  });

  it("keeps an empty quoted cell distinct from a missing one", () => {
    const table = parseCsv('a,b,c\n1,"",\n');
    expect(table.rows).toEqual([["1", "", ""]]);
  });

  it("strips a UTF-8 BOM so the first column is nameable", () => {
    expect(parseCsv("﻿id,name\n1,a\n").header).toEqual(["id", "name"]);
  });

  it("pads a short row and drops cells past the header", () => {
    const table = parseCsv("a,b\n1\n1,2,3\n");
    expect(table.rows).toEqual([
      ["1", ""],
      ["1", "2"],
    ]);
  });

  it("stops at maxRows without touching the header", () => {
    const table = parseCsv("a\n1\n2\n3\n", { maxRows: 2 });
    expect(table.rows).toEqual([["1"], ["2"]]);
  });

  it("refuses an empty file rather than making an empty dataset", () => {
    expect(() => parseCsv("   \n")).toThrow(CsvError);
  });

  it("appends stray text after a closing quote rather than refusing the file", () => {
    expect(parseCsvRows('"a"b,c', ",")).toEqual([["ab", "c"]]);
  });
});

describe("detectDelimiter", () => {
  it("picks the separator the header actually uses", () => {
    expect(detectDelimiter("a,b,c\n1,2,3")).toBe(",");
    expect(detectDelimiter("a;b;c\n1;2;3")).toBe(";");
    expect(detectDelimiter("a\tb\tc\n1\t2\t3")).toBe("\t");
  });

  it("ignores separators that live inside quotes", () => {
    // Three commas by a naive count, one real one.
    expect(detectDelimiter('name;"a,b,c"')).toBe(";");
  });
});

describe("normalizeHeader", () => {
  it("suffixes a duplicate rather than dropping its column", () => {
    expect(normalizeHeader(["notes", "notes", "notes"])).toEqual(["notes", "notes_2", "notes_3"]);
  });

  it("names an empty header cell after its position", () => {
    expect(normalizeHeader(["id", "  "])).toEqual(["id", "column_2"]);
  });
});
