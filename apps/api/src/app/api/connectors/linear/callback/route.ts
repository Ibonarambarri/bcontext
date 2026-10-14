/**
 * GET /api/connectors/linear/callback
 *
 * Linear OAuth redirect. Exchange code for an access token, persist via
 * putSecret, flip install to 'active'. No session check: `state` is the
 * install id minted by `POST /api/connectors/:id/install`, and an unknown
 * one is bounced. Every outcome is a redirect with a `?linear=` flag the
 * settings UI reads; the install row keeps `last_error` for the detail.
 */
import { redirectTo } from "@/lib/http";
import { appUrl as configuredAppUrl } from "@/lib/env";
import { withRoute } from "@/lib/route";
import {
  getInstallById,
  updateInstall,
} from "@/lib/connectors/installs";
import { putSecret } from "@/lib/connectors/secrets";

export const GET = withRoute(async (req: Request) => {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) {
    return redirectTo(new URL("/?linear=invalid", appUrl()));
  }
  const install = await getInstallById(state);
  if (!install) {
    return redirectTo(new URL("/?linear=unknown_install", appUrl()));
  }

  const clientId = process.env.LINEAR_CLIENT_ID;
  const clientSecret = process.env.LINEAR_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    await updateInstall(install.id, {
      status: "errored",
      last_error: "linear_credentials_missing",
    });
    return redirectTo(new URL("/?linear=not_configured", appUrl()));
  }
  const redirect = `${appUrl()}/api/connectors/linear/callback`;
  const res = await fetch("https://api.linear.app/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirect,
      grant_type: "authorization_code",
    }),
  });
  if (!res.ok) {
    await updateInstall(install.id, {
      status: "errored",
      last_error: `oauth_${res.status}`,
    });
    return redirectTo(new URL("/?linear=oauth_failed", appUrl()));
  }
  const json = (await res.json()) as { access_token?: string; token_type?: string };
  if (!json.access_token) {
    await updateInstall(install.id, {
      status: "errored",
      last_error: "no_access_token",
    });
    return redirectTo(new URL("/?linear=no_token", appUrl()));
  }
  const secretRef = await putSecret({
    workspaceId: install.workspace_id,
    connectorId: "linear",
    plaintext: json.access_token,
  });
  await updateInstall(install.id, {
    secret_ref: secretRef,
    status: "active",
    last_error: null,
  });
  return redirectTo(new URL("/?linear=connected", appUrl()));
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
