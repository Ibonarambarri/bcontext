/**
 * POST /api/webhooks/linear
 *
 * Linear webhook receiver. The Linear payload includes `webhookId`,
 * which maps to our install via `connector_installs.config.webhook_id`.
 */
import { withRoute } from "@/lib/route";
import { getConnectorOrNull } from "@/lib/connectors/registry";
import { ConnectorSignatureError } from "@bcontext-dev/contract/connectors/types";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { getSecret } from "@/lib/connectors/secrets";
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
  const connector = getConnectorOrNull("linear");
  if (!connector) {
    return Response.json({ error: "linear_not_registered" }, { status: 503 });
  }
  const rawBody = await req.text();
  const headers: Record<string, string> = {};
  req.headers.forEach((v, k) => {
    headers[k.toLowerCase()] = v;
  });

  let parsed: { webhookId?: string };
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }
  const webhookId = parsed.webhookId;
  if (!webhookId) {
    return Response.json({ error: "missing_webhook_id" }, { status: 400 });
  }

  const sb = getSupabaseAdmin();
  const { data } = await sb
    .from("connector_installs")
    .select("id, workspace_id, config, secret_ref")
    .eq("connector_id", "linear")
    .filter("config->>webhook_id", "eq", webhookId)
    .maybeSingle();
  const install = data as InstallRow | null;
  if (!install) {
    log.warn("linear.webhook.no_install", { webhook_id: webhookId });
    return Response.json({ ok: true });
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
    if (outcome.nodes.length > 0) {
      await upsertConnectorNodes(install.workspace_id, outcome.nodes);
    }
    return Response.json({ ok: true });
  } catch (err) {
    if (err instanceof ConnectorSignatureError) {
      return Response.json({ error: "invalid_signature" }, { status: 400 });
    }
    log.error("linear.webhook.failed", {
      message: err instanceof Error ? err.message : String(err),
    });
    return Response.json({ error: "internal" }, { status: 500 });
  }
});
