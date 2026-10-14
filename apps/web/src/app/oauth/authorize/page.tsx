/**
 * /oauth/authorize — consent screen.
 *
 * The MCP client (Claude Desktop, Cursor, etc.) redirects the user's
 * browser here with the standard OAuth params:
 *
 *   ?response_type=code
 *   &client_id=<id>
 *   &redirect_uri=<url>
 *   &scope=<space-delimited>
 *   &state=<opaque>
 *   &code_challenge=<base64url>
 *   &code_challenge_method=S256
 *   &workspace=<org>/<workspace>  (optional pre-selection)
 *   &resource=<MCP server URL>    (RFC 8707, optional)
 *
 * The user creates a durable agent identity, selects explicit workspaces,
 * chooses a role and can reduce the scopes requested by the client.
 *
 * `resource` is the server URL the client connected through. When it is a
 * workspace endpoint (`/mcp/<org>/<workspace>`) the choice of workspace is
 * already made: the screen locks it to that one and the API issues a token
 * bound to it. The field travels to `POST /api/oauth/authorize` unchanged —
 * the API is the authority on what it accepts; this page only reads it to
 * shape the form.
 */
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { apiJson, apiJsonOrNull } from "@/web/api-client";
import { getSession } from "@/web/session";
import type {
  OAuthClientPublic,
  WorkspaceCard,
} from "@bcontext-dev/contract/workspaces";
import { parseScopes } from "@bcontext-dev/contract/auth/scopes";
import { detectAgentProvider } from "@bcontext-dev/contract/agents/connections";
import { ProviderLogo, detectProviderInfo } from "@/lib/agent-providers";
import { parseMcpResource } from "@/lib/mcp-endpoint";
import { appOrigin } from "@/web/public-origin";
import { AgentConsentForm } from "./agent-consent-form";
import { supabaseAuthConfigured } from "@/lib/public-env";

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function pickString(v: string | string[] | undefined): string | null {
  if (typeof v === "string") return v;
  return null;
}

