import { describe, expect, it } from "vitest";
import { foldText, matchRank, searchConnections, type ConnectNode, type ConnectTag } from "./connect-picker";

function node(id: string, title: string, updatedAt: string, kind: ConnectNode["kind"] = "doc"): ConnectNode {
  return { id, title, kind, updated_at: updatedAt };
}

function tag(id: string, name: string): ConnectTag {
  return { id, name, normalized_name: name.toLowerCase() };
}

const NODES: ConnectNode[] = [
  node("n1", "Résumé of the launch", "2026-09-01T00:00:00.000Z"),
  node("n2", "Launch plan", "2026-09-05T00:00:00.000Z", "task"),
  node("n3", "Post-launch review", "2026-09-03T00:00:00.000Z", "meeting"),
  node("n4", "Budget", "2026-09-10T00:00:00.000Z"),
  node("n5", "Prelaunch checklist", "2026-09-02T00:00:00.000Z", "task"),
  node("n6", "Older doc", "2026-08-01T00:00:00.000Z"),
  node("n7", "Newest doc", "2026-09-11T00:00:00.000Z"),
];

const TAGS: ConnectTag[] = [tag("t1", "Launch"), tag("t2", "Marketing"), tag("t3", "Ops"), tag("t4", "Relaunch")];

describe("foldText", () => {
  it("ignores case, accents and stray whitespace", () => {
    expect(foldText("  Résumé   Of  ")).toBe("resume of");
    expect(foldText("ÀÉÎÕÜ")).toBe("aeiou");
  });
});

describe("matchRank", () => {
  it("prefers a title start, then a word start, then any substring", () => {
    expect(matchRank("launch plan", "launch")).toBe(0);
    expect(matchRank("post launch", "launch")).toBe(1);
    expect(matchRank("prelaunch", "launch")).toBe(2);
    expect(matchRank("budget", "launch")).toBe(-1);
  });
});

describe("searchConnections", () => {
  it("shows the most recent nodes and no tags before anything is typed", () => {
    const results = searchConnections("", NODES, TAGS);
    expect(results.nodes.map((entry) => entry.id)).toEqual(["n7", "n4", "n2", "n3", "n5"]);
    expect(results.tags).toEqual([]);
  });

  it("matches titles without regard to case or diacritics", () => {
    const results = searchConnections("RESUME", NODES, TAGS);
    expect(results.nodes.map((entry) => entry.id)).toEqual(["n1"]);
  });

  it("ranks by match quality, then by recency", () => {
    const results = searchConnections("launch", NODES, TAGS);
    // n2 starts with it; n1 has it at a word start; n3 (hyphen, not a word
    // boundary) and n5 merely contain it — those two most recent first.
    expect(results.nodes.map((entry) => entry.id)).toEqual(["n2", "n1", "n3", "n5"]);
  });

  it("returns matching tags alphabetically after rank", () => {
    const results = searchConnections("launch", NODES, TAGS);
    expect(results.tags.map((entry) => entry.id)).toEqual(["t1", "t4"]);
  });

  it("leaves out what is already chosen", () => {
    const results = searchConnections("launch", NODES, TAGS, { nodeIds: ["n2"], tagIds: ["t1"] });
    expect(results.nodes.map((entry) => entry.id)).not.toContain("n2");
    expect(results.tags.map((entry) => entry.id)).toEqual(["t4"]);
  });

  it("caps nodes at eight and tags at five", () => {
    const many = Array.from({ length: 20 }, (_, index) =>
      node(`m${index}`, `Match ${index}`, `2026-09-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`),
    );
    const manyTags = Array.from({ length: 9 }, (_, index) => tag(`mt${index}`, `Match ${index}`));
    const results = searchConnections("match", many, manyTags);
    expect(results.nodes).toHaveLength(8);
    expect(results.nodes[0]!.id).toBe("m19");
    expect(results.tags).toHaveLength(5);
  });
});
