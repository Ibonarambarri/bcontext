/**
 * Group: /api/nodes, /api/tags, /api/views, /api/activity, /api/skills,
 * /api/embed — the knowledge core, and the bulk of what agents call.
 *
 * Where the well-known group risks the dot, this one risks the parameter:
 * ids in the path (including system view ids of the form
 * `system:<uuid>:<key>`, whose colons a router could read as parameter
 * markers), query strings the handlers parse themselves, JSON bodies read
 * once, and one non-JSON response (the Markdown export). Every route is
 * exercised on a happy path against a demo workspace and on at least one
 * error path, because a 400 proves the route was reached and its params
 * filled just as well as a 200 does — and more cheaply.
 *
 * Writes execute twice (direct, then Hono). Where a second identical
 * execution has the same outcome the request is replayed verbatim; where it
 * cannot — a tag created by name, a resource deleted — see
 * `assertParityFresh`.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { RouteHandler, RouteModule } from "../adapter";
import { createApiApp } from "../app";
import {
  assertParity,
  buildRequest,
  expectParity,
  type ParityRequest,
  type Snapshot,
  snapshot,
} from "./harness";
import { record } from "@/lib/activity";
import { changePayload } from "@bcontext-dev/contract/changes";
import { createWorkspace } from "@/lib/demo-store";
import { _resetRateLimit } from "@/lib/rate-limit";
import { resolveDemoStorage } from "@/lib/storage/demo";
import type { WorkspaceTag } from "@bcontext-dev/contract/types";
import * as activity from "@/app/api/activity/route";
import * as activityFacets from "@/app/api/activity/facets/route";
import * as activityEntryRoute from "@/app/api/activity/[id]/route";
import * as embedStatus from "@/app/api/embed/migration-status/route";
import * as nodes from "@/app/api/nodes/route";
import * as nodeRoute from "@/app/api/nodes/[id]/route";
import * as nodeAutofixRoute from "@/app/api/nodes/[id]/autofix/route";
import * as nodeExportRoute from "@/app/api/nodes/[id]/export/route";
import * as nodeInspectorRoute from "@/app/api/nodes/[id]/inspector/route";
import * as nodeTagsRoute from "@/app/api/nodes/[id]/tags/route";
import * as nodeSubtasksRoute from "@/app/api/nodes/[id]/subtasks/route";
import * as skillsPush from "@/app/api/skills/push/route";
import * as skillRunRoute from "@/app/api/skills/[id]/run/route";
import * as tags from "@/app/api/tags/route";
import * as tagRoute from "@/app/api/tags/[id]/route";
import * as tagMergeRoute from "@/app/api/tags/[id]/merge/route";
import * as tagRelationsRoute from "@/app/api/tags/[id]/relations/route";
import * as views from "@/app/api/views/route";
import * as viewsResolve from "@/app/api/views/resolve/route";
import * as viewRoute from "@/app/api/views/[id]/route";
import * as viewDuplicateRoute from "@/app/api/views/[id]/duplicate/route";
import * as viewResolveRoute from "@/app/api/views/[id]/resolve/route";

// Routes with a dynamic segment type their params as `{ id: string }`; the
// adapter, like the generated route table, sees `Record<string, string>`.
// Same cast `routes.generated.ts` makes, for the same reason.
const asModule = (module: object) => module as RouteModule;
const activityEntry = asModule(activityEntryRoute);
const node = asModule(nodeRoute);
const nodeAutofix = asModule(nodeAutofixRoute);
const nodeExport = asModule(nodeExportRoute);
const nodeInspector = asModule(nodeInspectorRoute);
const nodeTags = asModule(nodeTagsRoute);
const nodeSubtasks = asModule(nodeSubtasksRoute);
const skillRun = asModule(skillRunRoute);
const tag = asModule(tagRoute);
const tagMerge = asModule(tagMergeRoute);
const tagRelations = asModule(tagRelationsRoute);
const view = asModule(viewRoute);
const viewDuplicate = asModule(viewDuplicateRoute);
const viewResolve = asModule(viewResolveRoute);

const app = createApiApp({
  serve: ["/api/nodes", "/api/tags", "/api/views", "/api/activity", "/api/skills", "/api/embed"],
});

// Autofix and skill runs reach the AI gateway only when a key is present.
// Without one they stop at a deterministic 503, which is the case this file
// can prove parity for; with one they would make network calls.
const hasGatewayKey = Boolean(process.env.AI_GATEWAY_API_KEY);

function workspace(label: string) {
  const ws = createWorkspace({
    name: label,
    slug: `parity-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  });
  return { slug: ws.slug, storage: resolveDemoStorage(ws.slug)! };
}

/**
 * Writes that succeed once per input — a tag created by name, a resource
 * deleted or merged — cannot be replayed verbatim: the second execution finds
 * the resource already there or already gone, and the 409/404 it returns
 * would say nothing about routing. Each side gets its own freshly provisioned
 * target instead. The two requests differ only in the ids they name, so once
 * every reference is blanked (`id` is already volatile; the `*_id` columns
 * pointing at it are not) the responses still have to agree.
 */
async function assertParityFresh(module: RouteModule, make: () => Promise<ParityRequest>): Promise<Snapshot> {
  const a = await make();
  const b = await make();
  const handler = module[a.method] as RouteHandler | undefined;
  if (!handler) throw new Error(`route module has no ${a.method}`);
  const direct = await snapshot(await handler(buildRequest(a), { params: Promise.resolve(a.params ?? {}) }));
  const viaHono = await snapshot(await app.request(buildRequest(b)));
  expectParity({
    direct: { ...direct, body: withoutRefs(direct.body) },
    viaHono: { ...viaHono, body: withoutRefs(viaHono.body) },
  });
  return direct;
}

function withoutRefs(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutRefs);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        k.endsWith("_id") ? (v === null ? null : typeof v) : withoutRefs(v),
      ]),
    );
  }
  return value;
}

