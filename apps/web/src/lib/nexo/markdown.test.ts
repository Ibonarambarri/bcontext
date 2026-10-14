import { describe, expect, test } from "vitest";
import { linkCitationMarkers, parseCiteHref } from "./markdown";

describe("linkCitationMarkers", () => {
  test("turns in-range markers into cite anchors and leaves the rest alone", () => {
    expect(linkCitationMarkers("Shovels [1] and rakes [2].", 2)).toBe(
      "Shovels [1](#cite-1) and rakes [2](#cite-2).",
    );
  });

  test("keeps markdown around the marker intact", () => {
    const md = "## Pricing\n\n- **Free** tier [1]\n- Paid tier [2]\n";
    expect(linkCitationMarkers(md, 2)).toBe(
      "## Pricing\n\n- **Free** tier [1](#cite-1)\n- Paid tier [2](#cite-2)\n",
    );
  });

  test("ignores out-of-range indexes, existing links and reference definitions", () => {
    expect(linkCitationMarkers("see [7]", 2)).toBe("see [7]");
    expect(linkCitationMarkers("see [1](/n/abc)", 2)).toBe("see [1](/n/abc)");
    expect(linkCitationMarkers("[1]: https://x", 2)).toBe("[1]: https://x");
  });

  test("adjacent markers become two chips", () => {
    expect(linkCitationMarkers("both [1][2]", 2)).toBe("both [1](#cite-1)[2](#cite-2)");
  });

  test("is a no-op without citations", () => {
    expect(linkCitationMarkers("see [1]", 0)).toBe("see [1]");
    expect(linkCitationMarkers("", 3)).toBe("");
  });
});

describe("parseCiteHref", () => {
  test("round-trips the anchor", () => {
    expect(parseCiteHref("#cite-3")).toBe(3);
  });
  test("rejects everything else", () => {
    expect(parseCiteHref("#cite-0")).toBeNull();
    expect(parseCiteHref("#cite-x")).toBeNull();
    expect(parseCiteHref("/n/abc")).toBeNull();
    expect(parseCiteHref(undefined)).toBeNull();
  });
});
