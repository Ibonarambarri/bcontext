/**
 * Ashby — `ashby` → Nango `ashby` (BASIC: API key as username, empty
 * password; proxy base https://api.ashbyhq.com). The API is RPC-style:
 * every call is a POST with a JSON body, envelope `{ success, results,
 * moreDataAvailable, nextCursor }`.
 *
 * Hiring is read at the job level only: jobs updated since the cursor
 * (status, department, location, employment type) plus, per job, how the
 * applications created since spread across stages and statuses. No
 * candidate names, emails or notes ever enter a signal.
 *
 * Assumptions (docs, not exercised live): `job.list` returns `updatedAt`
 * ISO strings; `application.list` accepts `createdAfter` (epoch ms) and
 * cursor paging; `jobPosting.list` is the public listing with `externalLink`.
 */
import type { IngestSignal } from "@/lib/ingest/batch-extract";
import { allowList, type NangoAdapter } from "./shared";

interface AshbyEnvelope<T> {
  success?: boolean;
  results?: T[];
  moreDataAvailable?: boolean;
  nextCursor?: string;
  errors?: string[];
}

interface AshbyJob {
  id: string;
  title?: string;
  status?: string;
  updatedAt?: string;
  openedAt?: string | null;
  closedAt?: string | null;
  employmentType?: string;
  departmentId?: string;
  locationId?: string;
  department?: { name?: string } | null;
  location?: { name?: string } | null;
  hiringTeam?: Array<{ role?: string; firstName?: string; lastName?: string }>;
}

interface AshbyApplication {
  id: string;
  createdAt?: string;
  updatedAt?: string;
  status?: string;
  archiveReason?: { text?: string } | null;
  currentInterviewStage?: { title?: string } | null;
  source?: { title?: string } | null;
  job?: { id: string; title?: string } | null;
}

interface AshbyPosting {
  id: string;
  jobId?: string;
  externalLink?: string;
}

interface JobSummary {
  jobId: string;
  title: string;
  applications: number;
  stages: Record<string, number>;
  statuses: Record<string, number>;
  archiveReasons: Record<string, number>;
  sources: Record<string, number>;
  latest: number;
}

const JOB_STATUSES = ["Open", "Closed", "Draft", "Archived"];