const listQuery = { schema_version: 1 as const };
const listPresentation = { schema_version: 1 as const, renderer: "list" as const };

// Every request here is the unauthenticated demo actor, keyed by one IP, and
// each parity check spends two tokens of a 60-token write bucket. Left alone
// the file would trip the limiter halfway through with a 429 on the Hono side
// only — a difference that is real but not about routing.
beforeEach(() => _resetRateLimit());

describe("parity: /api/nodes", () => {
  it("GET /api/nodes", async () => {
    const { slug, storage } = workspace("nodes-list");
    const tagA = (await storage.listTags())[0]!;
    await storage.createNode({ title: "Alpha", kind: "doc", parent_id: null, tag_ids: [tagA.id] });
    await storage.createNode({ title: "Beta", kind: "task", parent_id: null, status: "todo" });
    await storage.createNode({ title: "Gamma", kind: "decision", parent_id: null });
    const ok = await assertParity(app, nodes, { method: "GET", path: `/api/nodes?workspace=${slug}` });
    expect(ok.status).toBe(200);
    expect((ok.body as { nodes: unknown[] }).nodes).toHaveLength(3);
    const paged = await assertParity(app, nodes, { method: "GET", path: `/api/nodes?workspace=${slug}&fields=list&limit=2` });
    expect((paged.body as { next_cursor: string | null }).next_cursor).not.toBeNull();
    const filtered = await assertParity(app, nodes, {
      method: "GET",
      path: `/api/nodes?workspace=${slug}&tag=${tagA.slug}&tags_match=all`,
    });
    expect((filtered.body as { nodes: unknown[] }).nodes).toHaveLength(1);
    expect((await assertParity(app, nodes, { method: "GET", path: "/api/nodes" })).status).toBe(400);
    expect((await assertParity(app, nodes, { method: "GET", path: "/api/nodes?workspace=no-such-workspace" })).status).toBe(404);
    expect((await assertParity(app, nodes, { method: "GET", path: `/api/nodes?workspace=${slug}&fields=bogus` })).status).toBe(400);
    expect((await assertParity(app, nodes, { method: "GET", path: `/api/nodes?workspace=${slug}&cursor=garbage` })).status).toBe(400);
  });

  it("POST /api/nodes", async () => {
    const { slug, storage } = workspace("nodes-create");
    const tagA = (await storage.listTags())[0]!;
    const parent = await storage.createNode({ title: "Parent", kind: "doc", parent_id: null });
    const created = await assertParity(app, nodes, {
      method: "POST",
      path: "/api/nodes",
      body: { workspace: slug, title: "Child", kind: "task", parent_id: parent.id, status: "todo", tag_ids: [tagA.id], content_md: "## Plan\n\nDo it." },
    });
    expect(created.status).toBe(201);
    expect((created.body as { node: { tags: unknown[] } }).node.tags).toHaveLength(1);
    expect((await assertParity(app, nodes, { method: "POST", path: "/api/nodes", body: { workspace: slug, title: "Folder", kind: "folder", parent_id: null } })).status).toBe(400);
    expect((await assertParity(app, nodes, { method: "POST", path: "/api/nodes", body: { workspace: slug, title: "Orphan", kind: "doc", parent_id: "n-missing" } })).status).toBe(400);
    expect((await assertParity(app, nodes, { method: "POST", path: "/api/nodes", body: { workspace: slug, title: "Tagged", kind: "doc", parent_id: null, tag_ids: ["demo-tag-0-nope"] } })).status).toBe(400);
    expect((await assertParity(app, nodes, { method: "POST", path: "/api/nodes", body: { workspace: "no-such-workspace", title: "X", kind: "doc", parent_id: null } })).status).toBe(404);
    expect((await assertParity(app, nodes, { method: "POST", path: "/api/nodes", body: "{not json" })).status).toBe(400);
  });

  it("GET /api/nodes/:id", async () => {
    const { slug, storage } = workspace("node-get");
    const doc = await storage.createNode({ title: "Doc", kind: "doc", parent_id: null, content_md: "## Intro\n\nHello." });
    const ok = await assertParity(app, node, { method: "GET", path: `/api/nodes/${doc.id}?workspace=${slug}`, params: { id: doc.id } });
    expect(ok.status).toBe(200);
    expect((ok.body as { node: { title: string } }).node.title).toBe("Doc");
    expect((await assertParity(app, node, { method: "GET", path: `/api/nodes/n-missing?workspace=${slug}`, params: { id: "n-missing" } })).status).toBe(404);
    expect((await assertParity(app, node, { method: "GET", path: `/api/nodes/${doc.id}`, params: { id: doc.id } })).status).toBe(400);
  });

  it("PATCH /api/nodes/:id", async () => {
    const { slug, storage } = workspace("node-patch");
    const task = await storage.createNode({ title: "Task", kind: "task", parent_id: null, status: "todo" });
    // No `if_updated_at`: the second execution rewrites the same values and
    // returns the same node, timestamps aside.
    const ok = await assertParity(app, node, {
      method: "PATCH",
      path: `/api/nodes/${task.id}`,
      params: { id: task.id },
      body: { workspace: slug, title: "Task renamed", status: "in_progress", priority: "high" },
    });
    expect(ok.status).toBe(200);
    expect((ok.body as { node: { status: string } }).node.status).toBe("in_progress");
    const stale = await assertParity(app, node, {
      method: "PATCH",
      path: `/api/nodes/${task.id}`,
      params: { id: task.id },
      body: { workspace: slug, status: "done", if_updated_at: "2000-01-01T00:00:00.000Z" },
    });
    expect(stale.status).toBe(409);
    expect((await assertParity(app, node, { method: "PATCH", path: "/api/nodes/n-missing", params: { id: "n-missing" }, body: { workspace: slug, title: "X" } })).status).toBe(404);
    expect((await assertParity(app, node, { method: "PATCH", path: `/api/nodes/${task.id}`, params: { id: task.id }, body: { workspace: slug, status: "not-a-status" } })).status).toBe(400);
    expect((await assertParity(app, node, { method: "PATCH", path: `/api/nodes/${task.id}`, params: { id: task.id }, body: { title: "no workspace" } })).status).toBe(400);
  });

  it("DELETE /api/nodes/:id", async () => {
    const { slug, storage } = workspace("node-delete");
    const ids: string[] = [];
    const ok = await assertParityFresh(node, async () => {
      const doomed = await storage.createNode({ title: "Doomed", kind: "doc", parent_id: null });
      ids.push(doomed.id);
      return { method: "DELETE", path: `/api/nodes/${doomed.id}?workspace=${slug}`, params: { id: doomed.id } };
    });
    expect(ok.status).toBe(200);
    for (const id of ids) expect(await storage.getNode(id)).toBeNull();
    expect((await assertParity(app, node, { method: "DELETE", path: "/api/nodes/n-missing", params: { id: "n-missing" } })).status).toBe(400);
    expect((await assertParity(app, node, { method: "DELETE", path: "/api/nodes/n-missing?workspace=no-such-workspace", params: { id: "n-missing" } })).status).toBe(404);
  });

  it("POST /api/nodes/:id/autofix", async () => {
    const { slug, storage } = workspace("node-autofix");
    const short = await storage.createNode({ title: "Short", kind: "doc", parent_id: null, content_md: "tiny" });
    const tooShort = await assertParity(app, nodeAutofix, {
      method: "POST",
      path: `/api/nodes/${short.id}/autofix`,
      params: { id: short.id },
      body: { workspace: slug },
    });
    expect(tooShort.status).toBe(422);
    expect((await assertParity(app, nodeAutofix, { method: "POST", path: "/api/nodes/n-missing/autofix", params: { id: "n-missing" }, body: { workspace: slug } })).status).toBe(404);
    expect((await assertParity(app, nodeAutofix, { method: "POST", path: `/api/nodes/${short.id}/autofix`, params: { id: short.id }, body: {} })).status).toBe(400);
  });

  it.skipIf(hasGatewayKey)("POST /api/nodes/:id/autofix without a gateway key", async () => {
    const { slug, storage } = workspace("node-autofix-nokey");
    const long = await storage.createNode({ title: "Long", kind: "doc", parent_id: null, content_md: "## Body\n\n" + "Enough words to clear the minimum body length for a rewrite. ".repeat(3) });
    const noKey = await assertParity(app, nodeAutofix, {
      method: "POST",
      path: `/api/nodes/${long.id}/autofix`,
      params: { id: long.id },
      body: { workspace: slug },
    });
    expect(noKey.status).toBe(503);
  });

  it("GET /api/nodes/:id/export", async () => {
    const { slug, storage } = workspace("node-export");
    const doc = await storage.createNode({ title: "Exported", kind: "doc", parent_id: null, content_md: "## Section\n\nBody text." });
    const ok = await assertParity(app, nodeExport, { method: "GET", path: `/api/nodes/${doc.id}/export?workspace=${slug}`, params: { id: doc.id } });
    expect(ok.status).toBe(200);
    expect(ok.contentType).toContain("text/markdown");
    expect(ok.body).toContain("Body text.");
    expect((await assertParity(app, nodeExport, { method: "GET", path: `/api/nodes/n-missing/export?workspace=${slug}`, params: { id: "n-missing" } })).status).toBe(404);
    expect((await assertParity(app, nodeExport, { method: "GET", path: `/api/nodes/${doc.id}/export`, params: { id: doc.id } })).status).toBe(400);
  });

  it("GET /api/nodes/:id/inspector", async () => {
    const { slug, storage } = workspace("node-inspector");
    const target = await storage.createNode({ title: "Target", kind: "doc", parent_id: null, content_md: "## About\n\nReferenced." });
    const source = await storage.createNode({ title: "Source", kind: "task", parent_id: null, content_md: `See /n/${target.id}` });
    await storage.createEdge({ from_node: source.id, to_node: target.id, relation: "blocked_by" });
    record(slug, "create", target.id, target.title, target.kind, { actorKind: "human", payload: changePayload({ after: target, via: "web" }) });
    const ok = await assertParity(app, nodeInspector, { method: "GET", path: `/api/nodes/${target.id}/inspector?workspace=${slug}`, params: { id: target.id } });
    expect(ok.status).toBe(200);
    const body = ok.body as { backlinks: unknown[]; activity: unknown[]; relations: unknown[] };
    expect(body.backlinks).toHaveLength(1);
    expect(body.activity).toHaveLength(1);
    const preview = await assertParity(app, nodeInspector, { method: "GET", path: `/api/nodes/${target.id}/inspector?workspace=${slug}&scope=preview`, params: { id: target.id } });
    expect((preview.body as { backlinks: unknown[] }).backlinks).toHaveLength(0);
    expect((await assertParity(app, nodeInspector, { method: "GET", path: `/api/nodes/n-missing/inspector?workspace=${slug}`, params: { id: "n-missing" } })).status).toBe(404);
    expect((await assertParity(app, nodeInspector, { method: "GET", path: `/api/nodes/${target.id}/inspector`, params: { id: target.id } })).status).toBe(400);
  });

  it("PUT /api/nodes/:id/tags", async () => {
    const { slug, storage } = workspace("node-tags");
    const [tagA, tagB] = (await storage.listTags()) as [WorkspaceTag, WorkspaceTag];
    const doc = await storage.createNode({ title: "Tagged", kind: "doc", parent_id: null });
    const ok = await assertParity(app, nodeTags, {
      method: "PUT",
      path: `/api/nodes/${doc.id}/tags`,
      params: { id: doc.id },
      body: { workspace: slug, tag_ids: [tagA.id, tagB.id] },
    });
    expect(ok.status).toBe(200);
    expect((ok.body as { tags: unknown[] }).tags).toHaveLength(2);
    expect((await assertParity(app, nodeTags, { method: "PUT", path: `/api/nodes/${doc.id}/tags`, params: { id: doc.id }, body: { workspace: slug, tag_ids: ["demo-tag-0-nope"] } })).status).toBe(400);
    expect((await assertParity(app, nodeTags, { method: "PUT", path: "/api/nodes/n-missing/tags", params: { id: "n-missing" }, body: { workspace: slug, tag_ids: [tagA.id] } })).status).toBe(404);
    expect((await assertParity(app, nodeTags, { method: "PUT", path: `/api/nodes/${doc.id}/tags`, params: { id: doc.id }, body: { workspace: slug } })).status).toBe(400);
  });

  it("GET+POST /api/nodes/:id/subtasks", async () => {
    const { slug, storage } = workspace("node-subtasks");
    // add is not idempotent (a replay appends again), so each side gets its
    // own fresh task and the two responses agree once ids are blanked.
    const added = await assertParityFresh(nodeSubtasks, async () => {
      const fresh = await storage.createNode({ title: "Stepped", kind: "task", parent_id: null, status: "todo" });
      return {
        method: "POST",
        path: `/api/nodes/${fresh.id}/subtasks`,
        params: { id: fresh.id },
        body: { workspace: slug, op: "add", title: "Step", summary: "one" },
      };
    });
    expect(added.status).toBe(200);
    const task = await storage.createNode({
      title: "Stepped again", kind: "task", parent_id: null, status: "todo",
      data: { subtasks: [{ id: "sfixed1", title: "A", summary: "", content_md: "", done: false, done_at: null, created_at: "", updated_at: "" }] },
    });
    const list = await assertParity(app, nodeSubtasks, { method: "GET", path: `/api/nodes/${task.id}/subtasks?workspace=${slug}`, params: { id: task.id } });
    expect(list.status).toBe(200);
    const ids = (list.body as { subtasks: Array<{ id: string }> }).subtasks.map((s) => s.id);
    expect(ids).toEqual(["sfixed1"]);
    // Reopening a done step: fresh task per side, and the only field a
    // toggle stamps (done_at) becomes null on both, so the bodies agree.
    const toggled = await assertParityFresh(nodeSubtasks, async () => {
      const fresh = await storage.createNode({
        title: "Reopen", kind: "task", parent_id: null, status: "todo",
        data: { subtasks: [{ id: "sdone01", title: "A", summary: "", content_md: "", done: true, done_at: "2026-01-01T00:00:00.000Z", created_at: "", updated_at: "" }] },
      });
      return { method: "POST", path: `/api/nodes/${fresh.id}/subtasks`, params: { id: fresh.id }, body: { workspace: slug, op: "toggle", id: "sdone01", done: false } };
    });
    expect(toggled.status).toBe(200);
    expect((toggled.body as { subtask: { done: boolean } }).subtask.done).toBe(false);
    expect((await assertParity(app, nodeSubtasks, { method: "POST", path: `/api/nodes/${task.id}/subtasks`, params: { id: task.id }, body: { workspace: slug, op: "toggle", id: "s-missing" } })).status).toBe(400);
    expect((await assertParity(app, nodeSubtasks, { method: "POST", path: "/api/nodes/n-missing/subtasks", params: { id: "n-missing" }, body: { workspace: slug, op: "delete", id: "x" } })).status).toBe(404);
    expect((await assertParity(app, nodeSubtasks, { method: "GET", path: `/api/nodes/n-missing/subtasks?workspace=${slug}`, params: { id: "n-missing" } })).status).toBe(404);
    expect((await assertParity(app, nodeSubtasks, { method: "POST", path: `/api/nodes/${task.id}/subtasks`, params: { id: task.id }, body: { workspace: slug, op: "add" } })).status).toBe(400);
  });
});

