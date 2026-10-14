import { describe, it, expect } from "vitest";
import {
  buildCitationAnchor,
  buildCitationHref,
  formatSnippet,
  parseCitationHighlight,
  parseCitationMarkers,
} from "./citation.js";

describe("buildCitationAnchor", () => {
  it("returns the chunk index as a string for valid input", () => {
    expect(buildCitationAnchor({ node_id: "n1", chunk_index: 0 })).toBe("0");
    expect(buildCitationAnchor({ node_id: "n1", chunk_index: 3 })).toBe("3");
  });

  it("floors fractional indexes", () => {
    expect(buildCitationAnchor({ node_id: "n1", chunk_index: 2.9 })).toBe("2");
  });

  it("returns null for missing/invalid chunk indexes", () => {
    expect(buildCitationAnchor({ node_id: "n1" })).toBeNull();
    expect(buildCitationAnchor({ node_id: "n1", chunk_index: null })).toBeNull();
    expect(buildCitationAnchor({ node_id: "n1", chunk_index: -1 })).toBeNull();
    expect(buildCitationAnchor({ node_id: "n1", chunk_index: NaN })).toBeNull();
  });
});

describe("buildCitationHref", () => {
  it("includes the highlight param when chunk index is valid", () => {
    expect(buildCitationHref("acme/docs", "abc", 2)).toBe("/w/acme/docs/n/abc?highlight=2");
  });

  it("omits the highlight param when chunk index is missing", () => {
    expect(buildCitationHref("acme/docs", "abc")).toBe("/w/acme/docs/n/abc");
    expect(buildCitationHref("acme/docs", "abc", null)).toBe("/w/acme/docs/n/abc");
  });
});

describe("parseCitationHighlight", () => {
  it("parses a numeric string", () => {
    expect(parseCitationHighlight("0")).toBe(0);
    expect(parseCitationHighlight("12")).toBe(12);
  });

  it("returns null for empty / missing / invalid values", () => {
    expect(parseCitationHighlight(null)).toBeNull();
    expect(parseCitationHighlight(undefined)).toBeNull();
    expect(parseCitationHighlight("")).toBeNull();
    expect(parseCitationHighlight("abc")).toBeNull();
    expect(parseCitationHighlight("-1")).toBeNull();
  });

  it("accepts the first entry when given an array (Next searchParams)", () => {
    expect(parseCitationHighlight(["3", "4"])).toBe(3);
    expect(parseCitationHighlight([])).toBeNull();
  });
});

describe("formatSnippet", () => {
  it("collapses whitespace and trims", () => {
    expect(formatSnippet("  hello\n   world  ")).toBe("hello world");
  });

  it("ellipses long bodies", () => {
    const long = "a".repeat(200);
    const out = formatSnippet(long, 50);
    expect(out.length).toBe(50);
    expect(out.endsWith("…")).toBe(true);
  });

  it("keeps short bodies untouched", () => {
    expect(formatSnippet("short")).toBe("short");
  });
});

describe("parseCitationMarkers", () => {
  it("splits a typical RAG response into text + markers", () => {
    const text =
      "The login flow uses Supabase Auth [1]. Sessions persist via cookies [2].";
    expect(parseCitationMarkers(text, 2)).toMatchInlineSnapshot(`
      [
        {
          "text": "The login flow uses Supabase Auth ",
          "type": "text",
        },
        {
          "n": 1,
          "type": "marker",
        },
        {
          "text": ". Sessions persist via cookies ",
          "type": "text",
        },
        {
          "n": 2,
          "type": "marker",
        },
        {
          "text": ".",
          "type": "text",
        },
      ]
    `);
  });

  it("leaves out-of-range markers as literal text", () => {
    const segs = parseCitationMarkers("Foo [9] bar", 2);
    expect(segs).toEqual([{ type: "text", text: "Foo [9] bar" }]);
  });

  it("returns an empty list for empty input", () => {
    expect(parseCitationMarkers("", 3)).toEqual([]);
  });

  it("handles markers at the start and end", () => {
    const segs = parseCitationMarkers("[1] start, end [2]", 2);
    expect(segs).toEqual([
      { type: "marker", n: 1 },
      { type: "text", text: " start, end " },
      { type: "marker", n: 2 },
    ]);
  });
});
