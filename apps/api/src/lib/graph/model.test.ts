import { describe, expect, it } from "vitest";
import type { KnowledgeNode, TagRelation, WorkspaceTag } from "@bcontext-dev/contract/types";
import {
  buildGraphPayload,
  buildTagHierarchyLayout,
  fairCapMembershipEdges,
  describeNodeConnections,
  deterministicLayout,
  nextGraphNodeId,
  pickCenterTags,
  tagHierarchySize,
  traverseDepths,
  type GraphEdgePayload,
  type GraphTagPayload,
} from "@bcontext-dev/contract/graph/model";

const stamp = "2026-07-18T10:00:00.000Z";
function node(id: string, patch: Partial<KnowledgeNode> = {}): KnowledgeNode {
  return {
    id,
    workspace_id: "ws",
    parent_id: null,
    kind: "doc",
    slug: id,
    title: id,
    content_md: "",
    data: {},
    tags: [],
    status: null,
    priority: null,
    assignee_id: null,
    due_date: null,
    position: 0,
    created_by: null,
    created_at: stamp,
    updated_at: stamp,
    ...patch,
  };
}

function tag(id: string, name: string, patch: Partial<WorkspaceTag> = {}): WorkspaceTag {
  return {
    id,
    workspace_id: "ws",
    name,
    normalized_name: name.toLocaleLowerCase("en-US"),
    slug: name.toLocaleLowerCase("en-US").replaceAll(" ", "-"),
    description: null,
    merged_into_id: null,
    deleted_at: null,
    created_at: stamp,
    updated_at: stamp,
    ...patch,
  };
}

function tagPayload(id: string, name: string, assignmentCount = 1): GraphTagPayload {
  return {
    resource_type: "tag",
    id: `tag:${id}`,
    title: `#${name}`,
    kind: null,
    status: null,
    tags: [],
    depth: 1,
    tag: { id, name, slug: name.toLocaleLowerCase("en-US"), normalized_name: name.toLocaleLowerCase("en-US") },
    assignment_count: assignmentCount,
    x: 0.5,
    y: 0.5,
  };
}

