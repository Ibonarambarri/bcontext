/**
 * Make — `make` → Nango `make` (API_KEY; proxy
 * https://<connectionConfig.environmentUrl>/api/v2, e.g. eu1.make.com).
 *
 * Two things change in Make that a team cares about: a scenario was edited
 * (`lastEdit`) and a scenario run failed. Scenarios are listed per team —
 * `config.team_id` or every team of every organization the token can see
 * (`/organizations` → `/teams?organizationId`) — and filtered client-side
 * on `lastEdit`; failures come from `/scenarios/{id}/logs?from=<ms>&status=3`
 * (3 = error) for the scenarios in scope, with the execution detail fetched
 * for the error message (`/scenarios/{id}/executions/{executionId}`).
 *
 * Install config: `team_id`, `scenarios` (ids allow-list).
 */
import type { IngestSignal } from "@/lib/ingest/batch-extract";
import { allowList, clip, configString, str, type NangoAdapter } from "./shared";

interface MakeScenario {
  id: number;
  name?: string;
  description?: string;
  isActive?: boolean;
  isPaused?: boolean;
  lastEdit?: string;
  teamId?: number;
  scheduling?: { type?: string; interval?: number };
}

interface MakeLog {
  id?: string;
  imtId?: string;
  timestamp?: string;
  status?: number;
  duration?: number;
  operations?: number;
  type?: string;
}

interface MakeExecution {
  status?: string;
  error?: { name?: string; message?: string; causeModule?: { name?: string; id?: number } };
}

const STATUS: Record<number, string> = { 1: "success", 2: "warning", 3: "error" };
const MAX_TEAMS = 5;
const MAX_FAILURE_LOOKUPS = 20;

export function makeScenarioUrl(environmentUrl: string, scenarioId: number): string {
  return `https://${environmentUrl.replace(/^https?:\/\//, "")}/scenarios/${scenarioId}`;
}

export const makeAdapter: NangoAdapter = {
  id: "make",
  provider: "make",
  sourceHint: "make:scenarios",
  async fetchChanges({ client, connectionId, connectionConfig, config, since, limit }) {
    const env = str(connectionConfig.environmentUrl);
    const teamIds: string[] = [];
    const configured = configString(config, "team_id");
    if (configured) teamIds.push(configured);
    else {
      const orgs = await client.proxy<{ organizations?: Array<{ id: number }> }>({
        method: "GET",
        providerConfigKey: "make",
        connectionId,
        path: "/organizations",
      });
      if (!orgs.ok) throw new Error(`make organizations failed (${orgs.status})`);
      for (const org of orgs.data?.organizations ?? []) {
        const teams = await client.proxy<{ teams?: Array<{ id: number }> }>({
          method: "GET",
          providerConfigKey: "make",
          connectionId,
          path: "/teams",
          query: { organizationId: org.id },
        });
        if (!teams.ok) continue;
        for (const t of teams.data?.teams ?? []) teamIds.push(String(t.id));
        if (teamIds.length >= MAX_TEAMS) break;
      }
    }

    const allow = allowList(config, "scenarios");
    const signals: IngestSignal[] = [];
    const stats = { teams: teamIds.length, scenarios: 0, edited: 0, failures: 0 };
    const sinceMs = since.getTime();
    const failureCandidates: MakeScenario[] = [];

    for (const teamId of teamIds.slice(0, MAX_TEAMS)) {
      const res = await client.proxy<{ scenarios?: MakeScenario[] }>({
        method: "GET",
        providerConfigKey: "make",
        connectionId,
        path: "/scenarios",
        query: { teamId, "pg[limit]": 100 },
      });
      if (!res.ok) throw new Error(`make scenarios failed (${res.status})`);
      for (const s of res.data?.scenarios ?? []) {
        if (allow && !allow.includes(String(s.id))) continue;
        stats.scenarios += 1;
        failureCandidates.push(s);
        if (s.lastEdit && Date.parse(s.lastEdit) > sinceMs) {
          stats.edited += 1;
          signals.push({
            external_id: `scenario:${s.id}`,
            title: `Scenario · ${s.name ?? s.id}`,
            text: [
              `State: ${s.isPaused ? "paused" : s.isActive ? "active" : "inactive"} · Edited: ${s.lastEdit}${s.scheduling?.type ? ` · Schedule: ${s.scheduling.type}${s.scheduling.interval ? ` every ${s.scheduling.interval} min` : ""}` : ""}`,
              "",
              clip(s.description ?? ""),
            ].join("\n"),
            url: env ? makeScenarioUrl(env, s.id) : undefined,
            at: s.lastEdit,
            kind_hint: "automation",
          });
          if (signals.length >= limit) return { signals, stats };
        }
      }
    }

    // Failed runs since the cursor, scenario by scenario (bounded).
    let lookups = 0;
    for (const s of failureCandidates) {
      if (lookups >= MAX_FAILURE_LOOKUPS || signals.length >= limit) break;
      lookups += 1;
      const logs = await client.proxy<{ scenarioLogs?: MakeLog[] }>({
        method: "GET",
        providerConfigKey: "make",
        connectionId,
        path: `/scenarios/${s.id}/logs`,
        query: { from: sinceMs, status: 3, "pg[limit]": 10 },
      });
      if (!logs.ok) continue;
      for (const log of logs.data?.scenarioLogs ?? []) {
        if (!log.timestamp || Date.parse(log.timestamp) <= sinceMs) continue;
        const executionId = log.imtId ?? log.id;
        let error = "";
        if (executionId) {
          const detail = await client.proxy<MakeExecution>({
            method: "GET",
            providerConfigKey: "make",
            connectionId,
            path: `/scenarios/${s.id}/executions/${executionId}`,
          });
          const e = detail.ok ? detail.data?.error : undefined;
          if (e) error = [e.name, e.message, e.causeModule?.name ? `in module ${e.causeModule.name}` : null].filter(Boolean).join(" — ");
        }
        stats.failures += 1;
        signals.push({
          external_id: `run:${s.id}:${executionId ?? log.timestamp}`,
          title: `Scenario run ${STATUS[log.status ?? 0] ?? "failed"} · ${s.name ?? s.id}`,
          text: [
            `Status: ${STATUS[log.status ?? 0] ?? log.status} · At: ${log.timestamp} · Duration: ${log.duration ?? "?"} ms · Operations: ${log.operations ?? "?"}`,
            error ? `Error: ${clip(error, 1500)}` : null,
          ]
            .filter((x) => x !== null)
            .join("\n"),
          url: env ? `${makeScenarioUrl(env, s.id)}/logs` : undefined,
          at: log.timestamp,
          kind_hint: "automation_run",
        });
        if (signals.length >= limit) break;
      }
    }

    return { signals: signals.slice(0, limit), stats };
  },
};
