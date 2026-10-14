/**
 * Zapier — `zapier` → Nango `zapier` (OAuth2; proxy https://api.zapier.com).
 *
 * The Partner API v2 is deliberately narrow for a user token: it lists the
 * user's Zaps (`/v2/zaps`, scope `zap:all`) and their runs (`/v2/zap-runs`,
 * scope `zap:runs`) — it does not expose a Zap's payloads beyond the small
 * `data_in`/`data_out` strings on a run. So what NEXO learns here is
 * operational: which automations were edited, paused or enabled since the
 * cursor, and which ones failed. Both lists are offset-paginated
 * (`links.next`); Zaps have no "updated since" filter, so the first page is
 * sorted client-side and cut at the cursor. Runs accept `from_date`.
 *
 * Install config: `statuses` (run statuses to report; default error,
 * error_handled, halted).
 */
import type { IngestSignal } from "@/lib/ingest/batch-extract";
import { allowList, clip, type NangoAdapter } from "./shared";

interface ZapStep {
  title?: string | null;
  action?: string | { title?: string; app?: { title?: string } };
}

interface Zap {
  id: string;
  title?: string;
  is_enabled?: boolean;
  updated_at?: string;
  last_successful_run_date?: string | null;
  links?: Record<string, string>;
  steps?: Array<ZapStep | string>;
}

interface ZapRun {
  id: string;
  zap_id?: number | string;
  zap_title?: string;
  status?: string;
  start_time?: string;
  end_time?: string;
  steps?: Array<{ status?: string; start_time?: string }>;
  data_in?: string;
  data_out?: string;
}

interface Page<T> {
  links?: { next?: string | null };
  meta?: { count?: number };
  data?: T[];
}

/** The API wraps every list in a one-element array; unwrap either shape. */
export function zapierPage<T>(body: unknown): Page<T> {
  const first = Array.isArray(body) ? body[0] : body;
  return (first && typeof first === "object" ? first : {}) as Page<T>;
}

const DEFAULT_RUN_STATUSES = ["error", "error_handled", "halted"];

function stepLine(step: ZapStep | string): string {
  if (typeof step === "string") return step;
  const action = typeof step.action === "object" ? step.action : null;
  const app = action?.app?.title;
  const name = step.title ?? action?.title ?? "";
  return [app, name].filter(Boolean).join(": ") || "(step)";
}

export const zapierAdapter: NangoAdapter = {
  id: "zapier",
  provider: "zapier",
  sourceHint: "zapier:automations",
  async fetchChanges({ client, connectionId, config, since, limit }) {
    const signals: IngestSignal[] = [];
    const stats = { zaps: 0, runs: 0 };
    const sinceMs = since.getTime();

    // Zaps edited since the cursor (no server-side filter: sort + cut).
    const zaps = await client.proxy<Page<Zap> | Page<Zap>[]>({
      method: "GET",
      providerConfigKey: "zapier",
      connectionId,
      path: "/v2/zaps",
      query: { limit: 100, expand: "steps.action" },
    });
    if (!zaps.ok) throw new Error(`zapier zaps failed (${zaps.status})`);
    const changed = (zapierPage<Zap>(zaps.data).data ?? [])
      .filter((z) => z.updated_at && Date.parse(z.updated_at) > sinceMs)
      .sort((a, b) => Date.parse(b.updated_at ?? "") - Date.parse(a.updated_at ?? ""));
    for (const z of changed) {
      stats.zaps += 1;
      signals.push({
        external_id: `zap:${z.id}`,
        title: `Zap · ${z.title ?? z.id}`,
        text: [
          `State: ${z.is_enabled ? "enabled" : "paused"} · Last successful run: ${z.last_successful_run_date ?? "never"} · Edited: ${z.updated_at ?? "?"}`,
          "",
          "Steps:",
          ...(z.steps ?? []).map((s, i) => `${i + 1}. ${stepLine(s)}`),
        ].join("\n"),
        url: z.links?.html_editor ?? z.links?.html,
        at: z.updated_at,
        kind_hint: "automation",
      });
      if (signals.length >= limit) break;
    }

    // Runs in the window that ended badly (or whatever statuses are configured).
    const statuses = allowList(config, "statuses") ?? DEFAULT_RUN_STATUSES;
    let offset = 0;
    let pages = 0;
    while (signals.length < limit && pages < 3) {
      const runs = await client.proxy<Page<ZapRun> | Page<ZapRun>[]>({
        method: "GET",
        providerConfigKey: "zapier",
        connectionId,
        path: "/v2/zap-runs",
        query: {
          from_date: since.toISOString(),
          statuses: statuses.join(","),
          limit: Math.min(50, limit),
          offset,
        },
      });
      if (!runs.ok) throw new Error(`zapier zap-runs failed (${runs.status})`);
      const page = zapierPage<ZapRun>(runs.data);
      const rows = page.data ?? [];
      for (const r of rows) {
        stats.runs += 1;
        const failedStep = (r.steps ?? []).findIndex((s) => s.status && s.status !== "success");
        signals.push({
          external_id: `run:${r.id}`,
          title: `Zap run ${r.status ?? "?"} · ${r.zap_title ?? r.zap_id ?? ""}`.trim(),
          text: [
            `Status: ${r.status ?? "?"} · Started: ${r.start_time ?? "?"} · Ended: ${r.end_time ?? "?"}`,
            failedStep >= 0 ? `Failed at step ${failedStep + 1} of ${r.steps?.length ?? "?"}` : null,
            r.data_in ? `Input: ${clip(r.data_in, 1500)}` : null,
            r.data_out ? `Output: ${clip(r.data_out, 1500)}` : null,
          ]
            .filter((x) => x !== null)
            .join("\n"),
          url: r.zap_id ? `https://zapier.com/app/history?zap_id=${r.zap_id}` : undefined,
          at: r.end_time ?? r.start_time,
          kind_hint: "automation_run",
        });
        if (signals.length >= limit) break;
      }
      pages += 1;
      if (!page.links?.next || rows.length === 0) break;
      offset += rows.length;
    }

    return { signals: signals.slice(0, limit), stats: { ...stats, pages } };
  },
};
