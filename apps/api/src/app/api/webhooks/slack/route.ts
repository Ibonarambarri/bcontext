/**
 * POST /api/webhooks/slack
 *
 * Slack Events API + Slash commands dispatch. URL verification and
 * `/bcontext search …` are handled inline; message + reaction events
 * fall through to the connector, and message events are also routed to
 * the owning Nexo (`src/lib/nexos/triggers/slack-inbound.ts`).
 */
import { withRoute } from "@/lib/route";
import { getConnectorOrNull } from "@/lib/connectors/registry";
import { ConnectorSignatureError } from "@bcontext-dev/contract/connectors/types";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { getSecret } from "@/lib/connectors/secrets";
import { upsertConnectorNodes } from "@/lib/connectors/runtime";
import { retrieveScoped, resolveEmbeddingModel } from "@/lib/rag";
import { getStorageById } from "@/lib/storage";
import { scopedStorage } from "@/lib/storage/scoped";
import { hasVerb, isDenied, systemGrant, type Grant } from "@/lib/auth/grants";
import { resolveInstallGrant } from "@/lib/auth/install-principal";
import { log } from "@bcontext-dev/contract/log";
import { dropOwnedMessageNodes, routeSlackEventToNexos } from "@/lib/nexos/triggers/slack-inbound";
import "@/lib/connectors/bootstrap";

interface InstallRow {
  id: string;
  workspace_id: string;
  workspace_slug?: string;
  config: Record<string, unknown>;
  secret_ref: string | null;
}

export const POST = withRoute(async (req: Request) => {
  const connector = getConnectorOrNull("slack");
  if (!connector) {
    return Response.json({ error: "slack_not_registered" }, { status: 503 });
  }

  const rawBody = await req.text();
  const headers: Record<string, string> = {};
  req.headers.forEach((v, k) => {
    headers[k.toLowerCase()] = v;
  });

  // URL verification handshake — Slack POSTs `{ type, challenge }`.
  const isJson = (headers["content-type"] ?? "").includes("application/json");
  if (isJson) {
    try {
      const parsed = JSON.parse(rawBody) as { type?: string; challenge?: string };
      if (parsed.type === "url_verification" && parsed.challenge) {
        return new Response(parsed.challenge, {
          status: 200,
          headers: { "Content-Type": "text/plain" },
        });
      }
    } catch {
      // fall through
    }
  }

  // Slash command — form-encoded.
  if ((headers["content-type"] ?? "").includes("application/x-www-form-urlencoded")) {
    const params = new URLSearchParams(rawBody);
    const teamId = params.get("team_id");
    const command = params.get("command") ?? "";
    const text = params.get("text") ?? "";

    // Resolve install by Slack team_id.
    const install = teamId ? await getSlackInstallByTeam(teamId) : null;
    if (!install) {
      return Response.json(
        { response_type: "ephemeral", text: "Bcontext is not connected to this workspace." },
        { status: 200 },
      );
    }
    if (!(await isSignatureValid(rawBody, headers))) {
      return Response.json({ error: "invalid_signature" }, { status: 400 });
    }

    if (command === "/bcontext" && text.startsWith("search")) {
      const query = text.slice("search".length).trim();
      if (!query) {
        return Response.json(
          { response_type: "ephemeral", text: "Usage: `/bcontext search <query>`" },
          { status: 200 },
        );
      }
      // Retrieval here runs on behalf of the install, not a person: the
      // request is authenticated by the install's HMAC and anyone in the
      // channel can trigger it. The install is a principal of its own
      // (`install-principal.ts`), so an admin can narrow what the bot sees;
      // the installing person's grant is never used — it would hand the whole
      // channel one person's permissions while looking scoped.
      const workspaceId = install.workspace_id as string;
      const grant = await grantForInstall(workspaceId, install.id);
      if (!grant) {
        return Response.json(
          {
            response_type: "ephemeral",
            text: "Bcontext search is turned off for this Slack workspace. Ask a Bcontext admin to grant the Slack bot access.",
          },
          { status: 200 },
        );
      }
      const inner = await getStorageById(workspaceId);
      const hits = inner
        ? (
            await retrieveScoped(workspaceId, query, {
              k: 3,
              embeddingModel: resolveEmbeddingModel(),
              storage: scopedStorage(inner, grant),
            })
          ).hits
        : [];
      // Only what the bot's reach allows is listed, and nothing else is
      // mentioned: no "N more results you can't see", no note that the search
      // was narrowed. A channel the admin kept out of finanzas must not learn
      // from the reply that finanzas exists.
      const lines = hits.length
        ? hits.map((h, i) => `*[${i + 1}]* ${h.title}\n${(h.content ?? "").slice(0, 180)}`)
        : ["_no results_"];
      return Response.json(
        { response_type: "ephemeral", text: lines.join("\n\n") },
        { status: 200 },
      );
    }

    return Response.json(
      { response_type: "ephemeral", text: `Unknown subcommand. Try \`/bcontext search <q>\`.` },
      { status: 200 },
    );
  }

  // Event API path.
  let payload: { team_id?: string; api_app_id?: string };
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }
  const install = payload.team_id ? await getSlackInstallByTeam(payload.team_id) : null;
  if (!install) {
    log.warn("slack.webhook.no_install", { team_id: payload.team_id });
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
    // Nexos hear the message too (after the signature check above). A channel
    // a Nexo owns is ingested by its window flush, so its per-message node is
    // dropped here; unbound channels keep the legacy capture unchanged.
    const nexos = await routeSlackEventToNexos(install, rawBody);
    const nodes = dropOwnedMessageNodes(outcome.nodes, nexos.ownedChannel);
    if (nodes.length > 0) {
      await upsertConnectorNodes(install.workspace_id, nodes);
    }
    return Response.json({ ok: true });
  } catch (err) {
    if (err instanceof ConnectorSignatureError) {
      return Response.json({ error: "invalid_signature" }, { status: 400 });
    }
    log.error("slack.webhook.failed", {
      message: err instanceof Error ? err.message : String(err),
    });
    return Response.json({ error: "internal" }, { status: 500 });
  }
});