describe("parity: /api/tags", () => {
  it("GET /api/tags", async () => {
    const { slug, storage } = workspace("tags-list");
    const tagA = (await storage.listTags())[0]!;
    const extra = await storage.createTag({ name: "Extra", created_by: null });
    await storage.createTagRelations(extra.id, { parent_ids: [tagA.id] });
    await storage.createNode({ title: "Uses tag", kind: "doc", parent_id: null, tag_ids: [tagA.id] });
    const ok = await assertParity(app, tags, { method: "GET", path: `/api/tags?workspace=${slug}` });
    expect(ok.status).toBe(200);
    const body = ok.body as { tags: Array<{ usage_count: number }>; relations: unknown[]; can_manage: boolean };
    expect(body.relations).toHaveLength(1);
    expect(body.tags.some((t) => t.usage_count === 1)).toBe(true);
    expect((await assertParity(app, tags, { method: "GET", path: "/api/tags" })).status).toBe(400);
    expect((await assertParity(app, tags, { method: "GET", path: "/api/tags?workspace=no-such-workspace" })).status).toBe(404);
  });

  it("POST /api/tags", async () => {
    const created = await assertParityFresh(tags, async () => {
      const { slug, storage } = workspace("tags-create");
      const parent = (await storage.listTags())[0]!;
      return { method: "POST", path: "/api/tags", body: { workspace: slug, name: "Customer Ops", description: "Ops", parent_ids: [parent.id] } };
    });
    expect(created.status).toBe(201);
    expect((created.body as { relations: unknown[] }).relations).toHaveLength(1);
    // The tag is created before its relations are validated, so this leaves
    // a tag behind on each side and cannot be replayed verbatim either.
    const badRelation = await assertParityFresh(tags, async () => {
      const { slug } = workspace("tags-create-badrel");
      return { method: "POST", path: "/api/tags", body: { workspace: slug, name: "Dangling", parent_ids: ["demo-tag-0-nope"] } };
    });
    expect(badRelation.status).toBe(400);
    const { slug, storage } = workspace("tags-create-dup");
    await storage.createTag({ name: "Taken", created_by: null });
    expect((await assertParity(app, tags, { method: "POST", path: "/api/tags", body: { workspace: slug, name: " taken " } })).status).toBe(409);
    expect((await assertParity(app, tags, { method: "POST", path: "/api/tags", body: { workspace: slug, name: "" } })).status).toBe(400);
    expect((await assertParity(app, tags, { method: "POST", path: "/api/tags", body: { workspace: "no-such-workspace", name: "X" } })).status).toBe(404);
    expect((await assertParity(app, tags, { method: "POST", path: "/api/tags", body: "{not json" })).status).toBe(400);
  });

  it("PATCH /api/tags/:id", async () => {
    const { slug, storage } = workspace("tag-update");
    const mine = await storage.createTag({ name: "Before", created_by: null });
    const other = await storage.createTag({ name: "Other", created_by: null });
    // Renaming to the same name twice is a no-op the second time; the tag
    // comes back identical apart from updated_at.
    const ok = await assertParity(app, tag, {
      method: "PATCH",
      path: `/api/tags/${mine.id}`,
      params: { id: mine.id },
      body: { workspace: slug, name: "After", description: "renamed" },
    });
    expect(ok.status).toBe(200);
    expect((ok.body as { tag: { name: string } }).tag.name).toBe("After");
    expect((await assertParity(app, tag, { method: "PATCH", path: `/api/tags/${mine.id}`, params: { id: mine.id }, body: { workspace: slug, name: other.name } })).status).toBe(409);
    expect((await assertParity(app, tag, { method: "PATCH", path: "/api/tags/demo-tag-0-nope", params: { id: "demo-tag-0-nope" }, body: { workspace: slug, name: "X" } })).status).toBe(404);
    expect((await assertParity(app, tag, { method: "PATCH", path: `/api/tags/${mine.id}`, params: { id: mine.id }, body: { workspace: slug } })).status).toBe(400);
  });

  it("DELETE /api/tags/:id", async () => {
    const { slug, storage } = workspace("tag-delete");
    const ok = await assertParityFresh(tag, async () => {
      const doomed = await storage.createTag({ name: `Doomed ${Math.random().toString(36).slice(2, 6)}`, created_by: null });
      return { method: "DELETE", path: `/api/tags/${doomed.id}?workspace=${slug}`, params: { id: doomed.id } };
    });
    expect(ok.status).toBe(200);
    expect((await assertParity(app, tag, { method: "DELETE", path: `/api/tags/demo-tag-0-nope?workspace=${slug}`, params: { id: "demo-tag-0-nope" } })).status).toBe(404);
    expect((await assertParity(app, tag, { method: "DELETE", path: "/api/tags/demo-tag-0-nope", params: { id: "demo-tag-0-nope" } })).status).toBe(400);
  });

  it("POST /api/tags/:id/merge", async () => {
    const { slug, storage } = workspace("tag-merge");
    const target = await storage.createTag({ name: "Target", created_by: null });
    const ok = await assertParityFresh(tagMerge, async () => {
      const source = await storage.createTag({ name: `Source ${Math.random().toString(36).slice(2, 6)}`, created_by: null });
      await storage.createNode({ title: "Carries source", kind: "doc", parent_id: null, tag_ids: [source.id] });
      return { method: "POST", path: `/api/tags/${source.id}/merge`, params: { id: source.id }, body: { workspace: slug, target_id: target.id } };
    });
    expect(ok.status).toBe(200);
    expect((ok.body as { tag: { name: string } }).tag.name).toBe("Target");
    expect((await assertParity(app, tagMerge, { method: "POST", path: `/api/tags/${target.id}/merge`, params: { id: target.id }, body: { workspace: slug, target_id: target.id } })).status).toBe(409);
    expect((await assertParity(app, tagMerge, { method: "POST", path: "/api/tags/demo-tag-0-nope/merge", params: { id: "demo-tag-0-nope" }, body: { workspace: slug, target_id: target.id } })).status).toBe(404);
    expect((await assertParity(app, tagMerge, { method: "POST", path: `/api/tags/${target.id}/merge`, params: { id: target.id }, body: { workspace: slug } })).status).toBe(400);
  });

  it("POST /api/tags/:id/relations", async () => {
    const { slug, storage } = workspace("tag-relations-create");
    const parent = await storage.createTag({ name: "Parent", created_by: null });
    // Creating a relation that already exists returns an empty list, so the
    // replay would differ in body without a routing cause.
    const ok = await assertParityFresh(tagRelations, async () => {
      const child = await storage.createTag({ name: `Child ${Math.random().toString(36).slice(2, 6)}`, created_by: null });
      return { method: "POST", path: `/api/tags/${child.id}/relations`, params: { id: child.id }, body: { workspace: slug, to_tag_id: parent.id, relation: "parent" } };
    });
    expect(ok.status).toBe(201);
    expect((ok.body as { relations: unknown[] }).relations).toHaveLength(1);
    expect((await assertParity(app, tagRelations, { method: "POST", path: `/api/tags/${parent.id}/relations`, params: { id: parent.id }, body: { workspace: slug, to_tag_id: parent.id, relation: "parent" } })).status).toBe(422);
    expect((await assertParity(app, tagRelations, { method: "POST", path: `/api/tags/${parent.id}/relations`, params: { id: parent.id }, body: { workspace: slug, to_tag_id: "demo-tag-0-nope", relation: "related" } })).status).toBe(400);
    expect((await assertParity(app, tagRelations, { method: "POST", path: `/api/tags/${parent.id}/relations`, params: { id: parent.id }, body: { workspace: slug, to_tag_id: parent.id, relation: "sibling" } })).status).toBe(400);
  });

  it("DELETE /api/tags/:id/relations", async () => {
    const { slug, storage } = workspace("tag-relations-delete");
    const parent = await storage.createTag({ name: "Parent", created_by: null });
    const ok = await assertParityFresh(tagRelations, async () => {
      const child = await storage.createTag({ name: `Child ${Math.random().toString(36).slice(2, 6)}`, created_by: null });
      await storage.createTagRelations(child.id, { parent_ids: [parent.id] });
      return { method: "DELETE", path: `/api/tags/${child.id}/relations?workspace=${slug}&to=${parent.id}&relation=parent`, params: { id: child.id } };
    });
    expect(ok.status).toBe(200);
    expect((await assertParity(app, tagRelations, { method: "DELETE", path: `/api/tags/${parent.id}/relations?workspace=${slug}&to=demo-tag-0-nope&relation=parent`, params: { id: parent.id } })).status).toBe(404);
    expect((await assertParity(app, tagRelations, { method: "DELETE", path: `/api/tags/${parent.id}/relations?workspace=${slug}&to=${parent.id}`, params: { id: parent.id } })).status).toBe(400);
    expect((await assertParity(app, tagRelations, { method: "DELETE", path: `/api/tags/${parent.id}/relations?to=${parent.id}&relation=parent`, params: { id: parent.id } })).status).toBe(400);
  });
});

