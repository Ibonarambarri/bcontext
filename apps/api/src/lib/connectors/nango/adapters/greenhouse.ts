/**
 * Greenhouse — `greenhouse` → Nango `greenhouse-harvest` (BASIC: the
 * Harvest API key as username, empty password; proxy base
 * https://harvest.greenhouse.io).
 *
 * Hiring is read at the job level only: jobs updated since the cursor
 * (status, department, office, openings) and, per job, how many
 * applications moved through which stage, were hired or rejected, and the
 * spread of scorecard recommendations. Candidate names, emails and free
 * text never enter a signal — only ids are used to join applications to
 * jobs, and they are not emitted either.
 *
 * Assumptions (docs, not exercised live): `updated_after` /
 * `last_activity_after` take ISO-8601; `per_page` ≤ 500; pagination is by
 * `page` (the Link header is not read through the proxy).
 */
import type { IngestSignal } from "@/lib/ingest/batch-extract";
import { allowList, type NangoAdapter } from "./shared";

interface GreenhouseJob {
  id: number;
  name?: string;
  status?: string;
  updated_at?: string;
  opened_at?: string | null;
  closed_at?: string | null;
  departments?: Array<{ name?: string }>;
  offices?: Array<{ name?: string }>;
  openings?: Array<{ status?: string }>;
  hiring_team?: { hiring_managers?: Array<{ name?: string }>; recruiters?: Array<{ name?: string }> };
}

interface GreenhouseApplication {
  id: number;
  candidate_id?: number;
  status?: string;
  last_activity_at?: string;
  applied_at?: string;
  current_stage?: { name?: string } | null;
  jobs?: Array<{ id: number; name?: string }>;
  rejection_reason?: { name?: string } | null;
}

interface GreenhouseScorecard {
  id: number;
  application_id?: number;
  overall_recommendation?: string;
  updated_at?: string;
}

interface PipelineSummary {
  jobId: number;
  jobName: string;
  applications: number;
  stages: Record<string, number>;
  hired: number;
  rejected: number;
  rejectionReasons: Record<string, number>;
  recommendations: Record<string, number>;
  latest: string;
}

function bump(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1;
}

function counts(map: Record<string, number>): string {
  const entries = Object.entries(map).sort((a, b) => b[1] - a[1]);
  return entries.length ? entries.map(([k, v]) => `${k} ${v}`).join(", ") : "none";
}

export function greenhousePipelineText(p: PipelineSummary): string {
  return [
    `Applications with activity: ${p.applications} · hired ${p.hired} · rejected ${p.rejected}`,
    `Current stages: ${counts(p.stages)}`,
    p.rejected ? `Rejection reasons: ${counts(p.rejectionReasons)}` : null,
    Object.keys(p.recommendations).length ? `Scorecard recommendations: ${counts(p.recommendations)}` : null,
  ]
    .filter((x) => x !== null)
    .join("\n");
}

async function pages<T>(
  fetchPage: (page: number) => Promise<{ ok: boolean; status: number; data: T[] | unknown }>,
  what: string,
  perPage: number,
  maxPages = 5,
): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const res = await fetchPage(page);
    if (!res.ok) throw new Error(`greenhouse ${what} failed (${res.status})`);
    const rows = Array.isArray(res.data) ? (res.data as T[]) : [];
    out.push(...rows);
    if (rows.length < perPage) break;
  }
  return out;
}

export const greenhouseAdapter: NangoAdapter = {
  id: "greenhouse",
  provider: "greenhouse-harvest",
  sourceHint: "greenhouse:hiring",
  async fetchChanges({ client, connectionId, config, since, limit }) {
    const jobFilter = allowList(config, "jobs");
    const perPage = 100;
    const iso = since.toISOString();
    const get = <T>(path: string, query: Record<string, string | number>) =>
      client.proxy<T>({ method: "GET", providerConfigKey: "greenhouse", connectionId, path, query });

    const jobs = await pages<GreenhouseJob>(
      (page) => get("/v1/jobs", { updated_after: iso, per_page: perPage, page }),
      "jobs",
      perPage,
    );
    const applications = await pages<GreenhouseApplication>(
      (page) => get("/v1/applications", { last_activity_after: iso, per_page: perPage, page }),
      "applications",
      perPage,
    );
    const scorecards = await pages<GreenhouseScorecard>(
      (page) => get("/v1/scorecards", { updated_after: iso, per_page: perPage, page }),
      "scorecards",
      perPage,
      2,
    );

    const allowed = (jobId: number, jobName: string) =>
      !jobFilter || jobFilter.includes(String(jobId)) || jobFilter.includes(jobName);

    const signals: IngestSignal[] = [];
    const jobNames = new Map<number, string>();
    for (const j of jobs) {
      const name = j.name ?? `Job ${j.id}`;
      jobNames.set(j.id, name);
      if (!allowed(j.id, name)) continue;
      const openings = j.openings ?? [];
      signals.push({
        external_id: `job:${j.id}`,
        title: `Job · ${name}`,
        text: [
          `Status: ${j.status ?? "?"} · Openings: ${openings.filter((o) => o.status === "open").length} open of ${openings.length}`,
          `Department: ${(j.departments ?? []).map((d) => d.name).filter(Boolean).join(", ") || "?"} · Office: ${(j.offices ?? []).map((o) => o.name).filter(Boolean).join(", ") || "?"}`,
          j.opened_at ? `Opened: ${j.opened_at}` : null,
          j.closed_at ? `Closed: ${j.closed_at}` : null,
          j.hiring_team?.hiring_managers?.length
            ? `Hiring managers: ${j.hiring_team.hiring_managers.map((m) => m.name).filter(Boolean).join(", ")}`
            : null,
        ]
          .filter((x) => x !== null)
          .join("\n"),
        at: j.updated_at,
        kind_hint: "job",
      });
    }

    const appToJob = new Map<number, number>();
    const pipelines = new Map<number, PipelineSummary>();
    for (const a of applications) {
      const job = a.jobs?.[0];
      if (!job) continue;
      const jobName = job.name ?? jobNames.get(job.id) ?? `Job ${job.id}`;
      if (!allowed(job.id, jobName)) continue;
      appToJob.set(a.id, job.id);
      const p = pipelines.get(job.id) ?? {
        jobId: job.id,
        jobName,
        applications: 0,
        stages: {},
        hired: 0,
        rejected: 0,
        rejectionReasons: {},
        recommendations: {},
        latest: "",
      };
      p.applications += 1;
      if (a.status === "hired") p.hired += 1;
      else if (a.status === "rejected") {
        p.rejected += 1;
        bump(p.rejectionReasons, a.rejection_reason?.name ?? "unspecified");
      } else bump(p.stages, a.current_stage?.name ?? "unknown stage");
      if (a.last_activity_at && a.last_activity_at > p.latest) p.latest = a.last_activity_at;
      pipelines.set(job.id, p);
    }
    for (const s of scorecards) {
      const jobId = s.application_id ? appToJob.get(s.application_id) : undefined;
      const p = jobId ? pipelines.get(jobId) : undefined;
      if (!p) continue;
      bump(p.recommendations, s.overall_recommendation ?? "no decision");
    }
    for (const p of pipelines.values()) {
      signals.push({
        external_id: `pipeline:${p.jobId}`,
        title: `Hiring pipeline · ${p.jobName}`,
        text: greenhousePipelineText(p),
        at: p.latest || undefined,
        kind_hint: "pipeline",
      });
    }

    return {
      signals: signals.slice(0, limit),
      stats: { jobs: jobs.length, applications: applications.length, scorecards: scorecards.length },
    };
  },
};
