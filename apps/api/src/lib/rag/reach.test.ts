import { describe, expect, it } from "vitest";
import { boundLanesToReach } from "@/lib/rag";
import type { RetrievalLane, RetrievalLaneName } from "./scope";

/**
 * Retrieval is the one surface where filtering afterwards is not enough: the
 * content reaches the caller inside cited snippets long before anyone inspects
 * the node list. So the reach has to be a candidate boundary handed to the
 * search, and migration 0039 is explicit that `match_node_ids` was built as a
 * boundary and "not an ACL". These tests pin the moment it became both.
 */
describe("boundLanesToReach", () => {
  const lane = (name: RetrievalLaneName, node_ids: string[] | null): RetrievalLane => ({
    name,
    node_ids,
    boost: 1,
  });

  it("turns an unbounded lane into the reach", () => {
    // `node_ids: null` means "the whole workspace". The `auto` scope always adds
    // exactly such a lane, by contract — it is the one that would otherwise walk
    // straight past the grant.
    const bound = boundLanesToReach([lane("workspace", null)], new Set(["a", "b"]));
    expect(bound[0]?.node_ids?.sort()).toEqual(["a", "b"]);
  });

  it("intersects a bounded lane rather than replacing it", () => {
    const bound = boundLanesToReach([lane("selection", ["a", "x"])], new Set(["a", "b"]));
    expect(bound[0]?.node_ids).toEqual(["a"]);
  });

  it("empties a lane that shares nothing with the reach", () => {
    // An empty lane is skipped before the RPC runs, which is the correct
    // outcome: no candidates, no snippets.
    const bound = boundLanesToReach([lane("selection", ["x", "y"])], new Set(["a"]));
    expect(bound[0]?.node_ids).toEqual([]);
  });

  it("binds every lane, not just the first", () => {
    const bound = boundLanesToReach(
      [lane("neighborhood", ["a", "x"]), lane("workspace", null)],
      new Set(["a"]),
    );
    expect(bound.map((l) => l.node_ids)).toEqual([["a"], ["a"]]);
  });

  it("leaves lanes untouched for an unrestricted principal", () => {
    const lanes = [lane("workspace", null), lane("selection", ["a"])];
    expect(boundLanesToReach(lanes, null)).toEqual(lanes);
  });

  it("cannot widen a lane", () => {
    // The property that matters: whatever the scope asked for, the result is a
    // subset of the reach.
    const reach = new Set(["a", "b"]);
    for (const ids of [null, ["a"], ["a", "x"], ["x", "y"], []]) {
      const [bound] = boundLanesToReach([lane("workspace", ids)], reach);
      for (const id of bound?.node_ids ?? []) expect(reach.has(id)).toBe(true);
    }
  });
});
