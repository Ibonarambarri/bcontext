/**
 * Lever — `lever` → Nango `lever` (OAuth2; proxy base https://api.lever.co).
 *
 * Hiring is read at the posting level only: postings updated since the
 * cursor (state, team, location, commitment) and, per posting, how the
 * opportunities updated since moved — counts per stage, archived reasons,
 * origins. Candidate names, emails, headlines and free text never enter a
 * signal; opportunity ids are used to count and are not emitted.
 *
 * Assumptions (docs, not exercised live): `updated_at_start` takes epoch
 * milliseconds; pagination is `hasNext` + `next` offset token; `expand=stage`
 * turns `stage` into `{ id, text }`; `expand=posting` is not needed because
 * `applications[]`/`postings[]` carry ids we join against the postings list.
 */
import type { IngestSignal } from "@/lib/ingest/batch-extract";
import { allowList, type NangoAdapter } from "./shared";

interface LeverPosting {
  id: string;
  text?: string;
  state?: string;
  updatedAt?: number;
  createdAt?: number;
  urls?: { show?: string; list?: string };
  categories?: { team?: string; department?: string; location?: string; commitment?: string; level?: string };
  hiringManager?: { name?: string } | string | null;
  owner?: { name?: string } | string | null;
}

interface LeverOpportunity {
  id: string;
  updatedAt?: number;
  createdAt?: number;
  archivedAt?: number | null;
  archived?: { archivedAt?: number; reason?: { text?: string } | string } | null;
  stage?: { id?: string; text?: string } | string | null;
  origin?: string;
  postings?: string[];
}

interface LeverPage<T> {
  data?: T[];
  hasNext?: boolean;
  next?: string;
}

interface PostingSummary {
  posting: LeverPosting | null;
  postingId: string;
  opportunities: number;
  stages: Record<string, number>;
  origins: Record<string, number>;
  archived: number;
  archivedReasons: Record<string, number>;
  latest: number;
}

function nameOf(v: { name?: string } | string | null | undefined): string {
  return typeof v === "string" ? "" : (v?.name ?? "");
}

function counts(map: Record<string, number>): string {
  return Object.entries(map)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${k} ${n}`)
    .join(", ");
}

function stageText(s: LeverOpportunity["stage"]): string {
  if (!s) return "unknown";
  return typeof s === "string" ? s : (s.text ?? s.id ?? "unknown");
}

function archivedReason(o: LeverOpportunity): string {
  const r = o.archived?.reason;
  if (!r) return "unspecified";
  return typeof r === "string" ? r : (r.text ?? "unspecified");
}

async function pageAll<T>(
  fetchPage: (offset: string | undefined) => Promise<LeverPage<T> | null>,
  maxPages: number,
): Promise<T[]> {
  const out: T[] = [];
  let offset: string | undefined;
  for (let i = 0; i < maxPages; i += 1) {
    const res = await fetchPage(offset);
    if (!res) break;
    out.push(...(res.data ?? []));
    if (!res.hasNext || !res.next) break;
    offset = res.next;
  }
  return out;
}

export const leverAdapter: NangoAdapter = {
  id: "lever",
  provider: "lever",
  sourceHint: "lever:hiring",
  async fetchChanges({ client, connectionId, config, since, limit }) {
    const allow = allowList(config, "postings");
    const sinceMs = since.getTime();
    const stats: Record<string, number> = { postings: 0, opportunities: 0 };

    const postings = await pageAll<LeverPosting>(async (offset) => {
      const res = await client.proxy<LeverPage<LeverPosting>>({
        method: "GET",
        providerConfigKey: "lever",
        connectionId,
        path: "/v1/postings",
        query: { updated_at_start: sinceMs, limit: 100, ...(offset ? { offset } : {}) },
      });
      if (!res.ok) throw new Error(`lever postings failed (${res.status})`);
      return res.data ?? null;
    }, 3);
    stats.postings = postings.length;

    const opportunities = await pageAll<LeverOpportunity>(async (offset) => {
      const res = await client.proxy<LeverPage<LeverOpportunity>>({
        method: "GET",
        providerConfigKey: "lever",
        connectionId,
        path: "/v1/opportunities",
        query: { updated_at_start: sinceMs, limit: 100, expand: "stage", ...(offset ? { offset } : {}) },
      });
      if (!res.ok) throw new Error(`lever opportunities failed (${res.status})`);
      return res.data ?? null;
    }, 5);
    stats.opportunities = opportunities.length;

    const byPosting = new Map<string, PostingSummary>();
    const summary = (postingId: string): PostingSummary => {
      let s = byPosting.get(postingId);
      if (!s) {
        s = {
          posting: postings.find((p) => p.id === postingId) ?? null,
          postingId,
          opportunities: 0,
          stages: {},
          origins: {},
          archived: 0,
          archivedReasons: {},
          latest: 0,
        };
        byPosting.set(postingId, s);
      }
      return s;
    };
    for (const p of postings) summary(p.id).latest = Math.max(summary(p.id).latest, p.updatedAt ?? 0);
    for (const o of opportunities) {
      const ids = o.postings?.length ? o.postings : ["(no posting)"];
      for (const pid of ids) {
        const s = summary(pid);
        s.opportunities += 1;
        s.latest = Math.max(s.latest, o.updatedAt ?? 0);
        if (o.origin) s.origins[o.origin] = (s.origins[o.origin] ?? 0) + 1;
        if (o.archivedAt || o.archived?.archivedAt) {
          s.archived += 1;
          const reason = archivedReason(o);
          s.archivedReasons[reason] = (s.archivedReasons[reason] ?? 0) + 1;
        } else {
          const stage = stageText(o.stage);
          s.stages[stage] = (s.stages[stage] ?? 0) + 1;
        }
      }
    }

    const signals: IngestSignal[] = [];
    for (const s of [...byPosting.values()].sort((a, b) => b.latest - a.latest)) {
      const p = s.posting;
      const name = p?.text ?? s.postingId;
      if (allow && !allow.includes(s.postingId) && !allow.includes(name)) continue;
      const cats = p?.categories;
      const lines = [
        `Posting state: ${p?.state ?? "unknown"}${cats?.team ? ` · Team: ${cats.team}` : ""}${cats?.location ? ` · Location: ${cats.location}` : ""}${cats?.commitment ? ` · ${cats.commitment}` : ""}`,
        nameOf(p?.hiringManager) ? `Hiring manager: ${nameOf(p?.hiringManager)}` : null,
        `Opportunities updated in the period: ${s.opportunities}`,
        Object.keys(s.stages).length ? `Active by stage: ${counts(s.stages)}` : null,
        s.archived ? `Archived: ${s.archived} (${counts(s.archivedReasons)})` : null,
        Object.keys(s.origins).length ? `Origins: ${counts(s.origins)}` : null,
      ].filter((l) => l !== null);
      signals.push({
        external_id: `posting:${s.postingId}`,
        title: `Hiring · ${name}`,
        text: lines.join("\n"),
        url: p?.urls?.show ?? p?.urls?.list,
        author: nameOf(p?.owner) || undefined,
        at: s.latest ? new Date(s.latest).toISOString() : undefined,
        kind_hint: "hiring_pipeline",
      });
      if (signals.length >= limit) break;
    }
    return { signals, stats };
  },
};
