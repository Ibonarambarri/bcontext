/**
 * GET /api/activity/:id?workspace=… — one change entry in full.
 *
 * Called by the web when a feed row is expanded. Read verb via
 * `openWorkspace`; the scoped storage answers 404 for an entry the principal
 * may not see, indistinguishable from one that does not exist.
 */
import { getChangeEntryForStorage } from "@/lib/activity";
import { openWorkspace } from "@/lib/auth/workspace";
import { withRoute } from "@/lib/route";

/**
 * One full change entry (before/after snapshots, relations, provenance,
 * audit evidence). The feed list ships slim rows (`?fields=list`); this is
 * the lazy detail a client fetches when the user expands a row.
 */
export const GET = withRoute(async (
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) => {
  const ws = new URL(req.url).searchParams.get("workspace");
  const ctx = await openWorkspace(req, ws, "read");
  if (ctx instanceof Response) return ctx;
  const { storage } = ctx;
  const slug = storage.workspace.slug;
  const { id } = await params;
  const entry = await getChangeEntryForStorage(storage, slug, id);
  if (!entry) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json({ change: entry });
});
