/**
 * GET /api/oauth/clients/:clientId — a registered client, as the consent
 * screen shows it.
 *
 * Name, allowed redirect URIs, registered scope, and the two URIs the screen
 * may link. Nothing else about the registration leaves — not the secret
 * hash, not who registered it. A revoked client is a 404 like an unknown one:
 * the consent screen treats both as "this client isn't registered", and
 * telling them apart would only help someone probing the registry.
 */
import { gate } from "@/lib/auth/require";
import { isSupabaseConfigured } from "@bcontext-dev/contract/env";
import { withRoute } from "@/lib/route";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import type { OAuthClientPublic } from "@bcontext-dev/contract/workspaces";

export const GET = withRoute(async (
  req: Request,
  { params }: { params: Promise<{ clientId: string }> },
) => {
  const gated = await gate(req);
  if (gated instanceof Response) return gated;
  if (!isSupabaseConfigured()) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }
  const { clientId } = await params;
  const { data } = await getSupabaseAdmin()
    .from("oauth_clients")
    .select("client_id, client_name, redirect_uris, scope, client_uri, logo_uri, revoked_at")
    .eq("client_id", clientId)
    .maybeSingle();
  if (!data || data.revoked_at) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }
  const client: OAuthClientPublic = {
    client_id: data.client_id as string,
    client_name: (data.client_name as string) ?? clientId,
    redirect_uris: (data.redirect_uris as string[] | null) ?? [],
    scope: (data.scope as string) ?? "",
    client_uri: (data.client_uri as string | null) ?? null,
    logo_uri: (data.logo_uri as string | null) ?? null,
  };
  return Response.json({ client });
});