describe("graph payload", () => {
  it("combines hierarchy, mentions and typed dependencies with visible direction and dedupe", () => {
    const nodes = [
      node("a", { content_md: "See /n/b" }),
      node("b", { parent_id: "a" }),
      node("c"),
    ];
    const snapshot = buildGraphPayload(nodes, [
      { from_node: "a", to_node: "b", relation: "references" },
      { from_node: "c", to_node: "b", relation: "blocked_by" },
      { from_node: "c", to_node: "b", relation: "blocked_by" },
    ], nodes.map((item) => item.id), { mode: "query" });

    expect(snapshot.edges.map((edge) => [edge.layer, edge.type, edge.from, edge.to])).toEqual([
      ["dependencies", "blocked_by", "c", "b"],
      ["hierarchy", "child", "a", "b"],
      ["references", "mention", "a", "b"],
    ]);
    expect(snapshot.edges.every((edge) => edge.directed)).toBe(true);
    expect(snapshot.schema_version).toBe(2);
    expect(snapshot.nodes.every((item) => item.resource_type === "node")).toBe(true);
  });

  it("traverses cycles once and ships the complete three-hop neighborhood", () => {
    const nodes = ["a", "b", "c", "d", "e"].map((id) => node(id));
    const edges = [
      { from_node: "a", to_node: "b", relation: "relates_to" },
      { from_node: "b", to_node: "c", relation: "relates_to" },
      { from_node: "c", to_node: "a", relation: "relates_to" },
      { from_node: "c", to_node: "d", relation: "relates_to" },
      { from_node: "d", to_node: "e", relation: "relates_to" },
    ];
    const depthTwo = buildGraphPayload(nodes, edges, nodes.map((item) => item.id), { mode: "centered", centerNodeId: "a", depth: 2, maxNodes: 3, maxEdges: 4 });
    expect(depthTwo.nodes.map((item) => item.id)).toEqual(["a", "b", "c", "d", "e"]);
    expect(depthTwo.nodes.map((item) => item.depth)).toEqual([0, 1, 1, 2, 3]);
    expect(depthTwo.truncated).toBe(false);
    expect(depthTwo.counts.hidden_nodes).toBe(0);

    const payloadEdges = edges.map((edge, index): GraphEdgePayload => ({ id: String(index), from: edge.from_node, to: edge.to_node, layer: "dependencies", type: edge.relation, label: edge.relation, directed: true, virtual: false }));
    expect([...traverseDepths("a", payloadEdges, 3).entries()]).toEqual([["a", 0], ["b", 1], ["c", 1], ["d", 2], ["e", 3]]);
  });

  it("is deterministic and honors bounded persisted coordinates", () => {
    const input = [{ id: "c", depth: 1 }, { id: "a", depth: 0 }, { id: "b", depth: 1 }];
    const first = deterministicLayout(input, "centered", "a");
    const second = deterministicLayout([...input].reverse(), "centered", "a");
    expect([...first.entries()]).toEqual([...second.entries()]);
    const persisted = deterministicLayout(input, "centered", "a", { b: { x: 4, y: -2 } });
    expect(persisted.get("b")).toEqual({ x: 0.96, y: 0.04 });
    const incremented = deterministicLayout([...input, { id: "new", depth: 1 }], "centered", "a");
    expect(incremented.get("b")).toEqual(first.get("b"));
    expect(incremented.get("c")).toEqual(first.get("c"));
  });

  it("keeps query layouts inside the readable full-canvas safe area", () => {
    const layout = deterministicLayout(
      Array.from({ length: 80 }, (_, index) => ({ id: `node-${index}`, depth: 0 })),
      "query",
      null,
    );
    expect([...layout.values()].every((point) => point.x >= 0.12 && point.x <= 0.88)).toBe(true);
    expect([...layout.values()].every((point) => point.y >= 0.22 && point.y <= 0.86)).toBe(true);
  });

  it("separates small query seeds before the organic layout settles", () => {
    const layout = deterministicLayout(
      ["bug", "decision", "doc", "adr", "task", "meeting"].map((id) => ({ id, depth: 0 })),
      "query",
      null,
    );
    const points = [...layout.values()];
    for (let index = 0; index < points.length; index++) {
      for (let other = index + 1; other < points.length; other++) {
        expect(
          Math.abs(points[index]!.x - points[other]!.x) >= 0.2 ||
          Math.abs(points[index]!.y - points[other]!.y) >= 0.12,
        ).toBe(true);
      }
    }
  });

  it.each(["kind", "parent"] as const)("ignores legacy %s auto-clustering and keeps the resolved graph complete", (clusterBy) => {
    const parent = node("parent", { title: "Initiative" });
    const nodes = [parent, ...Array.from({ length: 264 }, (_, index) => node(`n-${String(index).padStart(3, "0")}`, {
      kind: index % 2 ? "task" : "doc",
      parent_id: index < 200 ? "parent" : null,
    }))];
    const resultIds = nodes.slice(1).map((item) => item.id);
    const snapshot = buildGraphPayload(nodes, [], resultIds, { mode: "query", clusterBy, maxNodes: 80 });
    expect(snapshot.nodes).toHaveLength(264);
    expect(snapshot.nodes.every((item) => item.resource_type === "node" && item.cluster === undefined)).toBe(true);
    expect(snapshot.counts.hidden_nodes).toBe(0);
  });

  it("does not hide resolved nodes behind legacy renderer caps", () => {
    const nodes = Array.from({ length: 100 }, (_, index) => node(`plain-${index}`));
    const snapshot = buildGraphPayload(nodes, [], nodes.map((item) => item.id), {
      mode: "query",
      clusterBy: "none",
      maxNodes: 80,
    });
    expect(snapshot.nodes).toHaveLength(100);
    expect(snapshot.nodes.every((item) => item.cluster === undefined)).toBe(true);
    expect(snapshot.counts.hidden_nodes).toBe(0);
    expect(snapshot.truncated).toBe(false);
  });

  it("builds a complete representative 1k-node payload inside the interaction budget", () => {
    const nodes = Array.from({ length: 1_000 }, (_, index) => node(`bench-${index}`, {
      kind: index % 3 === 0 ? "task" : index % 3 === 1 ? "doc" : "decision",
    }));
    const started = performance.now();
    const snapshot = buildGraphPayload(nodes, [], nodes.map((item) => item.id), { clusterBy: "kind" });
    const elapsed = performance.now() - started;
    expect(snapshot.nodes).toHaveLength(1_000);
    expect(elapsed).toBeLessThan(250);
  });

  it("keeps the tag-hierarchy workspace hub inside the same 1k-node interaction budget", () => {
    const tags = Array.from({ length: 24 }, (_, index) => tag(`tag-${index}`, `Tag ${index}`));
    const nodes = Array.from({ length: 1_000 }, (_, index) => node(`bench-${index}`, {
      kind: index % 3 === 0 ? "task" : index % 3 === 1 ? "doc" : "decision",
      tags: [tags[index % tags.length]!],
    }));
    // A layered tag hierarchy: tag-N's parent is tag-(N mod 6), giving a mix
    // of roots, mid-level branches and leaves, plus a handful of "related"
    // cross-links and one multi-parent tag to exercise the min-depth BFS.
    const relations: TagRelation[] = tags.slice(6).map((child, index): TagRelation => ({
      id: `rel-parent-${index}`,
      workspace_id: "ws",
      from_tag_id: child.id,
      to_tag_id: tags[index % 6]!.id,
      relation: "parent",
      created_at: stamp,
    })).concat([
      { id: "rel-multi-parent", workspace_id: "ws", from_tag_id: "tag-10", to_tag_id: "tag-2", relation: "parent", created_at: stamp },
      { id: "rel-related-1", workspace_id: "ws", from_tag_id: "tag-1", to_tag_id: "tag-2", relation: "related", created_at: stamp },
    ]);
    const started = performance.now();
    const snapshot = buildGraphPayload(nodes, [], nodes.map((item) => item.id), {
      mode: "query",
      workspace: { id: "ws", name: "Bench workspace", slug: "bench", metadata: {} },
      tagRelations: relations,
    });
    const elapsed = performance.now() - started;
    expect(snapshot.nodes).toHaveLength(1_025); // 1000 content + 24 tag hubs + 1 fixed workspace hub
    expect(snapshot.hub_node_id).toBe("workspace:ws");
    expect(elapsed).toBeLessThan(250);
  });

  describe("tag-hierarchy knowledge-graph hub", () => {
    it("adds a fixed, distinctly-sized workspace hub with root tags fanned out, only in query mode", () => {
      const product = tag("tag-product", "Product");
      const nodes = [node("a", { tags: [product] }), node("b", { tags: [product] })];
      const workspace = { id: "ws-1", name: "Acme", slug: "acme", metadata: {} };

      const queried = buildGraphPayload(nodes, [], ["a", "b"], { mode: "query", workspace, tagRelations: [] });
      const hub = queried.nodes.find((item) => item.id === "workspace:ws-1");
      expect(hub).toMatchObject({ resource_type: "node", title: "Acme", x: 0.5, y: 0.5, size: 12 });
      expect(hub?.color).toBeTruthy();
      expect(queried.hub_node_id).toBe("workspace:ws-1");
      expect(queried.pinned_positions["workspace:ws-1"]).toEqual({ x: 0.5, y: 0.5 });
      // Distinctly bigger than any tag hub (~3.8-6) and content node (~5.8-10.2).
      const tagHub = queried.nodes.find((item) => item.resource_type === "tag")!;
      expect((hub as { size?: number }).size!).toBeGreaterThan(6);

      const centered = buildGraphPayload(nodes, [], ["a", "b"], { mode: "centered", centerNodeId: "a", workspace, tagRelations: [] });
      expect(centered.nodes.some((item) => item.id === "workspace:ws-1")).toBe(false);
      expect(centered.hub_node_id).toBeNull();
      void tagHub;
    });

    it("stays exactly centered even if a caller tries to persist a drag for it", () => {
      const nodes = [node("a")];
      const workspace = { id: "ws-1", name: "Acme", slug: "acme", metadata: {} };
      const snapshot = buildGraphPayload(nodes, [], ["a"], {
        mode: "query",
        workspace,
        tagRelations: [],
        positions: { "workspace:ws-1": { x: 0.1, y: 0.9 } },
      });
      const hub = snapshot.nodes.find((item) => item.id === "workspace:ws-1")!;
      expect({ x: hub.x, y: hub.y }).toEqual({ x: 0.5, y: 0.5 });
      expect(snapshot.pinned_positions["workspace:ws-1"]).toEqual({ x: 0.5, y: 0.5 });
    });

    it("computes multi-parent tag depth as the minimum path and keeps siblings contiguous within their parent's wedge", () => {
      const root = tagPayload("root", "Root", 3);
      const child = tagPayload("child", "Child", 2);
      const grandchild = tagPayload("grandchild", "Grandchild", 1);
      const sibling = tagPayload("sibling", "Sibling", 1);
      const relations: TagRelation[] = [
        { id: "r1", workspace_id: "ws", from_tag_id: "child", to_tag_id: "root", relation: "parent", created_at: stamp },
        { id: "r2", workspace_id: "ws", from_tag_id: "sibling", to_tag_id: "root", relation: "parent", created_at: stamp },
        // Multi-parent: grandchild has both "child" (depth 2) and "root" (depth 1) as parents.
        // The shortest path is through root directly, so depth must be 2, not 3.
        { id: "r3", workspace_id: "ws", from_tag_id: "grandchild", to_tag_id: "child", relation: "parent", created_at: stamp },
        { id: "r4", workspace_id: "ws", from_tag_id: "grandchild", to_tag_id: "root", relation: "parent", created_at: stamp },
      ];
      const hub = buildTagHierarchyLayout({ id: "ws", name: "WS", slug: "ws" }, [root, child, sibling, grandchild], relations);

      expect(hub.tagDepths.get("tag:root")).toBe(1);
      expect(hub.tagDepths.get("tag:child")).toBe(2);
      expect(hub.tagDepths.get("tag:sibling")).toBe(2);
      expect(hub.tagDepths.get("tag:grandchild")).toBe(2);

      // Only "root" hangs directly off the hub; "child" and "sibling" are
      // its depth-2 children. "grandchild" has two parents, but the minimal
      // depth-1-distance candidate is "root" (a direct parent giving depth 2
      // without going through "child"), so its primary layout parent — and
      // its hierarchy edge — resolve to "root" directly.
      expect(hub.edges).toContainEqual(expect.objectContaining({ from: "workspace:ws", to: "tag:root", type: "tag-root" }));
      expect(hub.edges).toContainEqual(expect.objectContaining({ from: "tag:root", to: "tag:sibling", type: "tag-parent" }));
      expect(hub.edges).toContainEqual(expect.objectContaining({ from: "tag:root", to: "tag:grandchild", type: "tag-parent" }));
      expect(hub.edges).toContainEqual(expect.objectContaining({ from: "tag:root", to: "tag:child", type: "tag-parent" }));

      // Ring geometry: "root" sits on the depth-1 radius, its children on
      // the depth-2 radius, and siblings never collapse onto the same point.
      const rootDepthRadius = 0.16;
      const secondRingRadius = 0.16 + 0.12;
      const distanceFromCenter = (p: { x: number; y: number }) => Math.hypot(p.x - 0.5, p.y - 0.5);
      expect(distanceFromCenter(hub.tagPositions.get("tag:root")!)).toBeCloseTo(rootDepthRadius, 5);
      expect(distanceFromCenter(hub.tagPositions.get("tag:child")!)).toBeCloseTo(secondRingRadius, 5);
      expect(hub.tagPositions.get("tag:child")).not.toEqual(hub.tagPositions.get("tag:sibling"));
    });

    it("gives a bigger subtree (more assigned nodes) a proportionally wider angular wedge", () => {
      // Three roots sharing the full circle, placed alphabetically: "a" and
      // "b" have equal (small) mass, "c" dwarfs them both. If wedges were
      // evenly split (ignoring mass), every adjacent gap would be equal; with
      // mass-proportional wedges the equal-mass neighbors ("a","b") must sit
      // far closer together than the low-mass/high-mass pair ("b","c").
      const a = tagPayload("a", "A", 1);
      const b = tagPayload("b", "B", 1);
      const c = tagPayload("c", "C", 38);
      const hub = buildTagHierarchyLayout({ id: "ws", name: "WS", slug: "ws" }, [a, b, c], []);
      const angleOf = (id: string) => {
        const point = hub.tagPositions.get(id)!;
        return Math.atan2(point.y - 0.5, point.x - 0.5);
      };
      const gapAB = Math.abs(angleOf("tag:a") - angleOf("tag:b"));
      const gapBC = Math.abs(angleOf("tag:b") - angleOf("tag:c"));
      expect(gapAB).toBeLessThan(gapBC / 4);
    });

    it("seeds knowledge nodes near their primary (first-assigned) tag, or near the hub when untagged", () => {
      const near = tag("tag-near", "Near");
      const far = tag("tag-far", "Far");
      const nodes = [
        node("tagged-near", { tags: [near] }),
        node("tagged-far", { tags: [far] }),
        node("untagged"),
      ];
      const workspace = { id: "ws-1", name: "Acme", slug: "acme", metadata: {} };
      const snapshot = buildGraphPayload(nodes, [], nodes.map((item) => item.id), { mode: "query", workspace, tagRelations: [] });

      const near_ = snapshot.nodes.find((item) => item.id === "tagged-near")!;
      const far_ = snapshot.nodes.find((item) => item.id === "tagged-far")!;
      const untagged = snapshot.nodes.find((item) => item.id === "untagged")!;
      const nearTag = snapshot.nodes.find((item) => item.id === "tag:tag-near")!;
      const farTag = snapshot.nodes.find((item) => item.id === "tag:tag-far")!;
      const center = snapshot.nodes.find((item) => item.id === "workspace:ws-1")!;

      const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);
      expect(dist(near_, nearTag)).toBeLessThan(dist(near_, farTag));
      expect(dist(far_, farTag)).toBeLessThan(dist(far_, nearTag));
      expect(dist(untagged, center)).toBeLessThan(dist(untagged, nearTag));

      // Seeded, not fixed: content nodes are free for the renderer's FA2 pass.
      expect(snapshot.pinned_positions["tagged-near"]).toBeUndefined();
      expect(snapshot.pinned_positions["tag:tag-near"]).toBeDefined();
    });

    it("sizes tags by hierarchy depth first — a root tag always beats a deeper one, regardless of usage", () => {
      const root = tagHierarchySize(1, 0, 0);
      const depthTwo = tagHierarchySize(2, 0, 0);
      const depthThreePlus = tagHierarchySize(3, 0, 0);
      expect(root).toBeGreaterThan(depthTwo);
      expect(depthTwo).toBeGreaterThan(depthThreePlus);
      // A heavily-used deep tag still can't out-size a barely-used root: the
      // usage-based fine-adjust is bounded well under the inter-tier gap.
      expect(tagHierarchySize(1, 0, 100)).toBeGreaterThan(tagHierarchySize(2, 100, 100));
      expect(tagHierarchySize(2, 0, 100)).toBeGreaterThan(tagHierarchySize(3, 100, 100));
      // Within the same tier, usage still nudges the ordering.
      expect(tagHierarchySize(1, 50, 100)).toBeGreaterThan(tagHierarchySize(1, 0, 100));
    });
  });

  describe("goals — the North Star is the center and company goals ring it", () => {
    const workspace = { id: "ws-1", name: "Acme", slug: "acme", metadata: {} };
    const distance = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);
    const fromCenter = (p: { x: number; y: number }) => distance(p, { x: 0.5, y: 0.5 });
    function goal(id: string, data: Record<string, unknown>, patch: Partial<KnowledgeNode> = {}): KnowledgeNode {
      return node(id, { kind: "goal", status: "on_track", data, ...patch });
    }

    it("promotes the real North Star node to the center, keeping the workspace gradient", () => {
      const northStar = goal("ns", { root: true, scope: "company" }, { title: "Ser el sistema operativo del contexto" });
      const nodes = [northStar, node("a")];
      const snapshot = buildGraphPayload(nodes, [], ["ns", "a"], { mode: "query", workspace, tagRelations: [] });

      // The center is addressable: its id is the node's own id, so clicking
      // it opens the mission instead of a decoration nothing can link to.
      expect(snapshot.hub_node_id).toBe("ns");
      expect(snapshot.nodes.some((item) => item.id === "workspace:ws-1")).toBe(false);
      const center = snapshot.nodes.find((item) => item.id === "ns")!;
      expect(center).toMatchObject({ resource_type: "node", kind: "goal", title: "Ser el sistema operativo del contexto", x: 0.5, y: 0.5, size: 12 });
      expect(snapshot.pinned_positions["ns"]).toEqual({ x: 0.5, y: 0.5 });
      // Exactly one payload for it: promoted in place, never duplicated.
      expect(snapshot.nodes.filter((item) => item.id === "ns")).toHaveLength(1);
      expect(snapshot.counts.visible_nodes).toBe(2);

      // Day 1 the graph must look like the graph people already know: the
      // North Star wears the workspace gradient, not the color of kind goal.
      const fallback = buildGraphPayload([node("a")], [], ["a"], { mode: "query", workspace, tagRelations: [] });
      const syntheticHub = fallback.nodes.find((item) => item.id === "workspace:ws-1")!;
      expect(center.color).toBe(syntheticHub.color);
    });

    it("still fabricates the synthetic hub when the workspace has no North Star yet", () => {
      // The backfill runs workspace by workspace; a graph with no center at
      // all would be a broken window for everyone it has not reached.
      const projectGoal = goal("g-project", { scope: "project" });
      const snapshot = buildGraphPayload([projectGoal, node("a")], [], ["g-project", "a"], {
        mode: "query",
        workspace,
        tagRelations: [],
      });
      expect(snapshot.hub_node_id).toBe("workspace:ws-1");
      const hub = snapshot.nodes.find((item) => item.id === "workspace:ws-1")!;
      expect(hub).toMatchObject({ title: "Acme", kind: "entity", x: 0.5, y: 0.5, size: 12 });
      // A project goal is not strategy-ring material: it hangs off its
      // company goal like any other content node.
      expect(snapshot.edges.some((edge) => edge.type === "goal-scope")).toBe(false);
      expect(fromCenter(snapshot.nodes.find((item) => item.id === "g-project")!)).toBeLessThan(0.13);
    });

    it("renders the North Star even when the query result left it out, edges included", () => {
      const northStar = goal("ns", { root: true, scope: "company" });
      const task = node("t", { kind: "task" });
      const snapshot = buildGraphPayload([northStar, task], [{ from_node: "t", to_node: "ns", relation: "contributes_to" }], ["t"], {
        mode: "query",
        workspace,
        tagRelations: [],
      });
      expect(snapshot.hub_node_id).toBe("ns");
      expect(snapshot.nodes.find((item) => item.id === "ns")).toBeTruthy();
      // A landmark the result did not return is not content: it does not
      // inflate the visible count, but arrows still reach it.
      expect(snapshot.counts.visible_nodes).toBe(1);
      expect(snapshot.edges).toContainEqual(expect.objectContaining({
        from: "t",
        to: "ns",
        layer: "dependencies",
        type: "contributes_to",
        directed: true,
      }));
    });

    it("puts company goals on an inner ring: closer than root tags, bigger, anchored to the hub even when tagged", () => {
      const product = tag("tag-product", "Product");
      const northStar = goal("ns", { root: true, scope: "company" });
      const revenue = goal("g-revenue", { scope: "company" }, { tags: [product] });
      const nodes = [northStar, revenue, node("a", { tags: [product] })];
      const snapshot = buildGraphPayload(nodes, [], nodes.map((item) => item.id), { mode: "query", workspace, tagRelations: [] });

      const goalNode = snapshot.nodes.find((item) => item.id === "g-revenue")!;
      const rootTag = snapshot.nodes.find((item) => item.id === "tag:tag-product")!;
      expect(fromCenter(goalNode)).toBeCloseTo(0.18, 5);
      expect(fromCenter(rootTag)).toBeCloseTo(0.35, 5);
      // Radius, size and color: three signals saying the same thing, because
      // a root ring mixing taxonomy and real nodes is only legible if the
      // difference is impossible to miss.
      expect(goalNode.size!).toBeGreaterThan(rootTag.size ?? tagHierarchySize(1, 1, 1));
      expect(goalNode.color).toBeTruthy();
      expect(goalNode.color).not.toBe(snapshot.nodes.find((item) => item.id === "ns")!.color);
      // Its tag colors it and still draws the taxonomy membership, but it
      // never re-parents it: scope is decided at creation and persisted.
      expect(snapshot.edges).toContainEqual(expect.objectContaining({ from: "ns", to: "g-revenue", type: "goal-scope" }));
      expect(snapshot.edges.some((edge) => edge.layer === "taxonomy" && edge.to === "g-revenue")).toBe(true);
      // Fixed geometry: the force pass may not drift the strategy ring.
      expect(snapshot.pinned_positions["g-revenue"]).toEqual({ x: goalNode.x, y: goalNode.y });
    });

    it("lets the persisted edge win when a company goal really hangs off the North Star", () => {
      const northStar = goal("ns", { root: true, scope: "company" });
      const revenue = goal("g-revenue", { scope: "company" }, { parent_id: "ns" });
      const snapshot = buildGraphPayload([northStar, revenue], [], ["ns", "g-revenue"], {
        mode: "query",
        workspace,
        tagRelations: [],
      });
      const between = snapshot.edges.filter((edge) =>
        (edge.from === "ns" && edge.to === "g-revenue") || (edge.from === "g-revenue" && edge.to === "ns"));
      expect(between).toHaveLength(1);
      expect(between[0]!.type).toBe("child");
    });

    it("orbits a task around the goal it contributes to, and keeps every other target as an arrow", () => {
      const northStar = goal("ns", { root: true, scope: "company" });
      const revenue = goal("g-revenue", { scope: "company" });
      const retention = goal("g-retention", { scope: "company" });
      const task = node("t", { kind: "task" });
      const snapshot = buildGraphPayload(
        [northStar, revenue, retention, task],
        [
          { from_node: "t", to_node: "g-revenue", relation: "contributes_to" },
          { from_node: "t", to_node: "g-retention", relation: "contributes_to" },
        ],
        ["ns", "g-revenue", "g-retention", "t"],
        { mode: "query", workspace, tagRelations: [] },
      );

      const taskNode = snapshot.nodes.find((item) => item.id === "t")!;
      const retentionNode = snapshot.nodes.find((item) => item.id === "g-retention")!;
      const revenueNode = snapshot.nodes.find((item) => item.id === "g-revenue")!;
      // N destinations, one seed: the first target by edge id ("g-retention")
      // wins the orbit, the rest stay visible as dependency arrows.
      expect(distance(taskNode, retentionNode)).toBeLessThan(fromCenter(taskNode));
      expect(distance(taskNode, retentionNode)).toBeLessThan(distance(taskNode, revenueNode));
      expect(snapshot.edges.filter((edge) => edge.type === "contributes_to")).toHaveLength(2);
      // Untagged work with a goal is not anchorless: it belongs to the goal
      // it pushes, so the layout leaves it free for the force pass.
      expect(snapshot.pinned_positions["t"]).toBeUndefined();
    });
  });

  describe("filter-centered graph views — the filter IS the center", () => {
    const workspace = { id: "ws-1", name: "Acme", slug: "acme", metadata: {} };

    it("re-roots a single-tag filter on that tag: pinned center, no workspace hub, satellites ring outward", () => {
      const business = tag("t-business", "Business");
      const pricing = tag("t-pricing", "Pricing");
      const relations: TagRelation[] = [
        { id: "r1", workspace_id: "ws", from_tag_id: "t-pricing", to_tag_id: "t-business", relation: "parent", created_at: stamp },
      ];
      const nodes = [
        node("a", { tags: [business, pricing] }),
        node("b", { tags: [business] }),
      ];
      const snapshot = buildGraphPayload(nodes, [], ["a", "b"], {
        mode: "query",
        workspace,
        tagRelations: relations,
        centerTagIds: ["t-business"],
      });

      expect(snapshot.nodes.some((item) => item.id.startsWith("workspace:"))).toBe(false);
      expect(snapshot.hub_node_id).toBe("tag:t-business");
      const center = snapshot.nodes.find((item) => item.id === "tag:t-business")!;
      expect(center.role).toBe("filter-center");
      expect({ x: center.x, y: center.y }).toEqual({ x: 0.5, y: 0.5 });
      expect(center.size).toBeGreaterThan(9);
      expect(snapshot.pinned_positions["tag:t-business"]).toEqual({ x: 0.5, y: 0.5 });

      // The descendant tag renders as a pinned satellite off-center; only
      // tags on the filter's own chain are present at all.
      const satellite = snapshot.nodes.find((item) => item.id === "tag:t-pricing")!;
      expect(satellite.role).toBeUndefined();
      expect(Math.hypot(satellite.x - 0.5, satellite.y - 0.5)).toBeGreaterThan(0.1);
      expect(snapshot.pinned_positions["tag:t-pricing"]).toEqual({ x: satellite.x, y: satellite.y });

      // A drag persisted for the single center never dislodges it.
      const dragged = buildGraphPayload(nodes, [], ["a", "b"], {
        mode: "query",
        workspace,
        tagRelations: relations,
        centerTagIds: ["t-business"],
        positions: { "tag:t-business": { x: 0.1, y: 0.9 } },
      });
      expect(dragged.pinned_positions["tag:t-business"]).toEqual({ x: 0.5, y: 0.5 });
    });

    it("renders only the filter chain: co-tags outside the filter's descendants never become hubs", () => {
      // Real-workspace shape: three tag families, the view filters by one.
      const business = tag("t-business", "Business");
      const research = tag("t-research", "Research");
      const surveys = tag("t-surveys", "Surveys");
      const product = tag("t-product", "Product");
      const nexo = tag("t-nexo", "NEXO");
      const tech = tag("t-tech", "Tech");
      const ai = tag("t-ai", "AI");
      const relations: TagRelation[] = [
        { id: "r1", workspace_id: "ws", from_tag_id: "t-research", to_tag_id: "t-business", relation: "parent", created_at: stamp },
        // A grandchild of the filter nobody in the result carries: subtree
        // completeness must render it anyway, hooked to its parent.
        { id: "r5", workspace_id: "ws", from_tag_id: "t-surveys", to_tag_id: "t-research", relation: "parent", created_at: stamp },
        { id: "r2", workspace_id: "ws", from_tag_id: "t-nexo", to_tag_id: "t-product", relation: "parent", created_at: stamp },
        { id: "r3", workspace_id: "ws", from_tag_id: "t-ai", to_tag_id: "t-tech", relation: "parent", created_at: stamp },
        { id: "r4", workspace_id: "ws", from_tag_id: "t-nexo", to_tag_id: "t-ai", relation: "related", created_at: stamp },
      ];
      const nodes = [
        node("a", { tags: [business, research] }),
        // Result nodes carry co-tags from every other family — the exact
        // condition that used to re-draw the whole workspace taxonomy.
        node("b", { tags: [business, product, tech] }),
        node("c", { tags: [research, nexo, ai] }), // descendant-matched, no direct filter tag
        node("d", { tags: [business] }),
      ];
      const snapshot = buildGraphPayload(nodes, [], ["a", "b", "c", "d"], {
        mode: "query",
        workspace,
        tagRelations: relations,
        centerTagIds: ["t-business"],
        chainTags: [business, research, surveys],
      });

      // Chain only, but the WHOLE chain: the filter, its descendants carried
      // by the result, and its unused descendants (empty, still connected).
      expect(snapshot.nodes.filter((item) => item.resource_type === "tag").map((item) => item.id).sort())
        .toEqual(["tag:t-business", "tag:t-research", "tag:t-surveys"]);
      const emptyChild = snapshot.nodes.find((item) => item.id === "tag:t-surveys")!;
      expect(emptyChild.resource_type === "tag" && emptyChild.assignment_count).toBe(0);
      expect(snapshot.edges).toContainEqual(expect.objectContaining({
        from: "tag:t-research",
        to: "tag:t-surveys",
        type: "tag-parent",
      }));
      // Every result node still renders, including ones whose only co-tags
      // were pruned — they keep their canonical tag names for the inspector.
      expect(snapshot.nodes.filter((item) => item.resource_type === "node").map((item) => item.id).sort())
        .toEqual(["a", "b", "c", "d"]);
      expect(snapshot.nodes.find((item) => item.id === "b")!.tags).toEqual(["business", "product", "tech"]);
      // No membership, hierarchy or related edge may reference a pruned hub.
      const edgeEndpoints = snapshot.edges.flatMap((edge) => [edge.from, edge.to]);
      for (const endpoint of edgeEndpoints) {
        expect(["tag:t-product", "tag:t-nexo", "tag:t-tech", "tag:t-ai"]).not.toContain(endpoint);
      }
      // Filtered snapshots ship the workspace-level palette slots so the
      // center keeps the exact color its family has in the main graph:
      // Business is the biggest family here (2 tags + 4 primary nodes),
      // Product and Tech tie and order by name.
      expect(snapshot.community_palette).toEqual({
        "tag:t-business": 0,
        "tag:t-product": 1,
        "tag:t-tech": 2,
      });

      // The unfiltered knowledge graph keeps every tag (contract unchanged)
      // and computes its communities client-side — no palette hints shipped.
      const unfiltered = buildGraphPayload(nodes, [], ["a", "b", "c", "d"], {
        mode: "query",
        workspace,
        tagRelations: relations,
      });
      expect(unfiltered.nodes.filter((item) => item.resource_type === "tag")).toHaveLength(6);
      expect(unfiltered.community_palette).toBeUndefined();
    });

    it("promotes the highest-hierarchy filter tag and demotes the deeper one to a satellite", () => {
      const product = tag("t-product", "Product");
      const graphTag = tag("t-graph", "Graph");
      const relations: TagRelation[] = [
        { id: "r1", workspace_id: "ws", from_tag_id: "t-graph", to_tag_id: "t-product", relation: "parent", created_at: stamp },
      ];
      const nodes = [
        node("a", { tags: [product, graphTag] }),
        node("b", { tags: [graphTag, product] }),
      ];
      const snapshot = buildGraphPayload(nodes, [], ["a", "b"], {
        mode: "query",
        workspace,
        tagRelations: relations,
        centerTagIds: ["t-graph", "t-product"],
      });
      expect(snapshot.hub_node_id).toBe("tag:t-product");
      expect(snapshot.nodes.find((item) => item.id === "tag:t-product")!.role).toBe("filter-center");
      expect(snapshot.nodes.find((item) => item.id === "tag:t-graph")!.role).toBeUndefined();
      // The demoted child hangs off the center through a real hierarchy edge.
      expect(snapshot.edges).toContainEqual(expect.objectContaining({
        from: "tag:t-product",
        to: "tag:t-graph",
        type: "tag-parent",
      }));
    });

    it("renders equal-hierarchy filters as connected co-centers, both near the canvas center", () => {
      const business = tag("t-business", "Business");
      const tech = tag("t-tech", "Tech");
      const nodes = [
        node("a", { tags: [business] }),
        node("b", { tags: [tech] }),
        node("c", { tags: [business, tech] }),
      ];
      const snapshot = buildGraphPayload(nodes, [], ["a", "b", "c"], {
        mode: "query",
        workspace,
        tagRelations: [],
        centerTagIds: ["t-business", "t-tech"],
      });
      // No single immovable hub — both are top nodes.
      expect(snapshot.hub_node_id).toBeNull();
      const centers = snapshot.nodes.filter((item) => item.role === "filter-center");
      expect(centers.map((item) => item.id).sort()).toEqual(["tag:t-business", "tag:t-tech"]);
      for (const center of centers) {
        expect(Math.hypot(center.x - 0.5, center.y - 0.5)).toBeLessThanOrEqual(0.09 + 1e-9);
      }
      expect(snapshot.edges).toContainEqual(expect.objectContaining({
        type: "co-filter",
        from: "tag:t-business",
        to: "tag:t-tech",
        virtual: true,
      }));
    });

    it("pickCenterTags: hierarchy depth first, assignment count as the proxy without hierarchy", () => {
      const relations: TagRelation[] = [
        { id: "r1", workspace_id: "ws", from_tag_id: "child", to_tag_id: "root", relation: "parent", created_at: stamp },
      ];
      const counts = new Map([["root", 2], ["child", 40], ["other", 40]]);
      // Hierarchy exists: the shallower tag wins no matter the usage skew.
      expect(pickCenterTags(["child", "root"], relations, counts)).toEqual(["root"]);
      // Tie at the same depth → co-centers, usage-descending order.
      expect(pickCenterTags(["other", "root"], relations, counts)).toEqual(["other", "root"]);
      // No hierarchy anywhere → usage proxy; strict winner.
      expect(pickCenterTags(["root", "child"], [], counts)).toEqual(["child"]);
      // Usage tie without hierarchy → co-centers.
      expect(pickCenterTags(["other", "child"], [], counts)).toEqual(["child", "other"]);
    });
  });

  it("renders stable tag hubs and every multi-tag assignment as virtual taxonomy", () => {
    const product = tag("tag-product", "Product");
    const tech = tag("tag-tech", "Tech");
    const nodes = [
      node("a", { tags: [product, tech] }),
      node("b", { tags: [product] }),
      node("untagged"),
    ];
    const snapshot = buildGraphPayload(nodes, [], nodes.map((item) => item.id));
    const hubs = snapshot.nodes.filter((item) => item.resource_type === "tag");
    const memberships = snapshot.edges.filter((edge) => edge.layer === "taxonomy");

    expect(hubs.map((hub) => [hub.id, hub.title, hub.kind])).toEqual([
      ["tag:tag-product", "#Product", null],
      ["tag:tag-tech", "#Tech", null],
    ]);
    expect(memberships.map((edge) => [edge.from, edge.to, edge.virtual, edge.directed])).toEqual([
      ["tag:tag-product", "a", true, false],
      ["tag:tag-product", "b", true, false],
      ["tag:tag-tech", "a", true, false],
    ]);
    expect(snapshot.counts).toMatchObject({ visible_nodes: 3, visible_tags: 2, visible_membership_edges: 3 });
  });

  it("omits redundant filter hubs without stripping canonical node tags", () => {
    const product = tag("tag-product", "Product");
    const tech = tag("tag-tech", "Tech");
    const nodes = [
      node("a", { tags: [product, tech] }),
      node("b", { tags: [product] }),
    ];
    const snapshot = buildGraphPayload(nodes, [], nodes.map((item) => item.id), {
      omitTagIds: [product.id],
    });

    expect(snapshot.nodes.filter((item) => item.resource_type === "tag").map((item) => item.id))
      .toEqual(["tag:tag-tech"]);
    expect(snapshot.edges.filter((edge) => edge.layer === "taxonomy").map((edge) => [edge.from, edge.to]))
      .toEqual([["tag:tag-tech", "a"]]);
    expect(snapshot.nodes.filter((item) => item.resource_type === "node").map((item) => item.tags))
      .toEqual([["product", "tech"], ["product"]]);
    expect(snapshot.counts).toMatchObject({ visible_nodes: 2, visible_tags: 1, visible_membership_edges: 1 });
  });

  it("uses tag hubs as centered connectors without inventing node-to-node edges", () => {
    const shared = tag("shared", "Shared");
    const nodes = [
      node("a", { tags: [shared], content_md: "alpha roadmap planning" }),
      node("b", { tags: [shared], content_md: "beta invoice accounting" }),
    ];
    const snapshot = buildGraphPayload(nodes, [], ["a", "b"], { mode: "centered", centerNodeId: "a", depth: 2 });
    expect(snapshot.nodes.map((item) => [item.id, item.depth])).toEqual([
      ["a", 0],
      ["b", 2],
      ["tag:shared", 1],
    ]);
    expect(snapshot.edges.every((edge) => edge.layer === "taxonomy")).toBe(true);
  });

  it("keeps every resolved node, tag and membership despite legacy presentation caps", () => {
    const popular = tag("a-popular", "Popular");
    const secondary = tag("b-secondary", "Secondary");
    const nodes = Array.from({ length: 8 }, (_, index) => node(`n-${index}`, {
      tags: index < 4 ? [popular, secondary] : [popular],
    }));
    const snapshot = buildGraphPayload(nodes, [], nodes.map((item) => item.id), {
      maxNodes: 5,
      maxTags: 2,
      maxMembershipEdges: 3,
    });
    expect(snapshot.nodes.filter((item) => item.resource_type === "node")).toHaveLength(8);
    expect(snapshot.nodes.filter((item) => item.resource_type === "tag")).toHaveLength(2);
    const memberships = snapshot.edges.filter((edge) => edge.layer === "taxonomy");
    expect(memberships).toHaveLength(12);
    expect(new Set(memberships.map((edge) => edge.from))).toEqual(new Set(["tag:a-popular", "tag:b-secondary"]));
    expect(snapshot.counts).toMatchObject({ hidden_nodes: 0, visible_tags: 2, visible_membership_edges: 12, hidden_membership_edges: 0 });

    const withoutTags = nodes.map((item) => ({ ...item, tags: [] }));
    const baseline = buildGraphPayload(withoutTags, [], withoutTags.map((item) => item.id), { maxNodes: 5 });
    expect(snapshot.nodes.filter((item) => item.resource_type === "node").map((item) => item.id))
      .toEqual(baseline.nodes.map((item) => item.id));
  });

  it("round-robins membership lanes and ignores inactive taxonomy", () => {
    const edges = [
      ...Array.from({ length: 5 }, (_, index): GraphEdgePayload => ({ id: `a-${index}`, from: "tag:a", to: `a${index}`, layer: "taxonomy", type: "tag_membership", label: "tagged", directed: false, virtual: true })),
      ...Array.from({ length: 2 }, (_, index): GraphEdgePayload => ({ id: `b-${index}`, from: "tag:b", to: `b${index}`, layer: "taxonomy", type: "tag_membership", label: "tagged", directed: false, virtual: true })),
    ];
    expect(fairCapMembershipEdges(edges, 3).map((edge) => edge.id)).toEqual(["a-0", "a-1", "b-0"]);

    const active = tag("active", "Renamed");
    const merged = tag("merged", "Old", { merged_into_id: active.id });
    const deleted = tag("deleted", "Deleted", { deleted_at: stamp });
    const snapshot = buildGraphPayload([node("a", { tags: [active, merged, deleted] })], [], ["a"]);
    expect(snapshot.nodes.filter((item) => item.resource_type === "tag").map((item) => [item.id, item.title]))
      .toEqual([["tag:active", "#Renamed"]]);
  });

  it("creates virtual similarity edges without mutating durable input", () => {
    const nodes = [
      node("a", { title: "Graph renderer design", content_md: "semantic graph layout renderer" }),
      node("b", { title: "Graph renderer tests", content_md: "semantic graph layout tests" }),
      node("c", { title: "Payroll", content_md: "invoice accounting" }),
    ];
    const durable: Array<{ from_node: string; to_node: string; relation: string }> = [];
    const snapshot = buildGraphPayload(nodes, durable, nodes.map((item) => item.id), { mode: "query", layers: ["semantic"] });
    const semantic = snapshot.edges.filter((edge) => edge.layer === "semantic");
    expect(semantic).toHaveLength(1);
    expect(semantic[0]).toMatchObject({ from: "a", to: "b", directed: false, virtual: true, type: "semantic_similarity" });
    expect(durable).toEqual([]);
  });

  it("exposes accessible edge type, direction and virtual state", () => {
    const edge: GraphEdgePayload = { id: "e", from: "a", to: "b", layer: "semantic", type: "semantic_similarity", label: "82% similar", directed: false, virtual: true };
    const nodes = [{ id: "a", title: "Alpha" }, { id: "b", title: "Beta" }];
    expect(describeNodeConnections("a", [edge], nodes)).toBe("82% similar with Beta (virtual)");
    const dependency = { ...edge, id: "d", layer: "dependencies" as const, type: "blocked_by", label: "blocked by", directed: true, virtual: false };
    expect(describeNodeConnections("b", [dependency], nodes)).toBe("incoming blocked by from Alpha");
    const positions = new Map([
      ["a", { x: 0.5, y: 0.5 }],
      ["left", { x: 0.2, y: 0.5 }],
      ["up", { x: 0.5, y: 0.2 }],
    ]);
    expect(nextGraphNodeId("a", "ArrowLeft", positions)).toBe("left");
    expect(nextGraphNodeId("a", "ArrowUp", positions)).toBe("up");
    expect(nextGraphNodeId("a", "ArrowRight", positions)).toBeNull();
  });
});
