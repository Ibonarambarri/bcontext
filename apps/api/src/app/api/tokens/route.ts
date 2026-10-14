/**
 * Workspace-scoped bearer tokens — CRUD.
 *
 *   GET  /api/tokens?workspace_id=<uuid>   -> list non-revoked tokens
 *   POST /api/tokens                       -> create + return plaintext once
 *
 * Both routes require an authenticated Supabase user session. RLS enforces
 * that the caller has owner|admin role in the target workspace.
 */
import { z } from "zod";
import { getSupabaseForRequest } from "@/lib/supabase/request";
import { createToken, listTokens } from "@/lib/auth/tokens";
import { SCOPES, type Scope } from "@bcontext-dev/contract/auth/scopes";
import { withRoute } from "@/lib/route";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

const ScopeSchema = z.enum(SCOPES);
const CreateBodySchema = z.object({
  workspace_id: z.string().uuid(),
  name: z.string().trim().min(1).max(80),
  scopes: z.array(ScopeSchema).min(1).max(SCOPES.length),
});

export const GET = withRoute(async (req: Request) => {
  const url = new URL(req.url);
  const workspaceId = url.searchParams.get("workspace_id");
  if (!workspaceId || !z.string().uuid().safeParse(workspaceId).success) {
    return Response.json(
      { error: "invalid_request", message: "workspace_id (uuid) is required" },
      { status: 400 },
    );
  }

  const supabase = getSupabaseForRequest(req);
  const { data: session } = await supabase.auth.getUser();
  if (!session.user) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    const tokens = await listTokens(supabase, workspaceId);
    return Response.json({ tokens });
  } catch (err) {
    return Response.json(
      { error: "internal", message: (err as Error).message },
      { status: 500 },
    );
  }
});

export const POST = withRoute(async (req: Request) => {
  let parsed: { workspace_id: string; name: string; scopes: Scope[] };
  try {
    const json = await req.json();
    const result = CreateBodySchema.safeParse(json);
    if (!result.success) {
      return Response.json(
        { error: "invalid_request", issues: result.error.flatten() },
        { status: 400 },
      );
    }
    parsed = result.data;
  } catch {
    return Response.json(
      { error: "invalid_request", message: "body must be JSON" },
      { status: 400 },
    );
  }

  const supabase = getSupabaseForRequest(req);
  const { data: session } = await supabase.auth.getUser();
  if (!session.user) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    const admin = getSupabaseAdmin();
    const { data: membership } = await admin
      .from("memberships")
      .select("role")
      .eq("workspace_id", parsed.workspace_id)
      .eq("user_id", session.user.id)
      .maybeSingle();
    if (!membership || !["owner", "admin"].includes(membership.role as string)) {
      return Response.json(
        { error: "forbidden", message: "owner or admin role required" },
        { status: 403 },
      );
    }
    // The agent identity comes with the token: `createToken` mints one and
    // unwinds it if the insert is refused, so a hand-made token shows up in
    // the Agents tab beside the ones the consent screen approved.
    const result = await createToken(supabase, {
      workspaceId: parsed.workspace_id,
      name: parsed.name,
      scopes: parsed.scopes,
      createdBy: session.user.id,
      providerLabel: "Manual token",
    });
    return Response.json(result, { status: 201 });
  } catch (err) {
    const message = (err as Error).message;
    // RLS rejection surfaces as a generic insert error. Map to 403.
    if (/row-level security|permission denied|new row violates/i.test(message)) {
      return Response.json(
        { error: "forbidden", message: "owner or admin role required" },
        { status: 403 },
      );
    }
    return Response.json(
      { error: "internal", message },
      { status: 500 },
    );
  }
});
