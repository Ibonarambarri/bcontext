/**
 * User-scoped bearer tokens — CRUD.
 *
 *   GET  /api/tokens/user         -> list the caller's non-revoked user tokens
 *   POST /api/tokens/user         -> create + return plaintext once
 *
 * Both routes require an authenticated Supabase user session (cookie auth).
 * Bearer tokens cannot mint other tokens — minting is a human-only action.
 * RLS on `user_api_tokens` restricts every row to `user_id = auth.uid()`.
 */
import { z } from "zod";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { getSupabaseForRequest } from "@/lib/supabase/request";
import { createUserToken, listUserTokens } from "@/lib/auth/tokens";
import { SCOPES, type Scope } from "@bcontext-dev/contract/auth/scopes";
import { withRoute } from "@/lib/route";
import { AGENT_PROVIDERS, AGENT_ROLES, normalizeRole } from "@bcontext-dev/contract/agents/connections";
import { createAgentConnection, revokeAgentEverywhere } from "@/lib/agents/connections.server";

const ScopeSchema = z.enum(SCOPES);
const CreateBodySchema = z.object({
  name: z.string().trim().min(1).max(80),
  scopes: z.array(ScopeSchema).min(1).max(SCOPES.length),
  // Optional agent configuration (Add agent → API key flow). All fields are
  // backwards compatible: absent fields reproduce the legacy behavior
  // (provider "other" / "Manual user token", role derived from scopes and
  // access to every current membership).
  description: z.string().trim().max(240).optional(),
  provider: z.enum(AGENT_PROVIDERS).optional(),
  provider_label: z.string().trim().max(80).optional(),
  role: z.enum(AGENT_ROLES).optional(),
  workspace_ids: z.array(z.string().uuid()).min(1).max(200).optional(),
});

export const GET = withRoute(async (req: Request) => {
  const supabase = getSupabaseForRequest(req);
  const { data: session } = await supabase.auth.getUser();
  if (!session.user) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    const tokens = await listUserTokens(supabase, session.user.id);
    return Response.json({ tokens });
  } catch (err) {
    return Response.json(
      { error: "internal", message: (err as Error).message },
      { status: 500 },
    );
  }
});

export const POST = withRoute(async (req: Request) => {
  let parsed: z.infer<typeof CreateBodySchema> & { scopes: Scope[] };
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
    const { data: memberships } = await admin
      .from("memberships")
      .select("workspace_id")
      .eq("user_id", session.user.id);
    const memberWorkspaceIds = ((memberships ?? []) as Array<{ workspace_id: string }>).map(
      (row: { workspace_id: string }) => row.workspace_id,
    );
    if (memberWorkspaceIds.length === 0) {
      return Response.json({ error: "no_workspaces" }, { status: 409 });
    }
    // Explicit workspace selection must be a subset of current memberships —
    // same rule as the OAuth consent screen (no implicit future workspaces).
    const memberSet = new Set(memberWorkspaceIds);
    if (parsed.workspace_ids?.some((id) => !memberSet.has(id))) {
      return Response.json(
        { error: "not_a_member", message: "workspace_ids must be workspaces you belong to" },
        { status: 403 },
      );
    }
    const workspaceIds = parsed.workspace_ids ?? memberWorkspaceIds;
    const agentId = await createAgentConnection(admin, {
      ownerUserId: session.user.id,
      name: parsed.name,
      provider: parsed.provider ?? "other",
      providerLabel: parsed.provider_label ?? "Manual user token",
      description: parsed.description,
      workspaceIds,
      role: normalizeRole(parsed.role, parsed.scopes),
      scopes: parsed.scopes,
    });
    let result;
    try {
      result = await createUserToken(supabase, {
        userId: session.user.id,
        name: parsed.name,
        scopes: parsed.scopes,
        agentId,
      });
    } catch (error) {
      await revokeAgentEverywhere(admin, agentId);
      throw error;
    }
    return Response.json(result, { status: 201 });
  } catch (err) {
    const message = (err as Error).message;
    if (/row-level security|permission denied|new row violates/i.test(message)) {
      return Response.json(
        { error: "forbidden", message: "not allowed" },
        { status: 403 },
      );
    }
    return Response.json(
      { error: "internal", message },
      { status: 500 },
    );
  }
});