describe("parity: /api/views", () => {
  async function customView(slug: string, name: string, extra: Record<string, unknown> = {}) {
    const res = await views.POST(buildRequest({
      method: "POST",
      path: "/api/views",
      body: { workspace: slug, name, query: listQuery, presentation: listPresentation, ...extra },
    }));
    expect(res.status).toBe(201);
    return ((await res.json()) as { view: { id: string; version: number } }).view;
  }

  it("GET /api/views", async () => {
    const { slug } = workspace("views-list");
    await customView(slug, "Mine");
    const ok = await assertParity(app, views, { method: "GET", path: `/api/views?workspace=${slug}` });
    expect(ok.status).toBe(200);
    expect((ok.body as { views: unknown[] }).views).toHaveLength(9);
    expect((await assertParity(app, views, { method: "GET", path: "/api/views" })).status).toBe(400);
    expect((await assertParity(app, views, { method: "GET", path: "/api/views?workspace=no-such-workspace" })).status).toBe(404);
  });

  it("POST /api/views", async () => {
    const { slug } = workspace("views-create");
    const ok = await assertParity(app, views, {
      method: "POST",
      path: "/api/views",
      body: { workspace: slug, name: "Open tasks", visibility: "workspace", query: { ...listQuery, kinds: ["task"], statuses: ["todo"] }, presentation: { ...listPresentation, renderer: "board", group_by: "status" } },
    });
    expect(ok.status).toBe(201);
    expect((ok.body as { view: { presentation: { renderer: string } } }).view.presentation.renderer).toBe("board");
    expect((await assertParity(app, views, { method: "POST", path: "/api/views", body: { workspace: slug, name: "Bad", query: { schema_version: 2 }, presentation: listPresentation } })).status).toBe(400);
    expect((await assertParity(app, views, { method: "POST", path: "/api/views", body: { workspace: "no-such-workspace", name: "X", query: listQuery, presentation: listPresentation } })).status).toBe(404);
  });

  it("POST /api/views/resolve", async () => {
    const { slug, storage } = workspace("views-resolve-query");
    const task = await storage.createNode({ title: "Task", kind: "task", parent_id: null, status: "todo" });
    await storage.createNode({ title: "Doc", kind: "doc", parent_id: null });
    const ok = await assertParity(app, viewsResolve, { method: "POST", path: "/api/views/resolve", body: { workspace: slug, query: { ...listQuery, kinds: ["task"] } } });
    expect(ok.status).toBe(200);
    expect((ok.body as { result: { node_ids: string[] } }).result.node_ids).toEqual([task.id]);
    expect((await assertParity(app, viewsResolve, { method: "POST", path: "/api/views/resolve", body: { workspace: slug, query: { ...listQuery, kinds: ["folder"] } } })).status).toBe(400);
    expect((await assertParity(app, viewsResolve, { method: "POST", path: "/api/views/resolve", body: { workspace: "no-such-workspace", query: listQuery } })).status).toBe(404);
  });

  it("GET /api/views/:id", async () => {
    const { slug, storage } = workspace("view-get");
    const mine = await customView(slug, "Mine");
    const ok = await assertParity(app, view, { method: "GET", path: `/api/views/${mine.id}?workspace=${slug}`, params: { id: mine.id } });
    expect(ok.status).toBe(200);
    // System view ids carry colons — `system:<uuid>:tasks` — the one id shape
    // in the API a router could misread as parameter markers.
    const systemId = `system:${storage.workspace.id}:tasks`;
    const system = await assertParity(app, view, { method: "GET", path: `/api/views/${systemId}?workspace=${slug}`, params: { id: systemId } });
    expect(system.status).toBe(200);
    expect((system.body as { view: { system_key: string } }).view.system_key).toBe("tasks");
    const encoded = await assertParity(app, view, { method: "GET", path: `/api/views/${encodeURIComponent(systemId)}?workspace=${slug}`, params: { id: systemId } });
    expect(encoded.status).toBe(200);
    expect((await assertParity(app, view, { method: "GET", path: `/api/views/v-missing?workspace=${slug}`, params: { id: "v-missing" } })).status).toBe(404);
    expect((await assertParity(app, view, { method: "GET", path: `/api/views/${mine.id}`, params: { id: mine.id } })).status).toBe(400);
  });

  it("PATCH /api/views/:id", async () => {
    const { slug, storage } = workspace("view-patch");
    const mine = await customView(slug, "Mine");
    // A real change bumps the version, so the replay would hit 409 for a
    // reason that is not routing.
    const ok = await assertParityFresh(view, async () => {
      const fresh = await customView(slug, "Editable");
      return { method: "PATCH", path: `/api/views/${fresh.id}`, params: { id: fresh.id }, body: { workspace: slug, expected_version: 1, name: "Edited", visibility: "workspace" } };
    });
    expect(ok.status).toBe(200);
    expect((ok.body as { view: { version: number } }).view.version).toBe(2);
    // A patch with nothing to change returns the current row without bumping
    // the version, so it replays cleanly.
    expect((await assertParity(app, view, { method: "PATCH", path: `/api/views/${mine.id}`, params: { id: mine.id }, body: { workspace: slug, expected_version: 1 } })).status).toBe(200);
    expect((await assertParity(app, view, { method: "PATCH", path: `/api/views/${mine.id}`, params: { id: mine.id }, body: { workspace: slug, expected_version: 7, name: "Stale" } })).status).toBe(409);
    const systemId = `system:${storage.workspace.id}:tasks`;
    expect((await assertParity(app, view, { method: "PATCH", path: `/api/views/${systemId}`, params: { id: systemId }, body: { workspace: slug, expected_version: 1, name: "Nope" } })).status).toBe(403);
    expect((await assertParity(app, view, { method: "PATCH", path: "/api/views/v-missing", params: { id: "v-missing" }, body: { workspace: slug, expected_version: 1, name: "X" } })).status).toBe(404);
    expect((await assertParity(app, view, { method: "PATCH", path: `/api/views/${mine.id}`, params: { id: mine.id }, body: { workspace: slug, name: "No version" } })).status).toBe(400);
  });

  it("DELETE /api/views/:id", async () => {
    const { slug } = workspace("view-delete");
    const mine = await customView(slug, "Mine");
    const ok = await assertParityFresh(view, async () => {
      const doomed = await customView(slug, "Doomed");
      return { method: "DELETE", path: `/api/views/${doomed.id}?workspace=${slug}&expected_version=1`, params: { id: doomed.id } };
    });
    expect(ok.status).toBe(200);
    expect((await assertParity(app, view, { method: "DELETE", path: `/api/views/${mine.id}?workspace=${slug}&expected_version=9`, params: { id: mine.id } })).status).toBe(409);
    expect((await assertParity(app, view, { method: "DELETE", path: `/api/views/${mine.id}?workspace=${slug}&expected_version=zero`, params: { id: mine.id } })).status).toBe(400);
    expect((await assertParity(app, view, { method: "DELETE", path: `/api/views/v-missing?workspace=${slug}`, params: { id: "v-missing" } })).status).toBe(404);
    expect((await assertParity(app, view, { method: "DELETE", path: `/api/views/${mine.id}`, params: { id: mine.id } })).status).toBe(400);
  });

  it("POST /api/views/:id/duplicate", async () => {
    const { slug } = workspace("view-duplicate");
    const mine = await customView(slug, "Mine");
    const ok = await assertParity(app, viewDuplicate, { method: "POST", path: `/api/views/${mine.id}/duplicate`, params: { id: mine.id }, body: { workspace: slug } });
    expect(ok.status).toBe(201);
    expect((ok.body as { view: { name: string } }).view.name).toBe("Mine copy");
    expect((await assertParity(app, viewDuplicate, { method: "POST", path: `/api/views/${mine.id}/duplicate`, params: { id: mine.id }, body: { workspace: slug, name: "Named copy" } })).status).toBe(201);
    expect((await assertParity(app, viewDuplicate, { method: "POST", path: "/api/views/v-missing/duplicate", params: { id: "v-missing" }, body: { workspace: slug } })).status).toBe(404);
    expect((await assertParity(app, viewDuplicate, { method: "POST", path: `/api/views/${mine.id}/duplicate`, params: { id: mine.id }, body: { workspace: slug, extra: true } })).status).toBe(400);
  });

  it("POST /api/views/:id/resolve", async () => {
    const { slug, storage } = workspace("view-resolve");
    const task = await storage.createNode({ title: "Task", kind: "task", parent_id: null, status: "todo" });
    const blocker = await storage.createNode({ title: "Blocker", kind: "task", parent_id: null, status: "in_progress" });
    await storage.createEdge({ from_node: task.id, to_node: blocker.id, relation: "blocked_by" });
    const board = await customView(slug, "Board", { query: { ...listQuery, kinds: ["task"] }, presentation: { ...listPresentation, renderer: "board", group_by: "status" } });
    const ok = await assertParity(app, viewResolve, { method: "POST", path: `/api/views/${board.id}/resolve?workspace=${slug}`, params: { id: board.id } });
    expect(ok.status).toBe(200);
    const body = ok.body as { result: { node_ids: string[] }; board: { blockers: Record<string, { total: number }> } };
    expect(body.result.node_ids).toHaveLength(2);
    expect(body.board.blockers[task.id]?.total).toBe(1);
    const graph = await customView(slug, "Graph", { presentation: { ...listPresentation, renderer: "graph" } });
    const withGraph = await assertParity(app, viewResolve, { method: "POST", path: `/api/views/${graph.id}/resolve?workspace=${slug}`, params: { id: graph.id } });
    expect(withGraph.body).toHaveProperty("graph");
    const systemId = `system:${storage.workspace.id}:tasks`;
    expect((await assertParity(app, viewResolve, { method: "POST", path: `/api/views/${systemId}/resolve?workspace=${slug}`, params: { id: systemId } })).status).toBe(200);
    expect((await assertParity(app, viewResolve, { method: "POST", path: `/api/views/v-missing/resolve?workspace=${slug}`, params: { id: "v-missing" } })).status).toBe(404);
    expect((await assertParity(app, viewResolve, { method: "POST", path: `/api/views/${board.id}/resolve`, params: { id: board.id } })).status).toBe(400);
  });
});

