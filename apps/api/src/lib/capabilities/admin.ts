/**
 * Guards shared by the capability admin REST routes (`/api/capabilities*`,
 * `/api/capability-bundles`, `/api/capability-grants`): the caller must be a
 * signed-in owner/admin of the workspace, bodies are validated with the
 * route's zod schema, and approval is gated on a usable credential.
 *
 * Helpers return a `Response` on failure so a route can return it as-is.
 */
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { getSupabaseForRequest } from "@/lib/supabase/request";

/**
 * Session + role check for the admin routes: 401 without a session, 403
 * unless the user is owner/admin of `workspaceId`. Returns the request-scoped
 * client so the route keeps operating under the caller's RLS.
 */
export async function capabilityAdmin(
  req: Request,
  workspaceId: string,
): Promise<
  | { supabase: Awaited<ReturnType<typeof getSupabaseForRequest>>; userId: string }
  | Response
> {
  const supabase = getSupabaseForRequest(req);
  const { data: session } = await supabase.auth.getUser();
  if (!session.user) return Response.json({ error: "unauthorized" }, { status: 401 });
  const { data: membership, error } = await supabase
    .from("memberships")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", session.user.id)
    .maybeSingle();
  if (error || !membership || !["owner", "admin"].includes(membership.role as string)) {
    return Response.json(
      { error: "forbidden", message: "owner or admin role required" },
      { status: 403 },
    );
  }
  return { supabase, userId: session.user.id };
}

/**
 * A capability can only move to `approved` when its connection has a usable
 * credential attached (or needs none). Shared by the generic status PATCH
 * and the explicit review/approve-reject flow so both gate approval the
 * same way.
 */
export async function capabilityCredentialUsable(workspaceId: string, capabilityId: string): Promise<boolean> {
  const admin = getSupabaseAdmin();
  const { data: connection, error: connectionError } = await admin
    .from("capability_connections")
    .select("id,auth_type,secret_ref,enabled")
    .eq("workspace_id", workspaceId)
    .eq("capability_id", capabilityId)
    .eq("environment", "production")
    .maybeSingle();
  let usable = !connectionError && Boolean(connection?.enabled);
  if (usable && connection?.auth_type === "oauth") {
    const { data: credential, error: credentialError } = await admin
      .from("capability_oauth_credentials")
      .select("id")
      .eq("workspace_id", workspaceId)
      .eq("connection_id", connection.id)
      .in("status", ["active", "refreshing"])
      .maybeSingle();
    usable = !credentialError && Boolean(credential);
  } else if (usable && (connection?.auth_type === "bearer" || connection?.auth_type === "header")) {
    usable = Boolean(connection.secret_ref);
  }
  return usable;
}

/** Body → schema, or a 400 with the flattened zod issues (or "body must be JSON"). */
export async function parseJson<T>(
  req: Request,
  schema: { safeParse(input: unknown): { success: true; data: T } | { success: false; error: { flatten(): unknown } } },
): Promise<T | Response> {
  try {
    const result = schema.safeParse(await req.json());
    if (!result.success) {
      return Response.json(
        { error: "invalid_request", issues: result.error.flatten() },
        { status: 400 },
      );
    }
    return result.data;
  } catch {
    return Response.json(
      { error: "invalid_request", message: "body must be JSON" },
      { status: 400 },
    );
  }
}
