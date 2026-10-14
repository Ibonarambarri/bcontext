/**
 * Okta (directory) — `okta` → Nango `okta-api-key` (API_KEY: an SSWS API
 * token minted by a read-only administrator; proxy base
 * https://<connection_config.hostname>).
 *
 * Why the API token and not `okta`'s OAuth2: an Okta org is its own
 * authorization server, so there is no OAuth app of ours a customer could
 * authorise — every org would have to register one. A token from a
 * read-only admin is the one-step path and reads nothing it should not.
 *
 * The source of change is the System Log:
 *
 *   GET /api/v1/logs?since=<cursor>&sortOrder=ASCENDING&limit=500
 *       &filter=eventType sw "user.lifecycle." or eventType sw "group.user_membership." or …
 *       (paged through the `Link: <…after=…>; rel="next"` header, ≤5 pages)
 *
 * Signals are aggregates per UTC day, three families:
 *   users:<day>  joiners / leavers / suspensions as counts — a user is never named
 *   groups:<day> per group: members added / removed, groups created / deleted
 *   apps:<day>   per application: users assigned / unassigned, groups
 *                assigned, apps created / activated / deactivated
 * Group and application names are the vocabulary; the only person in a
 * signal is the actor (display name or login) who made the change. Failed
 * events (`outcome.result !== "SUCCESS"`) are skipped.
 *
 * Install config: none. Assumptions (docs, not exercised live): the log
 * filter accepts `sw` on `eventType` joined with `or`; `Link` pagination
 * carries the `after` cursor; the admin console lives at
 * `<subdomain>-admin.okta.com`.
 */
import type { IngestSignal } from "@/lib/ingest/batch-extract";
import { hostname, str, subdomain, type NangoAdapter } from "./shared";

interface OktaPrincipal {
  id?: string;
  type?: string;
  alternateId?: string;
  displayName?: string;
}

interface OktaLogEvent {
  uuid?: string;
  published?: string;
  eventType?: string;
  displayMessage?: string;
  outcome?: { result?: string; reason?: string };
  actor?: OktaPrincipal;
  target?: OktaPrincipal[];
}

const PAGES = 5;
const PAGE_SIZE = 500;

export const OKTA_EVENT_PREFIXES = [
  "user.lifecycle.",
  "group.user_membership.",
  "group.lifecycle.",
  "application.user_membership.",
  "application.lifecycle.",
  "group.application_assignment.",
];

export function oktaLogFilter(): string {
  return OKTA_EVENT_PREFIXES.map((p) => `eventType sw "${p}"`).join(" or ");
}

/** `<https://acme.okta.com/api/v1/logs?after=abc&limit=500>; rel="next"` → `abc` (or null). */
export function oktaNextAfter(link: string | null): string | null {
  if (!link) return null;
  for (const part of link.split(",")) {
    if (!/rel="next"/.test(part)) continue;
    const url = part.match(/<([^>]+)>/)?.[1];
    if (!url) continue;
    try {
      return new URL(url).searchParams.get("after");
    } catch {
      return null;
    }
  }
  return null;
}