function counts(map: Record<string, number>): string {
  return Object.entries(map)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${k} ${n}`)
    .join(", ");
}

function ms(iso: string | null | undefined): number {
  const t = iso ? new Date(iso).getTime() : Number.NaN;
  return Number.isNaN(t) ? 0 : t;
}

async function rpcAll<T>(
  call: (cursor: string | undefined) => Promise<AshbyEnvelope<T> | null>,
  maxPages: number,
): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < maxPages; i += 1) {
    const res = await call(cursor);
    if (!res) break;
    out.push(...(res.results ?? []));
    if (!res.moreDataAvailable || !res.nextCursor) break;
    cursor = res.nextCursor;
  }
  return out;
}

export const ashbyAdapter: NangoAdapter = {
  id: "ashby",
  provider: "ashby",
  sourceHint: "ashby:hiring",
  async fetchChanges({ client, connectionId, config, since, limit }) {
    const allow = allowList(config, "jobs");
    const statuses = allowList(config, "job_statuses") ?? JOB_STATUSES.slice(0, 2);
    const stats: Record<string, number> = { jobs: 0, applications: 0 };
    const sinceMs = since.getTime();

    const jobs = await rpcAll<AshbyJob>(async (cursor) => {
      const res = await client.proxy<AshbyEnvelope<AshbyJob>>({
        method: "POST",
        providerConfigKey: "ashby",
        connectionId,
        path: "/job.list",
        body: { status: statuses, ...(cursor ? { cursor } : {}) },
      });
      if (!res.ok) throw new Error(`ashby job.list failed (${res.status})`);
      return res.data ?? null;
    }, 3);
    const jobById = new Map(jobs.map((j) => [j.id, j]));
    const changedJobs = jobs.filter((j) => ms(j.updatedAt) > sinceMs);
    stats.jobs = changedJobs.length;

    const applications = await rpcAll<AshbyApplication>(async (cursor) => {
      const res = await client.proxy<AshbyEnvelope<AshbyApplication>>({
        method: "POST",
        providerConfigKey: "ashby",
        connectionId,
        path: "/application.list",
        body: { createdAfter: sinceMs, ...(cursor ? { cursor } : {}) },
      });
      if (!res.ok) throw new Error(`ashby application.list failed (${res.status})`);
      return res.data ?? null;
    }, 5);
    stats.applications = applications.length;

    const postings = await rpcAll<AshbyPosting>(async (cursor) => {
      const res = await client.proxy<AshbyEnvelope<AshbyPosting>>({
        method: "POST",
        providerConfigKey: "ashby",
        connectionId,
        path: "/jobPosting.list",
        body: { ...(cursor ? { cursor } : {}) },
      });
      return res.ok ? (res.data ?? null) : null;
    }, 2);
    const linkByJob = new Map<string, string>();
    for (const p of postings) if (p.jobId && p.externalLink && !linkByJob.has(p.jobId)) linkByJob.set(p.jobId, p.externalLink);

    const byJob = new Map<string, JobSummary>();
    const summary = (jobId: string, title?: string): JobSummary => {
      let s = byJob.get(jobId);
      if (!s) {
        s = { jobId, title: title ?? jobById.get(jobId)?.title ?? jobId, applications: 0, stages: {}, statuses: {}, archiveReasons: {}, sources: {}, latest: 0 };
        byJob.set(jobId, s);
      }
      return s;
    };
    for (const j of changedJobs) summary(j.id, j.title).latest = Math.max(summary(j.id).latest, ms(j.updatedAt));
    for (const a of applications) {
      const jobId = a.job?.id ?? "(no job)";
      const s = summary(jobId, a.job?.title);
      s.applications += 1;
      s.latest = Math.max(s.latest, ms(a.updatedAt) || ms(a.createdAt));
      const stage = a.currentInterviewStage?.title ?? "unknown";
      s.stages[stage] = (s.stages[stage] ?? 0) + 1;
      if (a.status) s.statuses[a.status] = (s.statuses[a.status] ?? 0) + 1;
      if (a.archiveReason?.text) s.archiveReasons[a.archiveReason.text] = (s.archiveReasons[a.archiveReason.text] ?? 0) + 1;
      if (a.source?.title) s.sources[a.source.title] = (s.sources[a.source.title] ?? 0) + 1;
    }

    const signals: IngestSignal[] = [];
    for (const s of [...byJob.values()].sort((a, b) => b.latest - a.latest)) {
      if (allow && !allow.includes(s.jobId) && !allow.includes(s.title)) continue;
      const j = jobById.get(s.jobId);
      const team = (j?.hiringTeam ?? [])
        .map((m) => `${[m.firstName, m.lastName].filter(Boolean).join(" ")}${m.role ? ` (${m.role})` : ""}`)
        .filter((x) => x.trim())
        .slice(0, 5)
        .join(", ");
      const lines = [
        `Job status: ${j?.status ?? "unknown"}${j?.department?.name ? ` · Department: ${j.department.name}` : ""}${j?.location?.name ? ` · Location: ${j.location.name}` : ""}${j?.employmentType ? ` · ${j.employmentType}` : ""}`,
        team ? `Hiring team: ${team}` : null,
        `Applications created in the period: ${s.applications}`,
        Object.keys(s.stages).length ? `By stage: ${counts(s.stages)}` : null,
        Object.keys(s.statuses).length ? `By status: ${counts(s.statuses)}` : null,
        Object.keys(s.archiveReasons).length ? `Archive reasons: ${counts(s.archiveReasons)}` : null,
        Object.keys(s.sources).length ? `Sources: ${counts(s.sources)}` : null,
      ].filter((l) => l !== null);
      signals.push({
        external_id: `job:${s.jobId}`,
        title: `Hiring · ${s.title}`,
        text: lines.join("\n"),
        url: linkByJob.get(s.jobId),
        at: s.latest ? new Date(s.latest).toISOString() : undefined,
        kind_hint: "hiring_pipeline",
      });
      if (signals.length >= limit) break;
    }
    return { signals, stats };
  },
};
