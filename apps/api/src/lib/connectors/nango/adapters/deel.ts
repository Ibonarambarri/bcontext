/**
 * Deel — `deel` → Nango `deel` (OAuth2; proxy https://api.letsdeel.com).
 *
 * Two things a company brain cares about from Deel: contracts that were
 * created or changed since the cursor (title, type, country, status, team —
 * never rates or pay) and the shape of the org (headcount and titles per
 * team, from the people list). Contract lists sort by `created_at`, so the
 * walk stops at the first contract created before the cursor; contracts
 * that only changed status are still caught when `updated_at` is newer.
 *
 * Assumptions (docs, not exercised live): `GET /rest/v2/contracts` returns
 * `{ data: [...], page: { cursor } }` and pages with `after_cursor`;
 * `GET /rest/v2/people` returns `{ data: [...] }` with `employments[]`.
 * Privacy: names, emails and rates are never copied into signal text.
 */
import type { IngestSignal } from "@/lib/ingest/batch-extract";
import { allowList, clip, str, type NangoAdapter } from "./shared";

interface DeelContract {
  id: string;
  title?: string;
  type?: string;
  status?: string;
  created_at?: string;
  updated_at?: string;
  start_date?: string;
  termination_date?: string | null;
  worker?: { country?: string };
  client?: { legal_entity?: { name?: string }; team?: { name?: string } };
  team?: { name?: string };
  job_title?: string;
  seniority?: { name?: string };
  scope_of_work?: string;
}

interface DeelPerson {
  id?: string;
  job_title?: string;
  country?: string;
  hiring_type?: string;
  hiring_status?: string;
  start_date?: string;
  employments?: Array<{ team?: { name?: string }; job_title?: string; hiring_status?: string; hiring_type?: string }>;
  department?: { name?: string };
}

interface Page<T> {
  data?: T[];
  page?: { cursor?: string | null; total_rows?: number };
}

const MAX_PAGES = 5;

function teamOf(c: DeelContract): string {
  return str(c.team?.name || c.client?.team?.name) || "no team";
}

export const deelAdapter: NangoAdapter = {
  id: "deel",
  provider: "deel",
  sourceHint: "deel:contracts",
  async fetchChanges({ client, connectionId, config, since, limit }) {
    const teams = allowList(config, "teams");
    const signals: IngestSignal[] = [];
    const stats: Record<string, number> = { contracts: 0, people: 0 };

    // -- contracts created or updated since the cursor ------------------------
    let cursor: string | undefined;
    let pages = 0;
    let reachedOld = false;
    while (!reachedOld && pages < MAX_PAGES && signals.length < limit) {
      const res = await client.proxy<Page<DeelContract>>({
        method: "GET",
        providerConfigKey: "deel",
        connectionId,
        path: "/rest/v2/contracts",
        query: {
          limit: 100,
          sort_by: "created_at",
          sort_order: "desc",
          ...(cursor ? { after_cursor: cursor } : {}),
        },
      });
      if (!res.ok) throw new Error(`deel contracts failed (${res.status})`);
      pages++;
      const rows = res.data?.data ?? [];
      for (const c of rows) {
        const created = c.created_at ? new Date(c.created_at) : null;
        const updated = c.updated_at ? new Date(c.updated_at) : created;
        if (created && created <= since && (!updated || updated <= since)) {
          reachedOld = true;
          continue;
        }
        if (!updated || updated <= since) continue;
        const team = teamOf(c);
        if (teams && !teams.includes(team)) continue;
        stats.contracts = (stats.contracts ?? 0) + 1;
        signals.push({
          external_id: `contract:${c.id}`,
          title: `${c.title ?? "Contract"} · ${c.status ?? "?"}`,
          text: [
            `Type: ${c.type ?? "?"} · Status: ${c.status ?? "?"} · Team: ${team}`,
            c.worker?.country ? `Country: ${c.worker.country}` : null,
            c.job_title ? `Role: ${c.job_title}${c.seniority?.name ? ` (${c.seniority.name})` : ""}` : null,
            c.start_date ? `Start: ${c.start_date}${c.termination_date ? ` · Ends: ${c.termination_date}` : ""}` : null,
            c.client?.legal_entity?.name ? `Entity: ${c.client.legal_entity.name}` : null,
            c.scope_of_work ? `\n${clip(c.scope_of_work, 2000)}` : null,
          ]
            .filter(Boolean)
            .join("\n"),
          url: `https://app.deel.com/contracts/${c.id}`,
          at: updated.toISOString(),
          kind_hint: "contract",
        });
        if (signals.length >= limit) break;
      }
      cursor = res.data?.page?.cursor ?? undefined;
      if (!cursor || rows.length === 0) break;
    }

    // -- org snapshot per team --------------------------------------------------
    const people = await client.proxy<Page<DeelPerson>>({
      method: "GET",
      providerConfigKey: "deel",
      connectionId,
      path: "/rest/v2/people",
      query: { limit: 100 },
    });
    if (people.ok) {
      const byTeam = new Map<string, { count: number; titles: Map<string, number>; countries: Set<string>; active: number }>();
      for (const p of people.data?.data ?? []) {
        const emp = p.employments?.[0];
        const team = str(emp?.team?.name || p.department?.name) || "no team";
        if (teams && !teams.includes(team)) continue;
        stats.people = (stats.people ?? 0) + 1;
        const bucket = byTeam.get(team) ?? { count: 0, titles: new Map(), countries: new Set(), active: 0 };
        bucket.count++;
        const title = str(emp?.job_title || p.job_title);
        if (title) bucket.titles.set(title, (bucket.titles.get(title) ?? 0) + 1);
        if (p.country) bucket.countries.add(p.country);
        if ((emp?.hiring_status ?? p.hiring_status) === "active") bucket.active++;
        byTeam.set(team, bucket);
      }
      for (const [team, b] of byTeam) {
        if (signals.length >= limit) break;
        const titles = [...b.titles.entries()]
          .sort((x, y) => y[1] - x[1])
          .slice(0, 12)
          .map(([t, n]) => `${t} ×${n}`)
          .join(", ");
        signals.push({
          external_id: `team:${team}`,
          title: `Team ${team} · ${b.count} people`,
          text: [
            `Headcount: ${b.count} (${b.active} active)`,
            titles ? `Roles: ${titles}` : null,
            b.countries.size ? `Countries: ${[...b.countries].sort().join(", ")}` : null,
          ]
            .filter(Boolean)
            .join("\n"),
          url: "https://app.deel.com/people",
          at: since.toISOString(),
          kind_hint: "org_snapshot",
        });
      }
    } else {
      stats.people_unavailable = 1;
    }

    return { signals: signals.slice(0, limit), stats };
  },
};
