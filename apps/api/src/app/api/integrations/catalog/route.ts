/**
 * GET /api/integrations/catalog?category=<IntegrationCategory>&q=<text>
 *
 * The marketplace: every integration Bcontext knows, native or Nango-backed,
 * available or coming soon. Not workspace-scoped — the catalog is the same
 * for everyone; what a workspace has connected comes from /api/connectors.
 *
 * Nango-backed `available` entries also carry `setup`: `needs_oauth_app`
 * while the Nango integration still holds placeholder OAuth credentials
 * (owner action pending in the Nango dashboard), `ready` otherwise. Omitted
 * when Nango cannot be asked (src/lib/nango/setup.ts caches the answer 60 s).
 */
import { z } from "zod";
import { gate } from "@/lib/auth/require";
import { withRoute } from "@/lib/route";
import { listCatalog } from "@/lib/connectors/catalog";
import { integrationSetupMap } from "@/lib/nango/setup";
import { INTEGRATION_CATEGORIES } from "@bcontext-dev/contract/connectors/catalog";

const QuerySchema = z.object({
  category: z.enum(INTEGRATION_CATEGORIES as unknown as [string, ...string[]]).optional(),
  q: z.string().max(100).optional(),
});

export const GET = withRoute(async (req: Request) => {
  const gated = await gate(req, undefined, { allowAnonymous: true });
  if (gated instanceof Response) return gated;
  const url = new URL(req.url);
  const parsed = QuerySchema.safeParse({
    category: url.searchParams.get("category") ?? undefined,
    q: url.searchParams.get("q") ?? undefined,
  });
  if (!parsed.success) {
    return Response.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const setup = await integrationSetupMap();
  const entries = listCatalog({
    category: parsed.data.category as never,
    query: parsed.data.q,
  }).map((entry) => {
    if (entry.via !== "nango" || entry.status !== "available") return entry;
    const state = setup.get(entry.key);
    return state ? { ...entry, setup: state } : entry;
  });
  return Response.json(
    { entries },
    { headers: { "Cache-Control": "private, max-age=60" } },
  );
});
