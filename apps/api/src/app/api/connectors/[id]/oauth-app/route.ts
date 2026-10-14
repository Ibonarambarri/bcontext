/**
 * PUT    /api/connectors/[id]/oauth-app  — replace the workspace's OWN OAuth app credentials
 * DELETE /api/connectors/[id]/oauth-app  — switch the install back to Bcontext's shared app
 *
 * Hybrid OAuth (docs/integrations-nango.md → "Bring your own OAuth app"):
 * the credentials are written straight to the workspace's own integration in
 * Nango (`<key>--<workspace>`), never to our database or logs. Both calls
 * leave the install `pending` with no connection — the person reconnects
 * through the Connect UI afterwards (`reconnect_required: true`).
 *
 * Bodies: PUT { workspace_id, client_id, client_secret, scopes?: string[] }
 *         DELETE { workspace_id }
 */
import { z } from "zod";
import { openWorkspaceById } from "@/lib/auth/workspace";
import { readJsonBody } from "@/lib/parse-json";
import { withRoute } from "@/lib/route";
import { getInstall, updateInstall } from "@/lib/connectors/installs";
import { catalogEntry, isNangoBacked } from "@/lib/connectors/catalog";
import { NangoError, nangoClient } from "@/lib/nango/client";
import { deleteOwnOAuthApp, installIntegrationKey, installOAuthAppKind, upsertOwnOAuthApp } from "@/lib/nango/own-app";
import { setupFromCredentials } from "@/lib/nango/setup";
import type { ConnectorId } from "@bcontext-dev/contract/connectors/types";
import { log } from "@bcontext-dev/contract/log";
import "@/lib/connectors/bootstrap";

const PutSchema = z.object({
  workspace_id: z.string().uuid(),
  client_id: z.string().trim().min(1).max(500),
  client_secret: z.string().min(1).max(2000),
  scopes: z.array(z.string().trim().min(1).max(200)).max(50).optional(),
});

const DeleteSchema = z.object({ workspace_id: z.string().uuid() });

interface RouteCtx {
  params: Promise<{ id: string }>;
}

function sanitizedInstall<T extends { config: Record<string, unknown> }>(install: T, config: Record<string, unknown>): T {
  return { ...install, config };
}

async function dropConnection(client: ReturnType<typeof nangoClient>, config: Record<string, unknown>, connectorId: string) {
  const connectionId = typeof config.nango_connection_id === "string" ? config.nango_connection_id : null;
  if (!connectionId) return;
  try {
    await client.deleteConnection(connectionId, installIntegrationKey(config, connectorId));
  } catch (err) {
    log.warn("connector.oauth_app.connection_drop_failed", {
      connector: connectorId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export const PUT = withRoute(async (req: Request, ctx: RouteCtx) => {
  const body = await readJsonBody(req);
  if (!body.ok) return body.response;
  const parsed = PutSchema.safeParse(body.data);
  if (!parsed.success) {
    // Never echo the body back: it carries the client secret.
    return Response.json({ error: "invalid_body", fields: Object.keys(parsed.error.flatten().fieldErrors) }, { status: 400 });
  }
  const opened = await openWorkspaceById(req, parsed.data.workspace_id, "write", { scope: null });
  if (opened instanceof Response) return opened;

  const { id: connectorId } = await ctx.params;
  const entry = catalogEntry(connectorId);
  if (!entry || !isNangoBacked(connectorId) || !entry.nango_provider) {
    return Response.json({ error: "unknown_connector" }, { status: 404 });
  }
  if (entry.auth !== "oauth2") {
    return Response.json({ error: "not_oauth" }, { status: 409 });
  }
  const install = await getInstall(parsed.data.workspace_id, connectorId as ConnectorId);
  if (!install || install.status === "uninstalled") {
    return Response.json({ error: "not_installed" }, { status: 404 });
  }

  let client;
  try {
    client = nangoClient();
  } catch (err) {
    if (err instanceof NangoError && err.code === "not_configured") {
      return Response.json({ error: "connector_not_configured", message: err.message }, { status: 503 });
    }
    throw err;
  }

  const integrationKey = await upsertOwnOAuthApp(client, {
    connectorKey: connectorId,
    nangoProvider: entry.nango_provider,
    displayName: entry.name,
    workspaceId: parsed.data.workspace_id,
    clientId: parsed.data.client_id,
    clientSecret: parsed.data.client_secret,
    scopes: parsed.data.scopes ?? null,
  });

  // New credentials invalidate whatever token the old app issued.
  await dropConnection(client, install.config, connectorId);
  const config: Record<string, unknown> = {
    ...install.config,
    provider: "nango",
    nango_provider: entry.nango_provider,
    nango_integration_key: integrationKey,
    oauth_app: "own",
  };
  delete config.nango_connection_id;
  delete config.nango_connection_config;
  await updateInstall(install.id, { config, status: "pending", last_error: null });

  log.info("connector.oauth_app.replaced", { workspace_id: parsed.data.workspace_id, connector: connectorId });
  const { secret_ref: _unused, ...safe } = sanitizedInstall(install, config);
  return Response.json({ install: { ...safe, status: "pending" }, reconnect_required: true });
});

export const DELETE = withRoute(async (req: Request, ctx: RouteCtx) => {
  const body = await readJsonBody(req);
  if (!body.ok) return body.response;
  const parsed = DeleteSchema.safeParse(body.data);
  if (!parsed.success) {
    return Response.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const opened = await openWorkspaceById(req, parsed.data.workspace_id, "write", { scope: null });
  if (opened instanceof Response) return opened;

  const { id: connectorId } = await ctx.params;
  const entry = catalogEntry(connectorId);
  if (!entry || !isNangoBacked(connectorId)) {
    return Response.json({ error: "unknown_connector" }, { status: 404 });
  }
  const install = await getInstall(parsed.data.workspace_id, connectorId as ConnectorId);
  if (!install || install.status === "uninstalled") {
    return Response.json({ error: "not_installed" }, { status: 404 });
  }
  if (installOAuthAppKind(install.config) !== "own") {
    return Response.json({ error: "already_shared" }, { status: 409 });
  }

  let client;
  try {
    client = nangoClient();
  } catch (err) {
    if (err instanceof NangoError && err.code === "not_configured") {
      return Response.json({ error: "connector_not_configured", message: err.message }, { status: 503 });
    }
    throw err;
  }

  // Only when Bcontext's shared app exists: otherwise the workspace would
  // be left with nothing to connect through.
  const shared = await client.getIntegration(connectorId);
  if (!shared || setupFromCredentials(shared.credentials?.clientId) !== "ready") {
    return Response.json({ error: "needs_oauth_app", oauth_setup: entry.oauth_setup ?? null }, { status: 409 });
  }

  await dropConnection(client, install.config, connectorId);
  try {
    await deleteOwnOAuthApp(client, connectorId, parsed.data.workspace_id);
  } catch (err) {
    log.warn("connector.oauth_app.own_delete_failed", {
      connector: connectorId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  const config: Record<string, unknown> = {
    ...install.config,
    nango_integration_key: connectorId,
    oauth_app: "shared",
  };
  delete config.nango_connection_id;
  delete config.nango_connection_config;
  await updateInstall(install.id, { config, status: "pending", last_error: null });

  log.info("connector.oauth_app.switched_to_shared", { workspace_id: parsed.data.workspace_id, connector: connectorId });
  const { secret_ref: _unused, ...safe } = sanitizedInstall(install, config);
  return Response.json({ install: { ...safe, status: "pending" }, reconnect_required: true });
});