describe("parity: /api/activity", () => {
  async function feed(label: string) {
    const { slug, storage } = workspace(label);
    const doc = await storage.createNode({ title: "Doc", kind: "doc", parent_id: null, content_md: "## Body\n\nText" });
    const created = record(slug, "create", doc.id, doc.title, doc.kind, { actorKind: "agent", principalId: "agent-x", payload: changePayload({ after: doc, via: "mcp", source: "github:pr-1" }) });
    record(slug, "update", doc.id, doc.title, "content_md", { actorKind: "human", payload: changePayload({ before: doc, after: doc, via: "web" }) });
    return { slug, doc, created };
  }

  it("GET /api/activity", async () => {
    const { slug, doc } = await feed("activity-feed");
    const ok = await assertParity(app, activity, { method: "GET", path: `/api/activity?workspace=${slug}` });
    expect(ok.status).toBe(200);
    expect((ok.body as { changes: unknown[] }).changes).toHaveLength(2);
    const filtered = await assertParity(app, activity, { method: "GET", path: `/api/activity?workspace=${slug}&actor=agent&node_kind=doc&node=${doc.id}&fields=list&limit=1` });
    expect((filtered.body as { changes: Array<{ after: unknown }> }).changes).toEqual([expect.objectContaining({ after: null })]);
    expect((await assertParity(app, activity, { method: "GET", path: `/api/activity?workspace=${slug}&cursor=not-valid` })).status).toBe(400);
    expect((await assertParity(app, activity, { method: "GET", path: `/api/activity?workspace=${slug}&fields=everything` })).status).toBe(400);
    expect((await assertParity(app, activity, { method: "GET", path: "/api/activity" })).status).toBe(400);
    expect((await assertParity(app, activity, { method: "GET", path: "/api/activity?workspace=no-such-workspace" })).status).toBe(404);
  });

  it("GET /api/activity/facets", async () => {
    const { slug } = await feed("activity-facets");
    const ok = await assertParity(app, activityFacets, { method: "GET", path: `/api/activity/facets?workspace=${slug}` });
    expect(ok.status).toBe(200);
    expect(ok.body).toHaveProperty("facets");
    expect((await assertParity(app, activityFacets, { method: "GET", path: "/api/activity/facets" })).status).toBe(400);
    expect((await assertParity(app, activityFacets, { method: "GET", path: "/api/activity/facets?workspace=no-such-workspace" })).status).toBe(404);
  });

  it("GET /api/activity/:id", async () => {
    const { slug, created } = await feed("activity-entry");
    const ok = await assertParity(app, activityEntry, { method: "GET", path: `/api/activity/${created.id}?workspace=${slug}`, params: { id: created.id } });
    expect(ok.status).toBe(200);
    expect((ok.body as { change: { source: string | null } }).change.source).toBe("github:pr-1");
    expect((await assertParity(app, activityEntry, { method: "GET", path: `/api/activity/a-missing?workspace=${slug}`, params: { id: "a-missing" } })).status).toBe(404);
    expect((await assertParity(app, activityEntry, { method: "GET", path: `/api/activity/${created.id}`, params: { id: created.id } })).status).toBe(400);
  });
});

