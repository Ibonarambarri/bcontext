/**
 * POST /api/connectors/[id]/install
 *
 * Begin an install. Routes the request to the connector's `authorize`
 * method with phase='start'. Returns the redirect URL the client should
 * open (OAuth consent screen, GitHub App install, etc.).
 *
 * Body: { workspace_id, config?, oauth_app?: { client_id, client_secret, scopes? } }
 *
 * `oauth_app` is the workspace's OWN OAuth app (hybrid model): given, the
 * credentials go to a per-workspace integration in Nango and the Connect
 * session is bound to it. Without it, an OAuth provider uses Bcontext's
 * shared app when the owner registered one — else 409 `needs_oauth_app`
 * with the entry's `oauth_setup` so the UI can ask for the app. The secret
 * is never logged nor stored here.
 *
 * Native connectors answer with `redirect_url` (OAuth consent / App install).
 * Nango-backed connectors additionally return `connect: { session_token,
 * connect_url }` — the token drives `@nangohq/frontend`'s Connect UI, the
 * URL is the same session as a plain link for a new window.
 *
 * A Slack install also answers with `access`: the install becomes a principal
 * of its own with a documented default reach (everything, until an admin
 * narrows it), and the response says so instead of inheriting it in silence.
 */
import { z } from "zod";
import { gate } from "@/lib/auth/require";
import { readJsonBody } from "@/lib/parse-json";
import { withRoute } from "@/lib/route";
import { getConnectorOrNull } from "@/lib/connectors/registry";
import { upsertInstall } from "@/lib/connectors/installs";
import { ensureInstallPrincipal, describeInstallAccess, type InstallAccess } from "@/lib/auth/install-principal";
import { ConnectorAuthError } from "@bcontext-dev/contract/connectors/types";
import { catalogEntry, isInstallable, isNangoBacked } from "@/lib/connectors/catalog";
import { NangoOAuthAppRequiredError } from "@/lib/connectors/nango";
import "@/lib/connectors/bootstrap";

const Schema = z.object({
  workspace_id: z.string().uuid(),
  config: z.record(z.unknown()).optional(),
  oauth_app: z
    .object({
      client_id: z.string().trim().min(1).max(500),
      client_secret: z.string().min(1).max(2000),
      scopes: z.array(z.string().trim().min(1).max(200)).max(50).optional(),
    })
    .optional(),
});

interface RouteCtx {
  params: Promise<{ id: string }>;
}

export const POST = withRoute(async (req: Request, ctx: RouteCtx) => {
  const gated = await gate(req);
  if (gated instanceof Response) return gated;
  if (gated.kind !== "user") {
    return Response.json(
      { error: "user_session_required" },
      { status: 403 },
    );
  }
  const { id: connectorId } = await ctx.params;
  const connector = getConnectorOrNull(connectorId);
  if (!connector) {
    return Response.json({ error: "unknown_connector" }, { status: 404 });
  }
  if (!isInstallable(connectorId)) {
    return Response.json({ error: "coming_soon" }, { status: 409 });
  }

  const body = await readJsonBody(req);
  if (!body.ok) return body.response;
  const parsed = Schema.safeParse(body.data);
  if (!parsed.success) {
    // Field names only: the body may carry a client secret.
    return Response.json({ error: "invalid_body", fields: Object.keys(parsed.error.flatten().fieldErrors) }, { status: 400 });
  }
  if (parsed.data.oauth_app && catalogEntry(connectorId)?.auth !== "oauth2") {
    return Response.json({ error: "not_oauth" }, { status: 409 });
  }

  const install = await upsertInstall({
    workspaceId: parsed.data.workspace_id,
    connectorId: connector.id,
    config: parsed.data.config ?? {},
    status: "pending",
  });

  // Only Slack searches on behalf of a channel; the other connectors ingest
  // as the system and have no reach to narrow.
  let access: InstallAccess | null = null;
  if (connector.id === "slack") {
    access =
      (await ensureInstallPrincipal({
        workspaceId: install.workspace_id,
        installId: install.id,
        displayName: "Slack bot",
      })) ?? describeInstallAccess(null);
  }

  let redirectUrl: string | undefined;
  let sessionToken: string | undefined;
  try {
    const out = (await connector.authorize(
      {
        workspaceId: install.workspace_id,
        installId: install.id,
        config: install.config,
        secret: null,
      },
      "start",
      parsed.data.oauth_app ? { oauth_app: parsed.data.oauth_app } : undefined,
    )) as { redirectUrl?: string; sessionToken?: string };
    redirectUrl = out.redirectUrl;
    sessionToken = out.sessionToken;
  } catch (e) {
    if (e instanceof NangoOAuthAppRequiredError) {
      return Response.json(
        { error: "needs_oauth_app", oauth_setup: catalogEntry(connectorId)?.oauth_setup ?? null },
        { status: 409 },
      );
    }
    if (e instanceof ConnectorAuthError) {
      return Response.json(
        { error: "connector_not_configured", message: e.message },
        { status: 503 },
      );
    }
    throw e;
  }

  return Response.json({
    install_id: install.id,
    redirect_url: redirectUrl ?? null,
    ...(access ? { access } : {}),
    ...(isNangoBacked(connectorId) && sessionToken
      ? { connect: { session_token: sessionToken, connect_url: redirectUrl ?? null } }
      : {}),
  });
});
