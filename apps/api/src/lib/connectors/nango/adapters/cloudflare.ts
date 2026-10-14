/**
 * Cloudflare — `cloudflare` → Nango `cloudflare` (API_KEY: API token; proxy
 * base https://api.cloudflare.com/client, so paths start at /v4).
 *
 * Cloudflare resources carry no "updated since" filter, so the source of
 * change is the account audit log: `GET /v4/accounts/{id}/audit_logs?since`
 * (paged, newest first). Entries are grouped per actor + action type into
 * one signal each — "ana@acme.com changed 7 DNS records" — with the old →
 * new values clipped. Read-only actions (login, logout, read, list) are
 * skipped. `config.account_id` picks the account, otherwise the first one
 * the token lists; `GET /v4/zones` resolves zone ids to names (tolerated to
 * fail).
 */
import type { IngestSignal } from "@/lib/ingest/batch-extract";
import { clip, configString, str, type FetchChangesResult, type NangoAdapter } from "./shared";

interface CfAuditEntry {
  id: string;
  action?: { type?: string; result?: boolean };
  actor?: { email?: string; type?: string; ip?: string; id?: string };
  resource?: { type?: string; id?: string };
  interface?: string;
  metadata?: Record<string, unknown>;
  newValue?: string;
  oldValue?: string;
  when?: string;
}

const SKIP_ACTIONS = new Set(["login", "logout", "read", "list", "get"]);
const PAGES = 3;
const ENTRIES_PER_GROUP = 20;

export function isNoisyAction(type: string | undefined): boolean {
  const t = (type ?? "").toLowerCase();
  return !t || SKIP_ACTIONS.has(t) || t.endsWith("_read") || t.endsWith("_list") || t.startsWith("login");
}

export const cloudflareAdapter: NangoAdapter = {
  id: "cloudflare",
  provider: "cloudflare",
  sourceHint: "cloudflare:audit-logs",
  async fetchChanges({ client, connectionId, config, since, limit }) {
    let accountId = configString(config, "account_id");
    if (!accountId) {
      const accounts = await client.proxy<{ result?: Array<{ id?: string; name?: string }> }>({
        method: "GET",
        providerConfigKey: "cloudflare",
        connectionId,
        path: "/v4/accounts",
        query: { per_page: 5 },
      });
      if (!accounts.ok) throw new Error(`cloudflare accounts failed (${accounts.status})`);
      accountId = accounts.data?.result?.[0]?.id ?? null;
      if (!accountId) {
        const empty: FetchChangesResult = { signals: [], stats: { accounts: 0, scanned: 0, skipped: 0, groups: 0, pages: 0 } };
        return empty;
      }
    }

    const zones = new Map<string, string>();
    const z = await client.proxy<{ result?: Array<{ id?: string; name?: string }> }>({
      method: "GET",
      providerConfigKey: "cloudflare",
      connectionId,
      path: "/v4/zones",
      query: { per_page: 50, "account.id": accountId },
    });
    if (z.ok) for (const zone of z.data?.result ?? []) if (zone.id && zone.name) zones.set(zone.id, zone.name);

    const groups = new Map<string, CfAuditEntry[]>();
    let pages = 0;
    let scanned = 0;
    let skipped = 0;
    for (let page = 1; page <= PAGES; page += 1) {
      const res = await client.proxy<{ result?: CfAuditEntry[] }>({
        method: "GET",
        providerConfigKey: "cloudflare",
        connectionId,
        path: `/v4/accounts/${encodeURIComponent(accountId)}/audit_logs`,
        query: { since: since.toISOString(), per_page: 100, page, direction: "desc" },
      });
      if (!res.ok) throw new Error(`cloudflare audit logs failed (${res.status})`);
      pages += 1;
      const rows = res.data?.result ?? [];
      scanned += rows.length;
      for (const e of rows) {
        if (e.when && new Date(e.when) <= since) continue;
        if (isNoisyAction(e.action?.type)) {
          skipped += 1;
          continue;
        }
        const key = `${e.actor?.email ?? e.actor?.id ?? "system"}|${e.action?.type ?? "?"}`;
        const list = groups.get(key) ?? [];
        list.push(e);
        groups.set(key, list);
      }
      if (rows.length < 100) break;
    }

    const signals: IngestSignal[] = [];
    for (const [key, list] of groups) {
      const [actor, action] = key.split("|");
      list.sort((a, b) => str(b.when).localeCompare(str(a.when)));
      const latest = list[0]!;
      const lines = list.slice(0, ENTRIES_PER_GROUP).map((e) => {
        const zone = e.resource?.id ? zones.get(e.resource.id) : undefined;
        const target = `${e.resource?.type ?? "resource"}${zone ? ` ${zone}` : e.resource?.id ? ` ${e.resource.id}` : ""}`;
        const diff = e.oldValue || e.newValue ? ` · ${clip(e.oldValue ?? "∅", 200)} → ${clip(e.newValue ?? "∅", 200)}` : "";
        return `- ${e.when ?? ""} · ${target}${e.action?.result === false ? " · FAILED" : ""}${e.interface ? ` · via ${e.interface}` : ""}${diff}`;
      });
      signals.push({
        external_id: `audit:${actor}:${action}:${latest.id}`,
        title: `${actor} · ${action} × ${list.length}`,
        text: [`Account: ${accountId} · Action: ${action} · Actor: ${actor}`, "", ...lines].join("\n"),
        url: `https://dash.cloudflare.com/${accountId}/audit-log`,
        author: actor,
        at: latest.when,
        kind_hint: "audit",
      });
      if (signals.length >= limit) break;
    }
    return { signals: signals.slice(0, limit), stats: { accounts: 1, scanned, skipped, groups: groups.size, pages } };
  },
};
