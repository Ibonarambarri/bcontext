/**
 * GET /api/activity/facets?workspace=… — the values the Changes view offers
 * in its filter selects. Read verb via `openWorkspace`.
 */
import { listChangeFacetsForStorage } from "@/lib/activity";
import { openWorkspace } from "@/lib/auth/workspace";
import { withRoute } from "@/lib/route";

/**
 * Filter options for the Changes view (distinct sources over the recent
 * window). A single light column read — populating the filter selects never
 * requires paging the feed itself.
 */
export const GET = withRoute(async (req: Request) => {
  const ws = new URL(req.url).searchParams.get("workspace");
  const ctx = await openWorkspace(req, ws, "read");
  if (ctx instanceof Response) return ctx;
  const { storage } = ctx;
  const slug = storage.workspace.slug;
  const facets = await listChangeFacetsForStorage(storage, slug);
  return Response.json({ facets });
});
