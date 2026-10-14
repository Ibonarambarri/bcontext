/**
 * Sentry — `sentry` → Nango `sentry` (API_KEY: auth token;
 * connection_config.hostname, e.g. sentry.io; proxy base
 * https://<hostname>/api). Issues seen since the cursor in one
 * organization (`config.organization`, default: the first the token lists),
 * optionally only `config.projects` (project ids). Pagination follows the
 * `Link` header.
 */
import type { IngestSignal } from "@/lib/ingest/batch-extract";
import { allowList, clip, configString, type NangoAdapter } from "./shared";

interface SentryIssue {
  id: string;
  shortId?: string;
  title?: string;
  culprit?: string;
  level?: string;
  status?: string;
  count?: string;
  userCount?: number;
  firstSeen?: string;
  lastSeen?: string;
  permalink?: string;
  isRegression?: boolean;
  metadata?: { type?: string; value?: string };
  project?: { slug?: string; name?: string };
}

/** Sentry's search wants an ISO instant without milliseconds. */
export function sentrySince(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "");
}

/** `<url>; rel="next"; results="true"; cursor="…"` → the next cursor, or null. */
export function sentryNextCursor(link: string | null): string | null {
  if (!link) return null;
  for (const part of link.split(",")) {
    if (!/rel="next"/.test(part) || !/results="true"/.test(part)) continue;
    const m = part.match(/cursor="([^"]+)"/);
    if (m?.[1]) return m[1];
  }
  return null;
}

export const sentryAdapter: NangoAdapter = {
  id: "sentry",
  provider: "sentry",
  sourceHint: "sentry:issues",
  async fetchChanges({ client, connectionId, config, since, limit }) {
    let organization = configString(config, "organization");
    if (!organization) {
      const orgs = await client.proxy<Array<{ slug?: string }>>({
        method: "GET",
        providerConfigKey: "sentry",
        connectionId,
        path: "/0/organizations/",
      });
      if (!orgs.ok) throw new Error(`sentry organizations failed (${orgs.status})`);
      organization = (Array.isArray(orgs.data) ? orgs.data : [])[0]?.slug ?? null;
      if (!organization) return { signals: [], stats: { organizations: 0, pages: 0 } };
    }
    const projects = allowList(config, "projects");
    const signals: IngestSignal[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res = await client.proxy<SentryIssue[]>({
        method: "GET",
        providerConfigKey: "sentry",
        connectionId,
        path: `/0/organizations/${encodeURIComponent(organization)}/issues/`,
        query: {
          query: `lastSeen:>${sentrySince(since)}`,
          sort: "date",
          limit: Math.min(50, limit),
          ...(projects ? { project: projects.join(",") } : {}),
          ...(cursor ? { cursor } : {}),
        },
      });
      if (!res.ok) throw new Error(`sentry issues failed (${res.status})`);
      for (const is of Array.isArray(res.data) ? res.data : []) {
        signals.push({
          external_id: `issue:${is.id}`,
          title: `${is.shortId ?? is.id} · ${is.title ?? ""}`.trim(),
          text: [
            `Level: ${is.level ?? "?"} · Status: ${is.status ?? "?"}${is.isRegression ? " · REGRESSION" : ""}${is.project?.slug ? ` · Project: ${is.project.slug}` : ""}`,
            `Events: ${is.count ?? "?"} · Users: ${is.userCount ?? "?"} · First seen: ${is.firstSeen ?? "?"} · Last seen: ${is.lastSeen ?? "?"}`,
            is.culprit ? `Where: ${is.culprit}` : null,
            "",
            clip([is.metadata?.type, is.metadata?.value].filter(Boolean).join(": ")),
          ]
            .filter((x) => x !== null)
            .join("\n"),
          url: is.permalink,
          at: is.lastSeen,
          kind_hint: "error",
        });
        if (signals.length >= limit) break;
      }
      cursor = sentryNextCursor(res.headers.get("link"));
      pages += 1;
    } while (cursor && signals.length < limit && pages < 3);
    return { signals: signals.slice(0, limit), stats: { organizations: 1, pages } };
  },
};
