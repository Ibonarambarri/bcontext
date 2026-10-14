/**
 * POST /api/webhooks/nango
 *
 * Nango tells us a workspace finished connecting an integration. We find
 * the pending install (workspace from the session tags, connector from
 * `providerConfigKey`), let the connector's `complete` phase verify the
 * connection against Nango and store its id, and kick the first sync.
 *
 * Configure in Nango: Environment settings → Webhooks → URL
 *   https://api.example.com/api/webhooks/nango
 * and paste the signing key as NANGO_WEBHOOK_SECRET.
 */
import { withRoute } from "@/lib/route";
import { getConnectorOrNull } from "@/lib/connectors/registry";
import { getInstall } from "@/lib/connectors/installs";
import { enqueueFullSync } from "@/lib/connectors/runtime";
import { isNangoBacked } from "@/lib/connectors/catalog";
import {
  parseNangoWebhook,
  verifyNangoSignature,
  workspaceIdFromWebhook,
} from "@/lib/nango/webhook";
import { splitIntegrationKey, workspaceMatchesHex } from "@/lib/nango/own-app";
import { log } from "@bcontext-dev/contract/log";
import "@/lib/connectors/bootstrap";

export const POST = withRoute(async (req: Request) => {
  const rawBody = await req.text();
  const headers: Record<string, string> = {};
  req.headers.forEach((v, k) => {
    headers[k.toLowerCase()] = v;
  });

  const signature = verifyNangoSignature(rawBody, headers, {
    webhookSecret: process.env.NANGO_WEBHOOK_SECRET,
    secretKey: process.env.NANGO_SECRET_KEY,
  });
  if (signature === "invalid") {
    return Response.json({ error: "invalid_signature" }, { status: 401 });
  }

  const hook = parseNangoWebhook(rawBody);
  if (!hook) {
    // Not an auth event (sync/forwarded webhooks are not used) — ack so Nango stops retrying.
    return Response.json({ ok: true, ignored: true });
  }
  if (hook.operation !== "creation" && hook.operation !== "override") {
    return Response.json({ ok: true, ignored: hook.operation });
  }
  if (hook.success === false) {
    log.warn("nango.webhook.auth_failed", { provider_config_key: hook.providerConfigKey });
    return Response.json({ ok: true, ignored: "auth_failed" });
  }

  const workspaceId = workspaceIdFromWebhook(hook);
  // Own-OAuth-app installs connect through `<key>--<workspace>`; the
  // connector is the part before the separator and the suffix must be the
  // same workspace the session was opened for.
  const { connectorKey: connectorId, workspaceHex } = splitIntegrationKey(hook.providerConfigKey);
  if (!workspaceId || !isNangoBacked(connectorId) || !workspaceMatchesHex(workspaceId, workspaceHex)) {
    return Response.json({ error: "unknown_install" }, { status: 404 });
  }
  const connector = getConnectorOrNull(connectorId);
  const install = await getInstall(workspaceId, connectorId);
  if (!connector || !install || install.status === "uninstalled") {
    return Response.json({ error: "unknown_install" }, { status: 404 });
  }

  await connector.authorize(
    { workspaceId: install.workspace_id, installId: install.id, config: install.config, secret: null },
    "complete",
    { connection_id: hook.connectionId },
  );

  // First run right away so the hub shows something within a minute; the
  // cadence takes over from there.
  const jobId = await enqueueFullSync({
    workspaceId: install.workspace_id,
    connectorId,
    installId: install.id,
    cursor: null,
  }).catch((err: unknown) => {
    log.warn("nango.webhook.enqueue_failed", { error: err instanceof Error ? err.message : String(err) });
    return null;
  });

  log.info("nango.webhook.connected", {
    workspace_id: workspaceId,
    connector: connectorId,
    signature,
    job_id: jobId,
  });
  return Response.json({ ok: true, install_id: install.id, job_id: jobId });
});