export function oktaHost(connectionConfig: Record<string, unknown>): string {
  const host = hostname(connectionConfig).replace(/^https?:\/\//, "").replace(/\/+$/, "");
  if (host) return host;
  const sub = subdomain(connectionConfig);
  return sub ? `${sub}.okta.com` : "";
}

/** The admin console's System Log, for provenance links. */
export function oktaAdminLogUrl(host: string): string {
  if (!host) return "https://login.okta.com/";
  const m = host.match(/^([a-z0-9_-]+)\.(okta\.com|oktapreview\.com|okta-emea\.com)$/i);
  return m ? `https://${m[1]}-admin.${m[2]}/report/system_log` : `https://${host}/report/system_log`;
}

export function oktaFamily(eventType: string): "users" | "groups" | "apps" | null {
  if (eventType.startsWith("user.lifecycle.")) return "users";
  if (eventType.startsWith("group.user_membership.") || eventType.startsWith("group.lifecycle.")) return "groups";
  if (eventType.startsWith("application.") || eventType.startsWith("group.application_assignment.")) return "apps";
  return null;
}

function actorLabel(a?: OktaPrincipal): string {
  return a?.displayName || a?.alternateId || a?.type || "system";
}

function targetOf(e: OktaLogEvent, type: string): OktaPrincipal | undefined {
  return e.target?.find((t) => t.type === type);
}

function nameOf(p: OktaPrincipal | undefined, fallback: string): string {
  return p?.displayName || p?.alternateId || p?.id || fallback;
}

interface Tally {
  counts: Map<string, number>;
  actors: Map<string, number>;
  events: number;
  last: string;
}

function tally(): Tally {
  return { counts: new Map(), actors: new Map(), events: 0, last: "" };
}

function bump(t: Tally, key: string, e: OktaLogEvent): void {
  t.counts.set(key, (t.counts.get(key) ?? 0) + 1);
  const actor = actorLabel(e.actor);
  t.actors.set(actor, (t.actors.get(actor) ?? 0) + 1);
  t.events += 1;
  if (str(e.published) > t.last) t.last = str(e.published);
}

/** What one event contributes to its family's tally — the line key, or null to ignore it. */
export function oktaLineKey(e: OktaLogEvent): string | null {
  const type = str(e.eventType);
  const family = oktaFamily(type);
  if (!family) return null;
  if (family === "users") {
    return type.replace("user.lifecycle.", "").replace(/\./g, " ");
  }
  if (family === "groups") {
    const group = nameOf(targetOf(e, "UserGroup"), "group");
    if (type === "group.user_membership.add") return `${group}: member added`;
    if (type === "group.user_membership.remove") return `${group}: member removed`;
    return `${group}: ${type.replace("group.lifecycle.", "")}`;
  }
  const app = nameOf(targetOf(e, "AppInstance"), "application");
  if (type === "application.user_membership.add") return `${app}: user assigned`;
  if (type === "application.user_membership.remove") return `${app}: user unassigned`;
  if (type.startsWith("group.application_assignment.")) {
    const group = nameOf(targetOf(e, "UserGroup"), "group");
    return `${app}: group ${group} ${type.replace("group.application_assignment.", "").replace(/\./g, " ")}`;
  }
  return `${app}: ${type.replace("application.lifecycle.", "").replace(/\./g, " ")}`;
}

const FAMILY_TITLE = { users: "Directory: joiners and leavers", groups: "Directory: group membership", apps: "Directory: app assignments" } as const;

export const oktaAdapter: NangoAdapter = {
  id: "okta",
  provider: "okta-api-key",
  sourceHint: "okta:directory",
  async fetchChanges({ client, connectionId, connectionConfig, since, limit }) {
    const host = oktaHost(connectionConfig);
    const url = oktaAdminLogUrl(host);
    const stats: Record<string, number> = { scanned: 0, skipped: 0, pages: 0 };

    const groups = new Map<string, Tally>();
    let after: string | null = null;
    for (let page = 0; page < PAGES; page += 1) {
      const res = await client.proxy<OktaLogEvent[]>({
        method: "GET",
        providerConfigKey: "okta",
        connectionId,
        path: "/api/v1/logs",
        query: {
          since: since.toISOString(),
          sortOrder: "ASCENDING",
          limit: PAGE_SIZE,
          filter: oktaLogFilter(),
          ...(after ? { after } : {}),
        },
      });
      if (!res.ok) throw new Error(`okta logs failed (${res.status})`);
      stats.pages = (stats.pages ?? 0) + 1;
      const rows = Array.isArray(res.data) ? res.data : [];
      for (const e of rows) {
        stats.scanned = (stats.scanned ?? 0) + 1;
        if (!e.published || new Date(e.published) <= since) continue;
        if ((e.outcome?.result ?? "SUCCESS") !== "SUCCESS") {
          stats.skipped = (stats.skipped ?? 0) + 1;
          continue;
        }
        const family = oktaFamily(str(e.eventType));
        const key = oktaLineKey(e);
        if (!family || !key) {
          stats.skipped = (stats.skipped ?? 0) + 1;
          continue;
        }
        const day = e.published.slice(0, 10);
        const id = `${family}:${day}`;
        const t = groups.get(id) ?? tally();
        bump(t, key, e);
        groups.set(id, t);
      }
      if (rows.length < PAGE_SIZE) break;
      after = oktaNextAfter(res.headers.get("link"));
      if (!after) break;
    }

    const signals: IngestSignal[] = [];
    for (const [id, t] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      if (signals.length >= limit) break;
      const [family, day] = id.split(":") as ["users" | "groups" | "apps", string];
      const lines = [...t.counts.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `- ${k} ×${n}`);
      const actors = [...t.actors.entries()].sort((a, b) => b[1] - a[1]);
      signals.push({
        external_id: id,
        title: `${FAMILY_TITLE[family]} · ${day} · ${t.events} change${t.events === 1 ? "" : "s"}`,
        text: [`Org: ${host || "okta"} · Day: ${day} · Actors: ${actors.map(([a, n]) => `${a} (${n})`).join(", ")}`, "", ...lines].join("\n"),
        url,
        author: actors[0]?.[0],
        at: t.last || `${day}T00:00:00.000Z`,
        kind_hint: "directory_change",
      });
    }
    return { signals: signals.slice(0, limit), stats: { ...stats, groups: groups.size } };
  },
};
