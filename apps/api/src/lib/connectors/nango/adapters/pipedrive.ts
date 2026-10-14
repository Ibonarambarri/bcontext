/**
 * Pipedrive — `pipedrive` → Nango `pipedrive` (OAuth2; proxy base
 * `${connectionConfig.api_domain}/api`, e.g. https://acme.pipedrive.com/api).
 *
 * Three v1 lists, newest first, stopping at the cursor:
 *   - deals     `GET /v1/deals?sort=update_time DESC&status=all_not_deleted`
 *   - notes     `GET /v1/notes?sort=update_time DESC` (HTML content)
 *   - activities `GET /v1/activities?since=<utc>` (calls, meetings, tasks)
 * Pipedrive stamps times as "YYYY-MM-DD HH:MM:SS" in UTC; they are parsed
 * as such. Pagination uses `start`/`limit` and
 * `additional_data.pagination.more_items_in_collection`.
 *
 * Install config: `pipelines` (pipeline ids) keeps only deals from those
 * pipelines; notes/activities follow their deal when it is known.
 */
import type { IngestSignal } from "@/lib/ingest/batch-extract";
import { allowList, clip, htmlToText, str, type NangoAdapter } from "./shared";

interface PipedriveDeal {
  id: number;
  title?: string;
  value?: number;
  currency?: string;
  status?: string;
  stage_id?: number;
  pipeline_id?: number;
  update_time?: string;
  add_time?: string;
  won_time?: string | null;
  lost_time?: string | null;
  lost_reason?: string | null;
  expected_close_date?: string | null;
  next_activity_subject?: string | null;
  owner_name?: string;
  person_name?: string | null;
  org_name?: string | null;
}

interface PipedriveNote {
  id: number;
  content?: string;
  deal_id?: number | null;
  person_id?: number | null;
  org_id?: number | null;
  update_time?: string;
  add_time?: string;
  user?: { name?: string; email?: string };
  deal?: { title?: string } | null;
}

interface PipedriveActivity {
  id: number;
  subject?: string;
  type?: string;
  note?: string | null;
  public_description?: string | null;
  done?: boolean;
  due_date?: string;
  update_time?: string;
  deal_id?: number | null;
  deal_title?: string | null;
  owner_name?: string;
}

interface Page<T> {
  data?: T[] | null;
  additional_data?: { pagination?: { more_items_in_collection?: boolean; next_start?: number } };
}

const PAGE = 100;
const MAX_PAGES = 5;

