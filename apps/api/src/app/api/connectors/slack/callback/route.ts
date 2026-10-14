/**
 * GET /api/connectors/slack/callback
 *
 * OAuth v2 redirect target. Slack returns ?code & state; we exchange for
 * a bot token and persist it as a vault-backed secret. No session check:
 * `state` is the install id minted by `POST /api/connectors/:id/install`,
 * and an unknown one is bounced. Every outcome is a redirect with a
 * `?slack=` flag; the install row keeps `last_error` for the detail.
 */
import { redirectTo } from "@/lib/http";
import { appUrl as configuredAppUrl } from "@/lib/env";
import { withRoute } from "@/lib/route";
import {
  getInstallById,
  updateInstall,
} from "@/lib/connectors/installs";
import { putSecret } from "@/lib/connectors/secrets";

interface OAuthResponse {
  ok: boolean;
  access_token?: string;
  /** Comma-separated scopes actually granted to the bot token. */
  scope?: string;
  bot_user_id?: string;
  team?: { id: string; name?: string };
  authed_user?: { id: string };
  error?: string;
}

export const GET = withRoute(async (req: Request) => {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) {
    return redirectTo(new URL("/?slack=invalid", appUrl()));
  }
  const install = await getInstallById(state);
  if (!install) {
    return redirectTo(new URL("/?slack=unknown_install", appUrl()));
  }

  const clientId = process.env.SLACK_CLIENT_ID;
  const clientSecret = process.env.SLACK_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    await updateInstall(install.id, {
      status: "errored",
      last_error: "slack_credentials_missing",
    });
    return redirectTo(new URL("/?slack=not_configured", appUrl()));
  }

  const redirect = `${appUrl()}/api/connectors/slack/callback`;
  const res = await fetch("https://slack.com/api/oauth.v2.access", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirect,
    }),
  });
  const json = (await res.json()) as OAuthResponse;
  if (!json.ok || !json.access_token || !json.team?.id) {
    await updateInstall(install.id, {
      status: "errored",
      last_error: json.error ?? "oauth_failed",
    });
    return redirectTo(new URL("/?slack=oauth_failed", appUrl()));
  }

  const secretRef = await putSecret({
    workspaceId: install.workspace_id,
    connectorId: "slack",
    plaintext: json.access_token,
  });
  await updateInstall(install.id, {
    secret_ref: secretRef,
    status: "active",
    config: {
      ...install.config,
      team_id: json.team.id,
      team_name: json.team.name ?? null,
      // What Nexos need: the granted scopes decide whether a reply may carry
      // the Nexo's name (`chat:write.customize`), and the bot's user id is the
      // loop guard that keeps a Nexo from answering its own messages.
      scopes: (json.scope ?? "").split(",").map((s) => s.trim()).filter(Boolean),
      bot_user_id: json.bot_user_id ?? null,
    },
    last_error: null,
  });

  return redirectTo(new URL("/?slack=connected", appUrl()));
});

/**
 * The web app's origin: it is both the `redirect_uri` registered with the
 * provider and where the browser must land afterwards. `req.url` is not a
 * substitute — in production the request reaches this process on the API's
 * own origin (or a proxied one), and a redirect built from it would strand
 * the user off the app.
 */
function appUrl(): string {
  return configuredAppUrl() ?? "http://localhost:3000";
}
