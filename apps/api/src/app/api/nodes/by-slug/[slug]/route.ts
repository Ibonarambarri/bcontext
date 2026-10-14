/**
 * GET /api/nodes/by-slug/:slug?workspace=<slug>
 *
 * The id behind a node slug — the current one, or one the node carried
 * before a rename (`data.previous_slugs`), so links written against an old
 * title keep resolving. Answers `{ id, slug }` with the slug the node has
 * now, or 404 when nothing in the caller's reach matches.
 *
 * Exists for `/w/<ws>/s/<slug>`, which used to read the full node list in
 * the page to find the id; over the API, that page only needs this.
 */
import { openWorkspace } from "@/lib/auth/workspace";
import { withRoute } from "@/lib/route";

export const GET = withRoute(async (
  req: Request,
  { params }: { params: Promise<{ slug: string }> },
) => {
  const ws = new URL(req.url).searchParams.get("workspace");
  const ctx = await openWorkspace(req, ws, "read");
  if (ctx instanceof Response) return ctx;
  const { slug } = await params;
  const { storage } = ctx;

  // Fast path: current slugs resolve from the summary index (no bodies, no
  // arbitrary data). Only a miss — a historical slug after a rename — pays
  // for the full node read that carries `data.previous_slugs`.
  const summaries = await storage.listNodeSummaries();
  let hit: { id: string; slug: string } | undefined = summaries.find((n) => n.slug === slug);
  if (!hit) {
    const nodes = await storage.listNodes();
    hit = nodes.find((n) => n.slug === slug) ??
      nodes.find((n) => {
        const prev = (n.data as { previous_slugs?: unknown } | null | undefined)?.previous_slugs;
        return Array.isArray(prev) && prev.includes(slug);
      });
  }
  if (!hit) return Response.json({ error: "not_found" }, { status: 404 });
  return Response.json({ id: hit.id, slug: hit.slug });
});
