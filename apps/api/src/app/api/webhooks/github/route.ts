/**
 * POST /api/webhooks/github
 *
 * GitHub App webhook receiver. We don't know which install owns the
 * payload until we read the `installation.id` field, so the route
 * resolves the install row, then dispatches to the connector.
 */
import { withRoute } from "@/lib/route";
import { getConnectorOrNull } from "@/lib/connectors/registry";
import { ConnectorSignatureError } from "@bcontext-dev/contract/connectors/types";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { getSecret } from "@/lib/connectors/secrets";
import { githubInstallStatusFromWebhook } from "@/lib/connectors/github";
import { updateInstall } from "@/lib/connectors/installs";
import { upsertConnectorNodes } from "@/lib/connectors/runtime";
import { log } from "@bcontext-dev/contract/log";
import "@/lib/connectors/bootstrap";

interface InstallRow {
  id: string;
  workspace_id: string;
  config: Record<string, unknown>;
  secret_ref: string | null;
}

export const POST = withRoute(async (req: Request) => {
  const connector = getConnectorOrNull("github");
  if (!connector) {
    return Response.json({ error: "github_not_registered" }, { status: 503 });
  }

  const rawBody = await req.text();
  const headers: Record<string, string> = {};
  req.headers.forEach((v, k) => {
    headers[k.toLowerCase()] = v;
  });

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  const installationId = (parsed.installation as { id?: number } | undefined)?.id;
  if (!installationId) {
    return Response.json({ error: "missing_installation" }, { status: 400 });
  }

  const sb = getSupabaseAdmin();
  const { data } = await sb
    .from("connector_installs")
    .select("id, workspace_id, config, secret_ref")
    .eq("connector_id", "github")
    .filter("config->>installation_id", "eq", String(installationId))
    .maybeSingle();
  const install = data as InstallRow | null;
  if (!install) {
    log.warn("github.webhook.no_install", { installation_id: installationId });
    return Response.json({ ok: true }, { status: 200 }); // ack to avoid retries
  }

  try {
    const secret = await getSecret(install.secret_ref);
    const outcome = await connector.handleWebhook(
      {
        workspaceId: install.workspace_id,
        installId: install.id,
        config: install.config,
        secret,
      },
      { rawBody, headers },
    );
    const lifecycleStatus = githubInstallStatusFromWebhook(
      headers["x-github-event"] ?? "",
      parsed,
    );
    if (lifecycleStatus) {
      await updateInstall(install.id, {
        status: lifecycleStatus,
        ...(lifecycleStatus === "uninstalled" ? { secret_ref: null } : {}),
      });
    }
    if (outcome.nodes.length > 0) {
      await upsertConnectorNodes(install.workspace_id, outcome.nodes);
    }
    return Response.json({ ok: true });
  } catch (err) {
    if (err instanceof ConnectorSignatureError) {
      return Response.json({ error: "invalid_signature" }, { status: 400 });
    }
    log.error("github.webhook.failed", {
      message: err instanceof Error ? err.message : String(err),
    });
    return Response.json({ error: "internal" }, { status: 500 });
  }
});
