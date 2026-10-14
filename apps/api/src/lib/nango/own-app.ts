/**
 * A workspace's OWN OAuth app for a Nango-backed provider (hybrid model).
 *
 * Nango keeps OAuth client credentials per *integration*, not per end user,
 * so "connect with your organisation's app" means one extra integration in
 * Nango per (workspace, provider): `unique_key = <key>--<workspace id
 * without dashes>`, same `provider` as the shared one. The client secret is
 * sent to Nango once and never stored, logged or read back here.
 *
 * Which key an install uses lives in `config.nango_integration_key`
 * (missing → the shared `<key>`), and `config.oauth_app` says why
 * (`"shared" | "own"`). Adapters keep addressing the shared key; the generic
 * connector rewrites it with `withIntegrationKey` before handing them the
 * client.
 */
import type { NangoClient, NangoNewIntegrationCredentials, ProxyRequest, ProxyResponse } from "./client";
import { NangoError } from "./client";
import { nangoCredentialTypeFor, oauthAuthModeFor, scopesForNango } from "./scopes";

export type OAuthAppKind = "shared" | "own";

const OWN_KEY_SEPARATOR = "--";

/** `<key>--<workspace uuid without dashes>` — ≤ 100 chars for every catalog key. */
export function ownIntegrationKey(connectorKey: string, workspaceId: string): string {
  return `${connectorKey}${OWN_KEY_SEPARATOR}${workspaceId.replace(/-/g, "")}`;
}

/**
 * Split a Nango `providerConfigKey` back into the connector key and the
 * dash-less workspace id (null for a shared key).
 */
export function splitIntegrationKey(providerConfigKey: string): { connectorKey: string; workspaceHex: string | null } {
  const idx = providerConfigKey.lastIndexOf(OWN_KEY_SEPARATOR);
  if (idx <= 0) return { connectorKey: providerConfigKey, workspaceHex: null };
  const tail = providerConfigKey.slice(idx + OWN_KEY_SEPARATOR.length);
  if (!/^[0-9a-f]{32}$/i.test(tail)) return { connectorKey: providerConfigKey, workspaceHex: null };
  return { connectorKey: providerConfigKey.slice(0, idx), workspaceHex: tail.toLowerCase() };
}

export function workspaceMatchesHex(workspaceId: string, hex: string | null): boolean {
  if (!hex) return true;
  return workspaceId.replace(/-/g, "").toLowerCase() === hex;
}

/** The Nango integration an install talks to; older installs carry no key → shared. */
export function installIntegrationKey(config: Record<string, unknown>, connectorKey: string): string {
  const key = config.nango_integration_key;
  return typeof key === "string" && key.length > 0 ? key : connectorKey;
}

export function installOAuthAppKind(config: Record<string, unknown>): OAuthAppKind {
  return config.oauth_app === "own" ? "own" : "shared";
}

export interface OwnOAuthAppInput {
  connectorKey: string;
  nangoProvider: string;
  displayName: string;
  workspaceId: string;
  clientId: string;
  clientSecret: string;
  scopes?: string[] | null;
}

/**
 * Create the workspace's own integration in Nango, or replace its
 * credentials when it already exists. Returns the unique_key used.
 */
export async function upsertOwnOAuthApp(client: NangoClient, input: OwnOAuthAppInput): Promise<string> {
  const uniqueKey = ownIntegrationKey(input.connectorKey, input.workspaceId);
  const credentials: NangoNewIntegrationCredentials = {
    type: nangoCredentialTypeFor(oauthAuthModeFor(input.nangoProvider)),
    client_id: input.clientId,
    client_secret: input.clientSecret,
    ...(scopesForNango(input.nangoProvider, input.scopes) ? { scopes: scopesForNango(input.nangoProvider, input.scopes) } : {}),
  };
  const existing = await client.getIntegration(uniqueKey);
  if (existing) {
    await client.updateIntegration(uniqueKey, { credentials });
    return uniqueKey;
  }
  try {
    await client.createIntegration({
      uniqueKey,
      provider: input.nangoProvider,
      displayName: `${input.displayName} (own app)`,
      credentials,
    });
  } catch (err) {
    // Lost the race with a concurrent create: fall back to replacing.
    if (err instanceof NangoError && err.status === 409) {
      await client.updateIntegration(uniqueKey, { credentials });
      return uniqueKey;
    }
    throw err;
  }
  return uniqueKey;
}

/** Best-effort removal of the workspace's own integration (and its connections on Nango's side). */
export async function deleteOwnOAuthApp(client: NangoClient, connectorKey: string, workspaceId: string): Promise<boolean> {
  return client.deleteIntegration(ownIntegrationKey(connectorKey, workspaceId));
}

/**
 * A client whose proxy/connection calls always use `integrationKey`,
 * whatever `providerConfigKey` the adapter hard-codes. Everything else is
 * delegated untouched.
 */
export function withIntegrationKey(client: NangoClient, integrationKey: string): NangoClient {
  const wrapped = Object.create(client) as NangoClient;
  Object.defineProperty(wrapped, "proxy", {
    value: <T = unknown>(req: ProxyRequest): Promise<ProxyResponse<T>> =>
      client.proxy<T>({ ...req, providerConfigKey: integrationKey }),
  });
  Object.defineProperty(wrapped, "getConnection", {
    value: (connectionId: string) => client.getConnection(connectionId, integrationKey),
  });
  Object.defineProperty(wrapped, "deleteConnection", {
    value: (connectionId: string) => client.deleteConnection(connectionId, integrationKey),
  });
  return wrapped;
}
