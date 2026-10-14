/**
 * How a Nexo reaches Slack's Web API through a connector install: the
 * first-party app (bot token in the install's secret) or the Nango-backed
 * `slack-nango` install (token held by Nango, call through its proxy). One
 * `slackCall` hides which, so posting a reply (`outbound.ts`) and listing
 * channels for the binding picker (`slack-channels.ts`) do not each re-derive
 * the token or the proxy key.
 *
 * Must not break:
 *   - Never throws for a Slack/Nango refusal: `{ ok: false, error }` with
 *     Slack's own error code when it gave one, `http_<status>` otherwise.
 *   - Callers check the install's workspace and status first; this module
 *     only knows how to talk, not whom it may talk for.
 *   - Deps are late-bound (see `realDeps`) so tests can swap the fetch, the
 *     Nango client and the install lookup without mocking modules.
 */
import { getInstallById, type ConnectorInstall } from "@/lib/connectors/installs";
import { getSecret } from "@/lib/connectors/secrets";
import { isNangoInstall } from "@/lib/connectors/nango";
import { installIntegrationKey } from "@/lib/nango/own-app";
import { nangoClient, type NangoClient } from "@/lib/nango/client";

/** Test seams: the Slack fetch, the Nango client and the install lookup. */
export type SlackDeps = {
  fetch: typeof fetch;
  nango: () => NangoClient;
  getInstall: (id: string) => Promise<ConnectorInstall | null>;
};

// Late-bound on purpose: modules that import this one (the runner, the inbox)
// are mocked piecemeal in their own tests, and reading an import at module
// load would fail there for a function those tests never call.
const realDeps = (): SlackDeps => ({
  fetch: (...a) => fetch(...a),
  nango: () => nangoClient(),
  getInstall: (id) => getInstallById(id),
});
export const slackDeps: SlackDeps = realDeps();

export function setSlackDepsForTests(patch: Partial<SlackDeps> | null): void {
  Object.assign(slackDeps, patch ?? realDeps());
}

/** Which way this install reaches Slack, or null when it is not a Slack install. */
export function slackTransport(install: ConnectorInstall): "token" | "nango" | null {
  if (isNangoInstall(install.config)) {
    return install.connector_id === "slack-nango" || install.config.nango_provider === "slack" ? "nango" : null;
  }
  return install.connector_id === "slack" ? "token" : null;
}

export type SlackCallResult<T> = { ok: true; data: T } | { ok: false; error: string };

type SlackEnvelope = { ok?: boolean; error?: string };

/**
 * One Slack Web API call (`api` is the method name, e.g. `chat.postMessage`).
 * GET sends `query`; POST sends `body` as JSON.
 */
export async function slackCall<T extends SlackEnvelope>(
  install: ConnectorInstall,
  req: { api: string; method: "GET" | "POST"; query?: Record<string, string>; body?: Record<string, unknown> },
): Promise<SlackCallResult<T>> {
  const transport = slackTransport(install);
  if (transport === "token") {
    const token = await getSecret(install.secret_ref);
    if (!token) return { ok: false, error: "no_bot_token" };
    const url = new URL(`https://slack.com/api/${req.api}`);
    for (const [k, v] of Object.entries(req.query ?? {})) url.searchParams.set(k, v);
    const res = await slackDeps.fetch(url.toString(), {
      method: req.method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(req.method === "POST" ? { "Content-Type": "application/json; charset=utf-8" } : {}),
      },
      ...(req.method === "POST" ? { body: JSON.stringify(req.body ?? {}) } : {}),
    });
    const json = (await res.json().catch(() => ({}))) as T;
    return json.ok ? { ok: true, data: json } : { ok: false, error: json.error ?? `http_${res.status}` };
  }

  if (transport === "nango") {
    const connectionId = typeof install.config.nango_connection_id === "string" ? install.config.nango_connection_id : null;
    if (!connectionId) return { ok: false, error: "not_connected" };
    const res = await slackDeps.nango().proxy<T>({
      method: req.method,
      providerConfigKey: installIntegrationKey(install.config, install.connector_id),
      connectionId,
      path: `/${req.api}`,
      ...(req.query ? { query: req.query } : {}),
      ...(req.method === "POST" ? { body: req.body ?? {} } : {}),
      retries: 1,
    });
    if (res.ok && res.data?.ok) return { ok: true, data: res.data };
    return { ok: false, error: res.data?.error ?? `http_${res.status}` };
  }

  return { ok: false, error: "unsupported" };
}
