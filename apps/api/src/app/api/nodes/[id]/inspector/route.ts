/**
 * GET /api/nodes/:id/inspector?workspace=…[&scope=preview] — everything the
 * node inspector panel and the hover preview show about one node in a single
 * round trip: the node, backlinks and forward links, a two-level graph,
 * dependencies/relations, recent activity, provenance and freshness.
 *
 * Read verb via `openWorkspace`; the neighbours come from the scoped
 * storage, so links to nodes the principal may not read do not leak through
 * here. `permissions.write` tells the web whether to offer editing without
 * a second call.
 */
import { openWorkspace } from "@/lib/auth/workspace";
import { listForStorage, slimActivityEntry } from "@/lib/activity";
import { findBacklinks, findForwardLinks, buildGraphTwoLevels } from "@bcontext-dev/contract/backlinks";
import {
  buildInspectorRelations,
  inspectorCanWrite,
  nodeFreshness,
  nodeProvenance,
  type NodeInspectorPayload,
} from "@bcontext-dev/contract/node-inspector";
import { withRoute } from "@/lib/route";
import { getReadActivityMap } from "@/lib/rag/staleness";

export const GET = withRoute(async (
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) => {
  const workspace = new URL(req.url).searchParams.get("workspace");
  const ctx = await openWorkspace(req, workspace, "read");
  if (ctx instanceof Response) return ctx;
  const { storage, actor } = ctx;
  const slug = storage.workspace.slug;
  const { id } = await params;
  // `scope=preview` serves the hover/preview popup: it renders only the node
  // header + first block, so skip the context/edges/activity reads entirely.
  const preview = new URL(req.url).searchParams.get("scope") === "preview";
  const [node, nodes, edges, activity] = await Promise.all([
    storage.getNode(id),
    preview ? Promise.resolve([]) : storage.listNodeContext(id),
    preview ? Promise.resolve([]) : storage.listEdges(),
    preview
      ? Promise.resolve([])
      : listForStorage(storage, slug, { nodeId: id, limit: 20 }),
  ]);
  if (!node) return Response.json({ error: "not found" }, { status: 404 });
  const backlinks = findBacklinks(nodes, { id: node.id, slug: node.slug });
  const forwardLinks = findForwardLinks(nodes, {
    id: node.id,
    content_md: node.content_md,
    data: node.data,
  });
  const { dependencies, relations } = buildInspectorRelations(node, nodes, edges);
  const readActivity =
    storage.backend === "supabase" && !preview
      ? (await getReadActivityMap([node.id])).get(node.id) ?? null
      : null;
  const write = inspectorCanWrite(
    actor.kind,
    actor.kind === "agent" || actor.kind === "agent_user"
      ? actor.scopes
      : [],
  );
  const payload: NodeInspectorPayload = {
    node,
    backlinks,
    forward_links: forwardLinks,
    graph: buildGraphTwoLevels(nodes, node),
    dependencies,
    relations,
    // Inspector rows show actor/action/time only — never the before/after
    // markdown snapshots. The Changes view owns diffs (lazy, per entry).
    activity: activity.map(slimActivityEntry),
    provenance: nodeProvenance(node),
    freshness: nodeFreshness(node, Date.now(), readActivity),
    permissions: { read: true, write },
  };
  return Response.json(payload);
});