/**
 * The grant the install acts under, or `null` when it may not search at all.
 *
 * An install with no principal row yet — created before the migration, or
 * whose principal write failed — keeps working exactly as before, on a system
 * grant, with a warning in the log. Refusing it would break every existing
 * integration; the migration backfills those rows so the branch closes itself.
 * A revoked or narrowed-to-nothing grant, by contrast, denies: that is what
 * revoking is for.
 */
async function grantForInstall(workspaceId: string, installId: string): Promise<Grant | null> {
  const resolved = await resolveInstallGrant(workspaceId, installId);
  if (!resolved) {
    log.warn("slack.search.unscoped_install", {
      workspace_id: workspaceId,
      install_id: installId,
      reason: "install has no principal; searching the whole workspace",
    });
    return systemGrant(workspaceId, `slack install ${installId} without a principal yet`);
  }
  if (isDenied(resolved.grant) || !hasVerb(resolved.grant, "read")) return null;
  return resolved.grant;
}

async function getSlackInstallByTeam(teamId: string): Promise<InstallRow | null> {
  const sb = getSupabaseAdmin();
  const { data } = await sb
    .from("connector_installs")
    .select("id, workspace_id, config, secret_ref, workspaces(slug)")
    .eq("connector_id", "slack")
    .filter("config->>team_id", "eq", teamId)
    .maybeSingle();
  if (!data) return null;
  const ws = (data as { workspaces?: { slug?: string } }).workspaces;
  return {
    id: (data as { id: string }).id,
    workspace_id: (data as { workspace_id: string }).workspace_id,
    workspace_slug: ws?.slug,
    config: (data as { config: Record<string, unknown> }).config ?? {},
    secret_ref: (data as { secret_ref: string | null }).secret_ref,
  };
}

async function isSignatureValid(
  rawBody: string,
  headers: Record<string, string>,
): Promise<boolean> {
  const secret = process.env.SLACK_SIGNING_SECRET;
  if (!secret) return false;
  const { verifySlackSignature } = await import("@/lib/connectors/slack");
  return verifySlackSignature(secret, { rawBody, headers });
}