describe("parity: /api/skills", () => {
  it("POST /api/skills/push", async () => {
    const { slug } = workspace("skills-push");
    // Demo storage has no GitHub connection to push to; the route says so
    // with a 400 that is the same on both sides.
    const demo = await assertParity(app, skillsPush, { method: "POST", path: "/api/skills/push", body: { workspace: slug } });
    expect(demo.status).toBe(400);
    expect(demo.body).toEqual({ error: "supabase_required" });
    expect((await assertParity(app, skillsPush, { method: "POST", path: "/api/skills/push", body: {} })).status).toBe(400);
    expect((await assertParity(app, skillsPush, { method: "POST", path: "/api/skills/push", body: { workspace: "no-such-workspace" } })).status).toBe(404);
  });

  it("POST /api/skills/:id/run", async () => {
    const { slug, storage } = workspace("skill-run");
    const doc = await storage.createNode({ title: "Not a skill", kind: "doc", parent_id: null });
    const strict = await storage.createNode({
      title: "Needs input",
      kind: "skill",
      parent_id: null,
      content_md: "---\ninput_schema:\n  fields:\n    - name: topic\n      type: string\n      required: true\n---\nSummarise {{topic}}.",
    });
    const notSkill = await assertParity(app, skillRun, { method: "POST", path: `/api/skills/${doc.id}/run`, params: { id: doc.id }, body: { workspace: slug } });
    expect(notSkill.status).toBe(400);
    const missingInput = await assertParity(app, skillRun, { method: "POST", path: `/api/skills/${strict.id}/run`, params: { id: strict.id }, body: { workspace: slug, input: {} } });
    expect(missingInput.status).toBe(400);
    expect((missingInput.body as { error: string }).error).toContain("topic");
    expect((await assertParity(app, skillRun, { method: "POST", path: "/api/skills/n-missing/run", params: { id: "n-missing" }, body: { workspace: slug } })).status).toBe(404);
    expect((await assertParity(app, skillRun, { method: "POST", path: `/api/skills/${strict.id}/run`, params: { id: strict.id }, body: { workspace: slug, input: "not-an-object" } })).status).toBe(400);
  });

  it.skipIf(hasGatewayKey)("POST /api/skills/:id/run without a gateway key", async () => {
    const { slug, storage } = workspace("skill-run-nokey");
    const skill = await storage.createNode({ title: "Plain", kind: "skill", parent_id: null, content_md: "Say hello." });
    const noKey = await assertParity(app, skillRun, { method: "POST", path: `/api/skills/${skill.id}/run`, params: { id: skill.id }, body: { workspace: slug } });
    expect(noKey.status).toBe(503);
  });
});

describe("parity: /api/embed", () => {
  it("GET /api/embed/migration-status", async () => {
    const ok = await assertParity(app, embedStatus, { method: "GET", path: "/api/embed/migration-status" });
    expect(ok.status).toBe(200);
    expect(ok.body).toHaveProperty("migrating_to");
    expect((await assertParity(app, embedStatus, { method: "GET", path: "/api/embed/migration-status?workspace=anything" })).status).toBe(200);
    // The only 4xx this route can produce needs a configured Supabase to
    // resolve the workspace, so without one there is no error path to
    // compare. A foreign origin at least proves both sides hand the guard
    // the same headers — and that it ignores them on a GET.
    const foreign = await assertParity(app, embedStatus, { method: "GET", path: "/api/embed/migration-status", headers: { origin: "http://evil.example" } });
    expect(foreign.status).toBe(200);
  });
});
