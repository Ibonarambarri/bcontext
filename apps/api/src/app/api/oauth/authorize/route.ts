/**
 * POST /api/oauth/authorize
 *
 * Consent-screen form submit (the web renders the screen; an MCP host such
 * as Claude or Cursor started the flow at `/.well-known/oauth-*`). Verifies
 * the user's session, validates the client + redirect_uri + the workspaces
 * the person reaches, creates the agent connection, then issues a one-shot
 * authorization_code and redirects back to the client.
 *
 * The client and its redirect_uri are checked before anything else — before
 * the session, before the deny branch — so a forged form can never turn the
 * deny redirect into an open redirect. On deny, redirects with
 * `?error=access_denied`.
 *
 * `resource` (RFC 8707) is the MCP endpoint the client started from, which
 * the consent screen forwards from the authorize query. Through
 * `/mcp/<org>/<workspace>` the grant is that workspace's alone: the form
 * has to select exactly that workspace and the code redeems as a
 * workspace-scoped token (30-day TTL, refresh token). Through `/mcp`, or
 * with no `resource`, the grant is user-scoped as before. Anything else is
 * `invalid_target`.
 */
import { redirectTo } from "@/lib/http";
import { withRoute } from "@/lib/route";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { getSupabaseForRequest } from "@/lib/supabase/request";
import { issueAuthorizationCode } from "@/lib/auth/oauth";
import { hasVerb, isDenied, resolveGrantForPrincipal } from "@/lib/auth/grants";
import { parseScopes } from "@bcontext-dev/contract/auth/scopes";
import { AGENT_PROVIDERS, AGENT_ROLES, scopesForRole, type AgentProvider, type AgentRole } from "@bcontext-dev/contract/agents/connections";
import { createAgentConnection, revokeAgentEverywhere } from "@/lib/agents/connections.server";
import { parseMcpResource } from "@/lib/mcp/resource";
import { findWorkspaceByRef } from "@/lib/workspaces/resolve";

