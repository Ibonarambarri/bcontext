import { describe, expect, it } from "vitest";
import {
  ancestorsOfTags,
  buildTagRefMatchers,
  expandTagIdsWithDescendants,
  nodeMatchesTagRefMatchers,
  type TagHierarchyRelation,
} from "./tag-hierarchy.js";

/** `relation: "parent"`: `from` is a CHILD of `to`. */
const child = (from: string, to: string): TagHierarchyRelation => ({
  from_tag_id: from,
  to_tag_id: to,
  relation: "parent",
});
const related = (from: string, to: string): TagHierarchyRelation => ({
  from_tag_id: from,
  to_tag_id: to,
  relation: "related",
});
const tag = (id: string, slug = id) => ({ id, slug, normalized_name: slug });

describe("expandTagIdsWithDescendants", () => {
  it("returns the seed itself when there are no relations", () => {
    expect(expandTagIdsWithDescendants(["a"], [])).toEqual(new Set(["a"]));
    expect(expandTagIdsWithDescendants([], [])).toEqual(new Set());
  });

  it("walks a multi-level chain down", () => {
    const relations = [child("b", "a"), child("c", "b"), child("d", "c")];
    expect(expandTagIdsWithDescendants(["a"], relations)).toEqual(new Set(["a", "b", "c", "d"]));
    expect(expandTagIdsWithDescendants(["b"], relations)).toEqual(new Set(["b", "c", "d"]));
    expect(expandTagIdsWithDescendants(["d"], relations)).toEqual(new Set(["d"]));
  });

  it("never walks upward (a child does not include its parent)", () => {
    expect(expandTagIdsWithDescendants(["b"], [child("b", "a")])).toEqual(new Set(["b"]));
  });

  it("covers branching trees and merges several seeds", () => {
    const relations = [child("b", "a"), child("c", "a"), child("e", "d")];
    expect(expandTagIdsWithDescendants(["a"], relations)).toEqual(new Set(["a", "b", "c"]));
    expect(expandTagIdsWithDescendants(["a", "d"], relations)).toEqual(
      new Set(["a", "b", "c", "d", "e"]),
    );
  });

  it("handles multi-parent DAGs (diamond) without duplicating work", () => {
    // d is a child of both b and c, which are both children of a.
    const relations = [child("b", "a"), child("c", "a"), child("d", "b"), child("d", "c")];
    expect(expandTagIdsWithDescendants(["a"], relations)).toEqual(new Set(["a", "b", "c", "d"]));
    expect(expandTagIdsWithDescendants(["b"], relations)).toEqual(new Set(["b", "d"]));
    expect(expandTagIdsWithDescendants(["c"], relations)).toEqual(new Set(["c", "d"]));
  });

  it("ignores related edges entirely", () => {
    const relations = [related("b", "a"), related("a", "c"), child("d", "a")];
    expect(expandTagIdsWithDescendants(["a"], relations)).toEqual(new Set(["a", "d"]));
  });

  it("terminates on defensive cycles (including self-loops)", () => {
    const relations = [child("b", "a"), child("a", "b"), child("c", "c")];
    expect(expandTagIdsWithDescendants(["a"], relations)).toEqual(new Set(["a", "b"]));
    expect(expandTagIdsWithDescendants(["c"], relations)).toEqual(new Set(["c"]));
  });
});

describe("ancestorsOfTags", () => {
  it("returns the empty set without relations or seeds", () => {
    expect(ancestorsOfTags(["a"], [])).toEqual(new Set());
    expect(ancestorsOfTags([], [child("b", "a")])).toEqual(new Set());
  });

  it("walks a chain up and excludes the seeds themselves", () => {
    const relations = [child("b", "a"), child("c", "b")];
    expect(ancestorsOfTags(["c"], relations)).toEqual(new Set(["a", "b"]));
    expect(ancestorsOfTags(["b"], relations)).toEqual(new Set(["a"]));
    expect(ancestorsOfTags(["a"], relations)).toEqual(new Set());
  });

  it("collects every parent in a multi-parent DAG", () => {
    const relations = [child("d", "b"), child("d", "c"), child("b", "a"), child("c", "a")];
    expect(ancestorsOfTags(["d"], relations)).toEqual(new Set(["a", "b", "c"]));
  });

  it("does not treat related edges as ancestry", () => {
    expect(ancestorsOfTags(["b"], [related("b", "a")])).toEqual(new Set());
  });

  it("excludes seeds even when a defensive cycle reaches them again", () => {
    const relations = [child("b", "a"), child("a", "b")];
    expect(ancestorsOfTags(["b"], relations)).toEqual(new Set(["a"]));
  });
});

describe("buildTagRefMatchers + nodeMatchesTagRefMatchers", () => {
  const tags = [tag("t-parent", "parent"), tag("t-child", "kid"), tag("t-other", "other")];
  const relations = [child("t-child", "t-parent")];

  it("matches a node tagged with a descendant when filtering by the parent id", () => {
    const matchers = buildTagRefMatchers({ ids: ["t-parent"] }, tags, relations);
    expect(nodeMatchesTagRefMatchers([tag("t-child", "kid")], matchers, "any")).toBe(true);
    expect(nodeMatchesTagRefMatchers([tag("t-other", "other")], matchers, "any")).toBe(false);
  });

  it("resolves slug references through the taxonomy before expanding", () => {
    const matchers = buildTagRefMatchers({ slugs: ["parent"] }, tags, relations);
    expect(nodeMatchesTagRefMatchers([tag("t-child", "kid")], matchers, "any")).toBe(true);
  });

  it("filtering by the child never matches a parent-tagged node", () => {
    const matchers = buildTagRefMatchers({ ids: ["t-child"] }, tags, relations);
    expect(nodeMatchesTagRefMatchers([tag("t-parent", "parent")], matchers, "any")).toBe(false);
  });

  it("keeps the raw slug fallback for references outside the taxonomy", () => {
    const matchers = buildTagRefMatchers({ slugs: ["ghost"] }, tags, relations);
    expect(nodeMatchesTagRefMatchers([tag("t-x", "ghost")], matchers, "any")).toBe(true);
    expect(nodeMatchesTagRefMatchers([tag("t-child", "kid")], matchers, "any")).toBe(false);
  });

  it("counts each requested reference once under all-match semantics", () => {
    const matchers = buildTagRefMatchers({ ids: ["t-parent", "t-other"] }, tags, relations);
    expect(
      nodeMatchesTagRefMatchers([tag("t-child", "kid"), tag("t-other", "other")], matchers, "all"),
    ).toBe(true);
    expect(nodeMatchesTagRefMatchers([tag("t-child", "kid")], matchers, "all")).toBe(false);
  });

  it("matches everything when no references were requested", () => {
    expect(nodeMatchesTagRefMatchers([tag("t-child", "kid")], [], "any")).toBe(true);
    expect(nodeMatchesTagRefMatchers([], [], "all")).toBe(true);
  });
});
