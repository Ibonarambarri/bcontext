import { beforeEach, describe, expect, it } from "vitest";
import { createWorkspace } from "@/lib/demo-store";
import { resolveDemoStorage } from "@/lib/storage/demo";
import { resetDemoViewsForTests } from "@/lib/views/store";
import { GET, POST } from "./route";
import { GET as GET_ONE, PATCH, DELETE } from "./[id]/route";
import { POST as DUPLICATE } from "./[id]/duplicate/route";
import { POST as RESOLVE_VIEW } from "./[id]/resolve/route";
import { POST as RESOLVE_QUERY } from "./resolve/route";

const headers = { "content-type": "application/json", origin: "http://localhost", host: "localhost" };
function request(path: string, method = "GET", body?: unknown) {
  return new Request(`http://localhost${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
function setup() {
  const workspace = createWorkspace({ name: "REST views", slug: `rest-views-${Date.now()}-${Math.random()}` });
  const storage = resolveDemoStorage(workspace.slug)!;
  return { slug: workspace.slug, storage };
}
const query = { schema_version: 1 as const };
const presentation = { schema_version: 1 as const, renderer: "list" as const };

describe("REST saved views", () => {
  beforeEach(() => resetDemoViewsForTests());

  it("lists seeds and performs custom CRUD, duplication and optimistic concurrency", async () => {
    const { slug } = setup();
    const listed = await GET(request(`/api/views?workspace=${slug}`));
    expect(listed.status).toBe(200);
    expect(((await listed.json()) as { views: unknown[] }).views).toHaveLength(8);

    const createdResponse = await POST(request("/api/views", "POST", { workspace: slug, name: "Mine", query, presentation }));
    expect(createdResponse.status).toBe(201);
    const created = ((await createdResponse.json()) as { view: { id: string; version: number } }).view;

    const fetched = await GET_ONE(request(`/api/views/${created.id}?workspace=${slug}`), { params: Promise.resolve({ id: created.id }) });
    expect(fetched.status).toBe(200);
    const duplicate = await DUPLICATE(request(`/api/views/${created.id}/duplicate`, "POST", { workspace: slug }), { params: Promise.resolve({ id: created.id }) });
    expect(duplicate.status).toBe(201);

    const updated = await PATCH(request(`/api/views/${created.id}`, "PATCH", { workspace: slug, expected_version: 1, name: "Team", visibility: "workspace" }), { params: Promise.resolve({ id: created.id }) });
    expect(updated.status).toBe(200);
    const conflict = await PATCH(request(`/api/views/${created.id}`, "PATCH", { workspace: slug, expected_version: 1, name: "Stale" }), { params: Promise.resolve({ id: created.id }) });
    expect(conflict.status).toBe(409);

    const deleted = await DELETE(request(`/api/views/${created.id}?workspace=${slug}&expected_version=2`, "DELETE"), { params: Promise.resolve({ id: created.id }) });
    expect(deleted.status).toBe(200);
  });

  it("resolves both direct and saved queries to canonical ids with scope metadata", async () => {
    const { slug, storage } = setup();
    const node = await storage.createNode({ title: "Task", kind: "task", parent_id: null, status: "todo" });
    const blocker = await storage.createNode({ title: "Blocker", kind: "task", parent_id: null, status: "in_progress" });
    await storage.createEdge({ from_node: node.id, to_node: blocker.id, relation: "blocked_by" });
    const direct = await RESOLVE_QUERY(request("/api/views/resolve", "POST", { workspace: slug, query: { schema_version: 1, kinds: ["task"] } }));
    const directBody = (await direct.json()) as { result: { node_ids: string[]; scope: { workspace_id: string } } };
    expect(directBody.result.node_ids).toContain(node.id);
    expect(directBody.result.scope.workspace_id).toBe(storage.workspace.id);

    const createdResponse = await POST(request("/api/views", "POST", {
      workspace: slug,
      name: "Tasks",
      query: { schema_version: 1, kinds: ["task"] },
      presentation: { schema_version: 1, renderer: "board", group_by: "status" },
    }));
    const view = ((await createdResponse.json()) as { view: { id: string } }).view;
    const saved = await RESOLVE_VIEW(request(`/api/views/${view.id}/resolve?workspace=${slug}`, "POST"), { params: Promise.resolve({ id: view.id }) });
    const savedBody = await saved.json() as {
      result: { node_ids: string[] };
      board: { blockers: Record<string, { total: number; active: number }> };
    };
    expect(savedBody.result.node_ids).toEqual([blocker.id, node.id].sort());
    expect(savedBody.board.blockers[node.id]).toEqual({ total: 1, active: 1 });
  });

  it("resolves the system roadmap to goal rows with cards placed by contributes_to", async () => {
    const { slug, storage } = setup();
    const goal = await storage.createNode({
      title: "Ship the beta", kind: "goal", parent_id: null, status: "on_track", due_date: "2099-12-31",
      data: { scope: "company", timeframe: { start: "2026-01-01", cycle: null } },
    });
    const pushing = await storage.createNode({ title: "Guide", kind: "task", parent_id: null, status: "in_progress" });
    const loose = await storage.createNode({ title: "Loose", kind: "task", parent_id: null, status: "backlog" });
    await storage.createEdge({ from_node: pushing.id, to_node: goal.id, relation: "contributes_to" });

    const listed = await GET(request(`/api/views?workspace=${slug}`));
    const roadmap = ((await listed.json()) as { views: Array<{ id: string; system_key: string | null }> }).views
      .find((view) => view.system_key === "roadmap")!;
    const resolved = await RESOLVE_VIEW(request(`/api/views/${roadmap.id}/resolve?workspace=${slug}`, "POST"), { params: Promise.resolve({ id: roadmap.id }) });
    expect(resolved.status).toBe(200);
    const body = (await resolved.json()) as {
      result: { node_ids: string[] };
      roadmap: { lanes: Array<{ id: string; cells: Record<string, Array<{ id: string }>> }> };
    };
    // Goals are rows, never cards: the view's query is tasks and bugs.
    expect(body.result.node_ids).toEqual([loose.id, pushing.id].sort());
    expect(body.roadmap.lanes.map((lane) => lane.id)).toEqual([goal.id, "unassigned"]);
    expect(body.roadmap.lanes[0]!.cells.now!.map((card) => card.id)).toEqual([pushing.id]);
    expect(body.roadmap.lanes[1]!.cells.later!.map((card) => card.id)).toEqual([loose.id]);
  });

  it("keeps board resolution behind the same permission and origin gate as every saved view", async () => {
    const { slug } = setup();
    const listed = await GET(request(`/api/views?workspace=${slug}`));
    const tasks = ((await listed.json()) as { views: Array<{ id: string; system_key: string | null }> }).views.find((view) => view.system_key === "tasks")!;
    const denied = new Request(`http://localhost/api/views/${tasks.id}/resolve?workspace=${slug}`, {
      method: "POST",
      headers: { origin: "https://evil.example", host: "localhost" },
    });
    const response = await RESOLVE_VIEW(denied, { params: Promise.resolve({ id: tasks.id }) });
    expect(response.status).toBe(403);
  });

  it("returns one bounded graph snapshot with typed layers and deterministic layout", async () => {
    const { slug, storage } = setup();
    const root = await storage.createNode({ title: "Graph root", kind: "doc", parent_id: null, content_md: "" });
    const child = await storage.createNode({ title: "Graph child", kind: "task", parent_id: root.id, content_md: "" });
    await storage.createEdge({ from_node: child.id, to_node: root.id, relation: "blocked_by" });
    const createdResponse = await POST(request("/api/views", "POST", {
      workspace: slug,
      name: "Neighborhood",
      query: { schema_version: 1, root_node_ids: [root.id] },
      presentation: {
        schema_version: 1,
        renderer: "graph",
        layout: { graph: { mode: "centered", center_node_id: root.id, depth: 3, layers: ["hierarchy", "dependencies"] } },
      },
    }));
    const view = ((await createdResponse.json()) as { view: { id: string } }).view;
    const response = await RESOLVE_VIEW(request(`/api/views/${view.id}/resolve?workspace=${slug}`, "POST"), { params: Promise.resolve({ id: view.id }) });
    expect(response.status).toBe(200);
    const body = await response.json() as {
      graph: {
        mode: string;
        center_node_id: string;
        nodes: Array<{ id: string; x: number; y: number }>;
        edges: Array<{ layer: string; type: string; from: string; to: string }>;
        limits: {
          max_nodes: number;
          max_tags: number;
          max_edges: number;
          max_membership_edges: number;
          max_depth: number;
        };
      };
    };
    expect(body.graph.mode).toBe("centered");
    expect(body.graph.center_node_id).toBe(root.id);
    expect(body.graph.nodes.map((item) => item.id).sort()).toEqual([child.id, root.id].sort());
    expect(body.graph.nodes.every((item) => Number.isFinite(item.x) && Number.isFinite(item.y))).toBe(true);
    expect(body.graph.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ layer: "hierarchy", type: "child", from: root.id, to: child.id }),
      expect.objectContaining({ layer: "dependencies", type: "blocked_by", from: child.id, to: root.id }),
    ]));
    expect(body.graph.limits).toEqual({
      max_nodes: 80,
      max_tags: 32,
      max_edges: 240,
      max_membership_edges: 320,
      max_depth: 3,
    });
  });

  it("coerces the retired timeline renderer to list and resolves it without a timeline payload", async () => {
    // Timeline retired 2026-07-21: stored or inbound "timeline" presentations
    // keep working, silently rendered by the list renderer.
    const { slug, storage } = setup();
    const a = await storage.createNode({ title: "A", kind: "task", parent_id: null });
    const b = await storage.createNode({ title: "B", kind: "decision", parent_id: null });
    const createdResponse = await POST(request("/api/views", "POST", {
      workspace: slug,
      name: "Legacy timeline",
      query: { schema_version: 1, kinds: ["task", "decision"] },
      presentation: { schema_version: 1, renderer: "timeline", sort_by: [{ field: "due_date", direction: "asc" }] },
    }));
    const legacyView = ((await createdResponse.json()) as { view: { id: string; presentation: { renderer: string } } }).view;
    expect(legacyView.presentation.renderer).toBe("list");
    const response = await RESOLVE_VIEW(request(`/api/views/${legacyView.id}/resolve?workspace=${slug}`, "POST"), { params: Promise.resolve({ id: legacyView.id }) });
    const body = await response.json() as { result: { node_ids: string[] }; view: { presentation: { renderer: string } }; timeline?: unknown };
    expect(body.view.presentation.renderer).toBe("list");
    expect(body.result.node_ids).toEqual([a.id, b.id].sort());
    expect(body.timeline).toBeUndefined();
  });
});
