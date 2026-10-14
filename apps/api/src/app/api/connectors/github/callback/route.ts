/**
 * GET /api/connectors/github/callback
 *
 * Lands here after the user installs the GitHub App. GitHub appends
 *   ?installation_id=<n>&setup_action=install&state=<install_id>
 *
 * We exchange the installation_id for an access token, persist it as a
 * vault-backed secret, and flip the install to 'active'.
 *
 * No session check: the browser arrives from GitHub, so `state` — the
 * install id minted by `POST /api/connectors/:id/install` — is what ties the
 * callback to a workspace, and an unknown one is bounced without touching
 * anything. On error we still redirect — the settings UI shows the install
 * row's `status='errored'` + `last_error` for diagnostics.
 */
import { redirectTo } from "@/lib/http";
import { appBaseUrl } from "@/lib/app-url";
import { withRoute } from "@/lib/route";
import {
  getInstallById,
  updateInstall,
} from "@/lib/connectors/installs";
import {
  githubInstallationId,
  refreshInstallationToken,
} from "@/lib/connectors/github";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

async function resolveSlug(workspaceId: string): Promise<string | null> {
  try {
    const admin = getSupabaseAdmin();
    const { data } = await admin
      .from("workspaces")
      .select("slug")
      .eq("id", workspaceId)
      .maybeSingle();
    return (data?.slug as string | undefined) ?? null;
  } catch {
    return null;
  }
}

/**
 * Back to the web app, never to the request's own origin: GitHub sends the
 * browser to the `redirect_uri` we registered (the app's origin, which
 * proxies `/api/*` here), so in production `req.url` is the API host or a
 * proxied one and a redirect built from it would strand the user off the app.
 */
function redirectBack(slug: string | null, flag: string): Response {
  const target = slug
    ? `/workspaces?ws=${encodeURIComponent(slug)}&${flag}`
    : `/?${flag}`;
  return redirectTo(new URL(target, appBaseUrl()));
}

export const GET = withRoute(async (req: Request) => {
  const url = new URL(req.url);
  const installationId = url.searchParams.get("installation_id");
  const state = url.searchParams.get("state");
  const parsedInstallationId = githubInstallationId({
    installation_id: installationId,
  });
  if (!parsedInstallationId || !state) {
    return redirectBack(null, "github=invalid");
  }

  const install = await getInstallById(state);
  if (!install) {
    return redirectBack(null, "github=unknown_install");
  }

  const slug = await resolveSlug(install.workspace_id);

  const result = await refreshInstallationToken({
    workspaceId: install.workspace_id,
    installId: install.id,
    installationId: parsedInstallationId,
  });
  if (!result) {
    await updateInstall(install.id, {
      status: "errored",
      last_error: "token_exchange_failed",
    });
    return redirectBack(slug, "github=token_failed");
  }

  await updateInstall(install.id, {
    secret_ref: result.secretRef,
    status: "active",
    config: { ...install.config, installation_id: String(parsedInstallationId) },
    last_error: null,
  });

  return redirectBack(slug, "github=connected");
});
