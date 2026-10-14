/**
 * Workable — `workable` → Nango `workable` (API_KEY bearer token; proxy
 * base https://<subdomain>.workable.com).
 *
 * Jobs updated since the cursor and, per job, how candidates moved:
 * counts per stage plus disqualifications and their reasons. No candidate
 * name, email or note is read into a signal — the SPI is queried with the
 * job/stage fields only and everything is aggregated.
 *
 * Assumptions (docs, not exercised live): `/spi/v3/jobs` and
 * `/spi/v3/candidates` accept `updated_after` (ISO-8601) and `limit`, and
 * page with `paging.next` (a URL whose `since_id` we forward; no `next`
 * means the last page).
 */
import type { IngestSignal } from "@/lib/ingest/batch-extract";
import { allowList, subdomain, type NangoAdapter } from "./shared";

interface WorkableJob {
  id?: string;
  shortcode: string;
  title?: string;
  state?: string;
  department?: string;
  code?: string;
  created_at?: string;
  url?: string;
  location?: { city?: string; country?: string; workplace_type?: string };
}

interface WorkableCandidate {
  id: string;
  stage?: string;
  disqualified?: boolean;
  disqualification_reason?: string | null;
  updated_at?: string;
  created_at?: string;
  job?: { shortcode?: string; title?: string };
}

interface Paged<T> {
  jobs?: T[];
  candidates?: T[];
  paging?: { next?: string };
}

export function workableSinceId(next: string | undefined): string | null {
  if (!next) return null;
  const m = /[?&]since_id=([^&]+)/.exec(next);
  return m?.[1] ? decodeURIComponent(m[1]) : null;
}

interface JobPipeline {
  shortcode: string;
  title: string;
  moved: number;
  stages: Record<string, number>;
  disqualified: number;
  reasons: Record<string, number>;
  latest: string;
}

function bump(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1;
}

function counts(map: Record<string, number>): string {
  const entries = Object.entries(map).sort((a, b) => b[1] - a[1]);
  return entries.length ? entries.map(([k, v]) => `${k} ${v}`).join(", ") : "none";
}

export const workableAdapter: NangoAdapter = {
  id: "workable",
  provider: "workable",
  sourceHint: "workable:hiring",
  async fetchChanges({ client, connectionId, connectionConfig, config, since, limit }) {
    const jobFilter = allowList(config, "jobs");
    const host = subdomain(connectionConfig);
    const iso = since.toISOString();
    const pageSize = 100;

    async function collect<T>(path: string, key: "jobs" | "candidates"): Promise<T[]> {
      const out: T[] = [];
      let sinceId: string | null = null;
      for (let page = 0; page < 5; page += 1) {
        const res = await client.proxy<Paged<T>>({
          method: "GET",
          providerConfigKey: "workable",
          connectionId,
          path,
          query: { updated_after: iso, limit: pageSize, ...(sinceId ? { since_id: sinceId } : {}) },
        });
        if (!res.ok) throw new Error(`workable ${key} failed (${res.status})`);
        const rows = res.data?.[key] ?? [];
        out.push(...rows);
        sinceId = workableSinceId(res.data?.paging?.next);
        if (!sinceId || rows.length === 0) break;
      }
      return out;
    }

    const jobs = await collect<WorkableJob>("/spi/v3/jobs", "jobs");
    const candidates = await collect<WorkableCandidate>("/spi/v3/candidates", "candidates");
    const allowed = (shortcode: string, title: string) =>
      !jobFilter || jobFilter.includes(shortcode) || jobFilter.includes(title);

    const signals: IngestSignal[] = [];
    for (const j of jobs) {
      const title = j.title ?? j.shortcode;
      if (!allowed(j.shortcode, title)) continue;
      const loc = [j.location?.city, j.location?.country].filter(Boolean).join(", ");
      signals.push({
        external_id: `job:${j.shortcode}`,
        title: `Job · ${title}`,
        text: [
          `State: ${j.state ?? "?"} · Department: ${j.department ?? "?"}${j.code ? ` · Code: ${j.code}` : ""}`,
          loc ? `Location: ${loc}${j.location?.workplace_type ? ` (${j.location.workplace_type})` : ""}` : null,
          j.created_at ? `Created: ${j.created_at}` : null,
        ]
          .filter((x) => x !== null)
          .join("\n"),
        url: j.url || (host ? `https://${host}.workable.com/jobs/${j.shortcode}` : undefined),
        at: j.created_at,
        kind_hint: "job",
      });
    }

    const pipelines = new Map<string, JobPipeline>();
    for (const c of candidates) {
      const shortcode = c.job?.shortcode;
      if (!shortcode) continue;
      const title = c.job?.title ?? shortcode;
      if (!allowed(shortcode, title)) continue;
      const p = pipelines.get(shortcode) ?? { shortcode, title, moved: 0, stages: {}, disqualified: 0, reasons: {}, latest: "" };
      p.moved += 1;
      if (c.disqualified) {
        p.disqualified += 1;
        bump(p.reasons, c.disqualification_reason || "unspecified");
      } else bump(p.stages, c.stage ?? "unknown stage");
      if (c.updated_at && c.updated_at > p.latest) p.latest = c.updated_at;
      pipelines.set(shortcode, p);
    }
    for (const p of pipelines.values()) {
      signals.push({
        external_id: `pipeline:${p.shortcode}`,
        title: `Hiring pipeline · ${p.title}`,
        text: [
          `Candidates with activity: ${p.moved} · disqualified ${p.disqualified}`,
          `Current stages: ${counts(p.stages)}`,
          p.disqualified ? `Disqualification reasons: ${counts(p.reasons)}` : null,
        ]
          .filter((x) => x !== null)
          .join("\n"),
        url: host ? `https://${host}.workable.com/backend/jobs/${p.shortcode}` : undefined,
        at: p.latest || undefined,
        kind_hint: "pipeline",
      });
    }

    return { signals: signals.slice(0, limit), stats: { jobs: jobs.length, candidates: candidates.length } };
  },
};
