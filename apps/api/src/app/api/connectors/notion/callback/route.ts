/**
 * GET /api/connectors/notion/callback
 *
 * Notion OAuth redirect target. Notion uses Basic auth on the
 * /v1/oauth/token endpoint (client_id:client_secret base64). No session
 * check: `state` is the install id minted by `POST /api/connectors/:id/install`,
 * and an unknown one is bounced. Every outcome is a redirect with a
 * `?notion=` flag; the install row keeps `last_error` for the detail.
 */
import { redirectTo } from "@/lib/http";
import { appUrl as configuredAppUrl } from "@/lib/env";
import { withRoute } from "@/lib/route";
import {
  getInstallById,
  updateInstall,
} from "@/lib/connectors/installs";
import { putSecret } from "@/lib/connectors/secrets";

interface NotionTokenResp {
  access_token?: string;
  bot_id?: string;
  workspace_id?: string;
  workspace_name?: string;
  error?: string;
}

export const GET = withRoute(async (req: Request) => {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) {
    return redirectTo(new URL("/?notion=invalid", appUrl()));
  }
  const install = await getInstallById(state);
  if (!install) {
    return redirectTo(new URL("/?notion=unknown_install", appUrl()));
  }
  const clientId = process.env.NOTION_CLIENT_ID;
  const clientSecret = process.env.NOTION_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    await updateInstall(install.id, {
      status: "errored",
      last_error: "notion_credentials_missing",
    });
    return redirectTo(new URL("/?notion=not_configured", appUrl()));
  }
  const redirect = `${appUrl()}/api/connectors/notion/callback`;
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const res = await fetch("https://api.notion.com/v1/oauth/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirect,
    }),
  });
  if (!res.ok) {
    await updateInstall(install.id, {
      status: "errored",
      last_error: `oauth_${res.status}`,
    });
    return redirectTo(new URL("/?notion=oauth_failed", appUrl()));
  }
  const json = (await res.json()) as NotionTokenResp;
  if (!json.access_token) {
    await updateInstall(install.id, {
      status: "errored",
      last_error: json.error ?? "no_token",
    });
    return redirectTo(new URL("/?notion=no_token", appUrl()));
  }
  const secretRef = await putSecret({
    workspaceId: install.workspace_id,
    connectorId: "notion",
    plaintext: json.access_token,
  });
  await updateInstall(install.id, {
    secret_ref: secretRef,
    status: "active",
    config: {
      ...install.config,
      notion_workspace_id: json.workspace_id ?? null,
      notion_workspace_name: json.workspace_name ?? null,
      bot_id: json.bot_id ?? null,
    },
    last_error: null,
  });
  return redirectTo(new URL("/?notion=connected", appUrl()));
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
