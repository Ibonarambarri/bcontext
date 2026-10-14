/**
 * Which Nango-backed catalog entries are usable *right now*.
 *
 * OAuth providers are registered in Nango with placeholder client
 * credentials (`NANGO_PLACEHOLDER_CREDENTIAL`) so the catalog, the Connect
 * flow and the adapters ship before the owner has created every OAuth app.
 * The marketplace shows those as "admin setup needed" until the real client
 * id/secret is pasted in the Nango dashboard. This module asks Nango once a
 * minute and answers per unique_key; when Nango is unreachable it answers
 * nothing, and the catalog simply omits `setup`.
 */
import type { IntegrationSetup } from "@bcontext-dev/contract/connectors/catalog";
import { log } from "@bcontext-dev/contract/log";
import { NANGO_PLACEHOLDER_CREDENTIAL, isNangoConfigured, nangoClient, type NangoClient } from "./client";

const SETUP_CACHE_TTL_MS = 60_000;

let cache: { at: number; byKey: Map<string, IntegrationSetup> } | null = null;

export function setupFromCredentials(clientId: string | null | undefined): IntegrationSetup {
  return clientId === NANGO_PLACEHOLDER_CREDENTIAL ? "needs_oauth_app" : "ready";
}

/**
 * unique_key → setup for every integration Nango knows. Empty map when Nango
 * is not configured or the call fails (never throws).
 */
export async function integrationSetupMap(
  deps: { client?: () => NangoClient; now?: () => number } = {},
): Promise<Map<string, IntegrationSetup>> {
  const now = deps.now ?? Date.now;
  if (cache && now() - cache.at < SETUP_CACHE_TTL_MS) return cache.byKey;
  if (!deps.client && !isNangoConfigured()) return new Map();
  try {
    const client = (deps.client ?? nangoClient)();
    const rows = await client.listIntegrationsWithCredentials();
    const byKey = new Map<string, IntegrationSetup>();
    for (const row of rows) {
      if (!row.uniqueKey) continue;
      byKey.set(row.uniqueKey, setupFromCredentials(row.credentials?.clientId));
    }
    cache = { at: now(), byKey };
    return byKey;
  } catch (err) {
    log.warn("nango.setup.unavailable", { error: err instanceof Error ? err.message : String(err) });
    return new Map();
  }
}

/** Test helper. */
export function _resetSetupCache(): void {
  cache = null;
}