export const POST = withRoute(async (req: Request) => {
  const form = await req.formData();
  const clientId = String(form.get("client_id") ?? "");
  const redirectUri = String(form.get("redirect_uri") ?? "");
  const scope = String(form.get("scope") ?? "nodes:read");
  const state = String(form.get("state") ?? "");
  const codeChallenge = String(form.get("code_challenge") ?? "");
  const codeChallengeMethod = (form.get("code_challenge_method") ??
    "S256") as "S256" | "plain";
  const workspaceIds = [...new Set(form.getAll("workspace_ids").map(String).filter(Boolean))];
  const agentName = String(form.get("agent_name") ?? "").trim();
  const provider = String(form.get("provider") ?? "other") as AgentProvider;
  const providerLabel = String(form.get("provider_label") ?? "").trim();
  const description = String(form.get("description") ?? "").trim();
  const requestedScopes = parseScopes(scope.split(/\s+/).filter(Boolean));
  const selectedScopes = parseScopes(form.getAll("scopes").map(String));
  const submittedRole = String(form.get("role") ?? "custom") as AgentRole;
  const decision = String(form.get("decision") ?? "");
  const resource = parseMcpResource(req, form.get("resource")?.toString());

  if (!clientId || !redirectUri || !codeChallenge) {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }

  // Validate the registered client before constructing or redirecting to a
  // caller-supplied URI. This also protects the deny path from open redirects.
  const admin = getSupabaseAdmin();
  const { data: client } = await admin
    .from("oauth_clients")
    .select("redirect_uris, scope, revoked_at")
    .eq("client_id", clientId)
    .maybeSingle();
  if (!client || client.revoked_at) {
    return Response.json({ error: "invalid_client" }, { status: 400 });
  }
  const allowed = (client.redirect_uris as string[]) ?? [];
  if (!allowed.includes(redirectUri)) {
    return Response.json(
      { error: "invalid_redirect_uri" },
      { status: 400 },
    );
  }
  const redirect = new URL(redirectUri);
  if (decision !== "allow") {
    redirect.searchParams.set("error", "access_denied");
    if (state) redirect.searchParams.set("state", state);
    return redirectTo(redirect, 303);
  }

  // User session is required.
  const supabase = getSupabaseForRequest(req);
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) {
    return Response.json({ error: "login_required" }, { status: 401 });
  }
  const userId = userData.user.id;

  if (resource === null) {
    return Response.json(
      {
        error: "invalid_target",
        error_description: "resource must be this server's /mcp or /mcp/<organization>/<workspace> URL",
      },
      { status: 400 },
    );
  }

  if (
    !agentName || agentName.length > 80 || description.length > 240 ||
    !AGENT_PROVIDERS.includes(provider) || !AGENT_ROLES.includes(submittedRole) ||
    workspaceIds.length === 0 || selectedScopes.length === 0
  ) {
    return Response.json({ error: "invalid_agent_configuration" }, { status: 400 });
  }
  const requestedSet = new Set(requestedScopes);
  const clientScopes = new Set(parseScopes(String(client.scope ?? "").split(/\s+/).filter(Boolean)));
  if (
    requestedScopes.some((requested) => !clientScopes.has(requested)) ||
    selectedScopes.some((selected) => !requestedSet.has(selected))
  ) {
    return Response.json({ error: "invalid_scope" }, { status: 400 });
  }
  const presetScopes = scopesForRole(submittedRole, requestedScopes, selectedScopes);
  const role: AgentRole = submittedRole !== "custom" &&
    presetScopes.length === selectedScopes.length &&
    presetScopes.every((item) => selectedScopes.includes(item))
    ? submittedRole
    : "custom";

  // Every selected workspace must be one this person reaches right now. We
  // snapshot the set into agent_workspace_access; future workspaces are not
  // implicit — approving an agent is about the workspaces on the screen.
  //
  // "Reaches" is `resolveGrant`'s question, so it is asked with `resolveGrant`'s
  // own answer rather than a second reading of the tables underneath. An owner
  // or admin who joined by invitation has no `memberships` rows on purpose —
  // their organization role covers every workspace the company holds, including
  // the ones created after they arrived — and a membership lookup here refuses
  // them their own company's workspaces.
  // A grant started from a workspace's own endpoint is for that workspace
  // and no other: the token it becomes is bound to the path the client
  // connected to. A name that resolves to nothing gets the same answer as a
  // mismatch, so the form cannot be used to check which workspaces exist.
  let boundWorkspaceId: string | null = null;
  if (resource?.kind === "workspace") {
    const named = await findWorkspaceByRef(resource.name, "id");
    const id = (named?.id as string | undefined) ?? null;
    if (!id || workspaceIds.length !== 1 || workspaceIds[0] !== id) {
      return Response.json(
        {
          error: "invalid_request",
          error_description: `resource names the workspace "${resource.name}": workspace_ids must be exactly that workspace`,
        },
        { status: 400 },
      );
    }
    boundWorkspaceId = id;
  }

  const grants = await Promise.all(
    workspaceIds.map((workspaceId) =>
      resolveGrantForPrincipal({ kind: "user", id: userId }, workspaceId),
    ),
  );
  if (grants.some((grant) => isDenied(grant) || !hasVerb(grant, "read"))) {
    return Response.json({ error: "not_a_member" }, { status: 403 });
  }

  const agentId = await createAgentConnection(admin, {
    ownerUserId: userId,
    name: agentName,
    provider,
    providerLabel,
    description,
    workspaceIds,
    role,
    scopes: selectedScopes,
  });
  let code: string;
  try {
    code = await issueAuthorizationCode(admin, {
      clientId,
      userId,
      workspaceId: boundWorkspaceId,
      scopeKind: boundWorkspaceId ? "workspace" : "user",
      scope: selectedScopes.join(" "),
      redirectUri,
      codeChallenge,
      codeChallengeMethod,
      agentId,
    });
  } catch (error) {
    await revokeAgentEverywhere(admin, agentId);
    throw error;
  }

  redirect.searchParams.set("code", code);
  if (state) redirect.searchParams.set("state", state);
  return redirectTo(redirect, 303);
});