export default async function AuthorizePage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const clientId = pickString(sp.client_id);
  const redirectUri = pickString(sp.redirect_uri);
  const scope = pickString(sp.scope) ?? "nodes:read nodes:write chat:run";
  const state = pickString(sp.state) ?? "";
  const codeChallenge = pickString(sp.code_challenge);
  const codeChallengeMethod = pickString(sp.code_challenge_method) ?? "S256";
  const preferredWorkspace = pickString(sp.workspace);
  const resource = pickString(sp.resource);
  const responseType = pickString(sp.response_type) ?? "code";

  if (responseType !== "code") {
    return <ErrorScreen title="Unsupported response_type" detail="Only authorization_code is supported." />;
  }
  if (!clientId || !redirectUri || !codeChallenge) {
    return <ErrorScreen title="Missing required parameters" detail="client_id, redirect_uri, and code_challenge are required." />;
  }
  if (codeChallengeMethod !== "S256") {
    return <ErrorScreen title="Unsupported PKCE method" detail="Only S256 is supported." />;
  }

  // Auth check — bounce to login if needed. Keep redirect outside the try:
  // Next implements it by throwing a control-flow error.
  let userId: string | null = null;
  let userEmail: string | null = null;
  try {
    const { data } = await (await getSession()).auth.getUser();
    userId = data.user?.id ?? null;
    userEmail = data.user?.email ?? null;
  } catch {
    // Supabase unconfigured (dev/demo) — fall through.
  }
  if (!userId && supabaseAuthConfigured()) {
    const next = encodeURIComponent(
      `/oauth/authorize?${new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        scope,
        state,
        code_challenge: codeChallenge,
        code_challenge_method: codeChallengeMethod,
        ...(preferredWorkspace ? { workspace: preferredWorkspace } : {}),
        ...(resource ? { resource } : {}),
        response_type: responseType,
      }).toString()}`,
    );
    redirect(`/login?next=${next}`);
  }

  // Look up the client so we can show a human name + validate redirect_uri.
  // Without Supabase there is no registry and the lookup is a 404; the demo
  // preview below then trusts the requested scopes so the screen stays
  // reviewable. With Supabase, a 404 is a client that is not registered.
  let clientName = clientId;
  let clientScope = "";
  let clientVerified = false;
  const found = await apiJsonOrNull<{ client: OAuthClientPublic }>(
    `/api/oauth/clients/${encodeURIComponent(clientId)}`,
  );
  if (found) {
    if (!found.client.redirect_uris.includes(redirectUri)) {
      return <ErrorScreen title="redirect_uri not registered" detail="The redirect URL doesn't match any registered for this client." />;
    }
    clientName = found.client.client_name;
    clientScope = found.client.scope;
    clientVerified = true;
  } else if (supabaseAuthConfigured()) {
    return <ErrorScreen title="Unknown client" detail="The MCP client trying to connect isn't registered (or has been revoked)." />;
  }

  // Workspaces the signed-in user can grant access to. The card read is what
  // carries the organization, and the person approving needs to see it: two
  // companies can both have a `docs`, and this screen hands an agent the keys
  // to one of them.
  const { workspaces } = await apiJson<{ workspaces: WorkspaceCard[] }>(
    "/api/workspaces?stats=1",
  );
  if (workspaces.length === 0) {
    return (
      <ErrorScreen
        title="No workspaces yet"
        detail="You need at least one workspace before you can connect an MCP client. Create one at /workspaces and try again."
      />
    );
  }
  // A workspace endpoint in `resource` decides the workspace outright; the
  // `workspace` hint only suggests one. A URL naming a workspace the person
  // is not a member of ends here — the API would refuse the token anyway,
  // and a form that cannot be submitted correctly is worse than an answer.
  const resourceTarget = parseMcpResource(resource, appOrigin(await headers()));
  const lockedWorkspace =
    resourceTarget?.kind === "workspace"
      ? workspaces.find(
          (w) =>
            w.organization.slug === resourceTarget.org && w.slug === resourceTarget.slug,
        ) ?? null
      : null;
  if (resourceTarget?.kind === "workspace" && !lockedWorkspace) {
    return (
      <ErrorScreen
        title="Workspace not available"
        detail={`This client connects through the endpoint of ${resourceTarget.org}/${resourceTarget.slug}, a workspace your account cannot reach. Ask for access, or point the client at a workspace you belong to.`}
      />
    );
  }
  const defaultWorkspaceId =
    lockedWorkspace?.id ??
    workspaces.find(
      (w) => `${w.organization.slug}/${w.slug}` === preferredWorkspace,
    )?.id ??
    workspaces[0]!.id;
  // In demo mode (no Supabase) there is no client registry to check against,
  // so the preview trusts the scopes the client requested. With Supabase
  // configured an unverified client still grants nothing.
  const demoPreview = !clientVerified && !supabaseAuthConfigured();
  const allowedScopes = new Set(
    parseScopes(
      (clientVerified ? clientScope : demoPreview ? scope : "")
        .split(/\s+/)
        .filter(Boolean),
    ),
  );
  const requestedScopes = parseScopes(scope.split(/\s+/).filter(Boolean))
    .filter((requested) => allowedScopes.has(requested));
  if (requestedScopes.length === 0) {
    return <ErrorScreen title="No valid permissions requested" detail="This client did not request any permission it is registered to use." />;
  }

  const providerInfo = detectProviderInfo(clientName);

  return (
    <div className="min-h-screen bg-[var(--paper)] text-[var(--ink)]">
      <div className="mx-auto max-w-[720px] px-6 py-14">
        <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-[var(--ink-3)]">
          OAuth · MCP client connection
        </p>
        <div className="mt-5 flex items-center gap-4">
          <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-[14px] border border-[var(--line)] bg-[var(--paper-2)]">
            <ProviderLogo provider={providerInfo} size={26} alt={`${providerInfo.name} logo`} />
          </div>
          <div className="min-w-0">
            <h1 className="truncate text-2xl font-semibold tracking-tight">
              Connect {clientName}
            </h1>
            <p className="mt-1 font-mono text-[11px] text-[var(--ink-3)]">
              {providerInfo.name}
              {userEmail ? ` · ${userEmail}` : ""}
            </p>
          </div>
        </div>
        <p className="mt-4 text-[14px] leading-relaxed text-[var(--ink-2)]">
          Confirm the identity and exact access for this agent. Credentials
          can rotate later without losing its history.
        </p>
        <AgentConsentForm
          oauth={{
            clientId,
            redirectUri,
            scope: requestedScopes.join(" "),
            state,
            codeChallenge,
            codeChallengeMethod,
            resource,
          }}
          clientName={clientName}
          userEmail={userEmail}
          workspaces={(lockedWorkspace ? [lockedWorkspace] : workspaces).map((workspace) => ({
            id: workspace.id,
            name: workspace.name,
            slug: `${workspace.organization.slug}/${workspace.slug}`,
          }))}
          defaultWorkspaceId={defaultWorkspaceId}
          workspaceLocked={lockedWorkspace !== null}
          defaultProvider={detectAgentProvider(clientName)}
          requestedScopes={requestedScopes}
        />

        <p className="mt-4 font-mono text-[10px] text-[var(--ink-3)]">
          Manage this identity, its workspaces and sessions from Agents.
        </p>
      </div>
    </div>
  );
}

function ErrorScreen({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--fg)]">
      <div className="mx-auto max-w-md px-6 py-16">
        <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-[var(--fg-subtle)]">
          OAuth error
        </p>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight">{title}</h1>
        <p className="mt-4 text-[14px] leading-relaxed text-[var(--fg-muted)]">
          {detail}
        </p>
      </div>
    </div>
  );
}