/** "2026-09-02 10:15:00" (UTC) → Date; ISO strings pass through. */
export function pipedriveTime(v: string | null | undefined): Date | null {
  if (!v) return null;
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(v) ? `${v.replace(" ", "T")}Z` : v;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Date → "YYYY-MM-DD HH:MM:SS" UTC, what `since`/`until` expect. */
export function pipedriveSince(d: Date): string {
  return d.toISOString().slice(0, 19).replace("T", " ");
}

function isoOf(v: string | null | undefined): string | undefined {
  return pipedriveTime(v)?.toISOString();
}

export const pipedriveAdapter: NangoAdapter = {
  id: "pipedrive",
  provider: "pipedrive",
  sourceHint: "pipedrive:crm",
  async fetchChanges({ client, connectionId, connectionConfig, config, since, limit }) {
    const domain = str(connectionConfig.api_domain).replace(/\/+$/, "");
    const pipelines = allowList(config, "pipelines");
    const signals: IngestSignal[] = [];
    const stats: Record<string, number> = { deals: 0, notes: 0, activities: 0 };
    const link = (kind: "deal" | "person" | "organization", id: number | null | undefined) =>
      domain && id ? `${domain}/${kind}/${id}` : undefined;

    // Deals, newest update first; stop at the first one at/before the cursor.
    let start = 0;
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await client.proxy<Page<PipedriveDeal>>({
        method: "GET",
        providerConfigKey: "pipedrive",
        connectionId,
        path: "/v1/deals",
        query: { sort: "update_time DESC", status: "all_not_deleted", start, limit: PAGE },
      });
      if (!res.ok) throw new Error(`pipedrive deals failed (${res.status})`);
      let stop = false;
      for (const d of res.data?.data ?? []) {
        const at = pipedriveTime(d.update_time);
        if (at && at <= since) {
          stop = true;
          break;
        }
        if (pipelines && !pipelines.includes(String(d.pipeline_id))) continue;
        stats.deals = (stats.deals ?? 0) + 1;
        const outcome = d.status === "won" ? `Won ${d.won_time ?? ""}` : d.status === "lost" ? `Lost ${d.lost_time ?? ""}${d.lost_reason ? ` — ${d.lost_reason}` : ""}` : `Open · stage ${d.stage_id ?? "?"}`;
        signals.push({
          external_id: `deal:${d.id}`,
          title: d.title ?? `Deal ${d.id}`,
          text: [
            `${outcome}${d.value != null ? ` · ${d.value} ${d.currency ?? ""}`.trimEnd() : ""}`,
            d.org_name || d.person_name ? `With: ${[d.org_name, d.person_name].filter(Boolean).join(" / ")}` : null,
            d.expected_close_date ? `Expected close: ${d.expected_close_date}` : null,
            d.next_activity_subject ? `Next: ${d.next_activity_subject}` : null,
          ]
            .filter(Boolean)
            .join("\n"),
          url: link("deal", d.id),
          author: d.owner_name,
          at: at?.toISOString(),
          kind_hint: "deal",
        });
        if (signals.length >= limit) break;
      }
      const more = res.data?.additional_data?.pagination?.more_items_in_collection;
      start = res.data?.additional_data?.pagination?.next_start ?? start + PAGE;
      if (stop || !more || signals.length >= limit) break;
    }

    // Notes (HTML), newest update first.
    start = 0;
    for (let page = 0; page < MAX_PAGES && signals.length < limit; page++) {
      const res = await client.proxy<Page<PipedriveNote>>({
        method: "GET",
        providerConfigKey: "pipedrive",
        connectionId,
        path: "/v1/notes",
        query: { sort: "update_time DESC", start, limit: PAGE },
      });
      if (!res.ok) throw new Error(`pipedrive notes failed (${res.status})`);
      let stop = false;
      for (const n of res.data?.data ?? []) {
        const at = pipedriveTime(n.update_time ?? n.add_time);
        if (at && at <= since) {
          stop = true;
          break;
        }
        const body = htmlToText(n.content ?? "");
        if (!body) continue;
        stats.notes = (stats.notes ?? 0) + 1;
        const target = n.deal_id ? `deal ${n.deal?.title ?? n.deal_id}` : n.org_id ? `organization ${n.org_id}` : n.person_id ? `person ${n.person_id}` : "";
        signals.push({
          external_id: `note:${n.id}`,
          title: target ? `Note on ${target}` : "Note",
          text: clip(body),
          url: link("deal", n.deal_id) ?? link("organization", n.org_id) ?? link("person", n.person_id),
          author: n.user?.name ?? n.user?.email,
          at: at?.toISOString(),
          kind_hint: "note",
        });
        if (signals.length >= limit) break;
      }
      const more = res.data?.additional_data?.pagination?.more_items_in_collection;
      start = res.data?.additional_data?.pagination?.next_start ?? start + PAGE;
      if (stop || !more) break;
    }

    // Activities updated since the cursor (server-side filter).
    start = 0;
    for (let page = 0; page < MAX_PAGES && signals.length < limit; page++) {
      const res = await client.proxy<Page<PipedriveActivity>>({
        method: "GET",
        providerConfigKey: "pipedrive",
        connectionId,
        path: "/v1/activities",
        query: { since: pipedriveSince(since), user_id: 0, start, limit: PAGE },
      });
      if (!res.ok) throw new Error(`pipedrive activities failed (${res.status})`);
      for (const a of res.data?.data ?? []) {
        const body = htmlToText(a.note ?? a.public_description ?? "");
        stats.activities = (stats.activities ?? 0) + 1;
        signals.push({
          external_id: `activity:${a.id}`,
          title: `${a.type ?? "activity"} · ${a.subject ?? ""}`.trim(),
          text: [
            `${a.done ? "Done" : "Planned"}${a.due_date ? ` · ${a.due_date}` : ""}${a.deal_title ? ` · Deal: ${a.deal_title}` : ""}`,
            body ? "" : null,
            body || null,
          ]
            .filter((l) => l !== null)
            .join("\n"),
          url: link("deal", a.deal_id),
          author: a.owner_name,
          at: isoOf(a.update_time),
          kind_hint: "activity",
        });
        if (signals.length >= limit) break;
      }
      const more = res.data?.additional_data?.pagination?.more_items_in_collection;
      start = res.data?.additional_data?.pagination?.next_start ?? start + PAGE;
      if (!more) break;
    }

    return { signals: signals.slice(0, limit), stats };
  },
};
