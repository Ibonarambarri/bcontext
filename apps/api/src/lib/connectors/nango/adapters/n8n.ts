/**
 * n8n — `n8n` → Nango `n8n` (API_KEY; proxy <connectionConfig.baseUrl>/api,
 * so paths here start at `/v1`).
 *
 * Public API: `/v1/workflows` (cursor-paginated, no updated filter → sorted
 * and cut client-side on `updatedAt`) and `/v1/executions?status=error`
 * (newest first, cut on `startedAt`), with `includeData=true` on the error
 * page so the failing node and message are in the signal. Workflow names
 * are resolved from the workflow list so a failure reads as "Invoice sync
 * failed in node HTTP Request", not as an id.
 *
 * Install config: `workflows` (ids allow-list), `active_only` (boolean).
 */
import type { IngestSignal } from "@/lib/ingest/batch-extract";
import { allowList, clip, str, type NangoAdapter } from "./shared";

interface N8nWorkflow {
  id: string;
  name?: string;
  active?: boolean;
  createdAt?: string;
  updatedAt?: string;
  tags?: Array<{ name?: string }>;
  nodes?: Array<{ name?: string; type?: string }>;
}

interface N8nExecution {
  id: string | number;
  finished?: boolean;
  mode?: string;
  status?: string;
  startedAt?: string;
  stoppedAt?: string;
  workflowId?: string;
  data?: {
    resultData?: {
      error?: { message?: string; description?: string; node?: { name?: string; type?: string } };
      lastNodeExecuted?: string;
    };
  };
}

interface Cursor<T> {
  data?: T[];
  nextCursor?: string | null;
}

export function n8nWorkflowUrl(baseUrl: string, workflowId: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/workflow/${workflowId}`;
}

export const n8nAdapter: NangoAdapter = {
  id: "n8n",
  provider: "n8n",
  sourceHint: "n8n:workflows",
  async fetchChanges({ client, connectionId, connectionConfig, config, since, limit }) {
    const baseUrl = str(connectionConfig.baseUrl);
    const allow = allowList(config, "workflows");
    const activeOnly = config.active_only === true;
    const sinceMs = since.getTime();
    const signals: IngestSignal[] = [];
    const stats = { workflows: 0, edited: 0, failures: 0 };

    // Workflows (all pages, bounded) → names + edits since the cursor.
    const names = new Map<string, string>();
    let cursor: string | null | undefined;
    let pages = 0;
    do {
      const res = await client.proxy<Cursor<N8nWorkflow>>({
        method: "GET",
        providerConfigKey: "n8n",
        connectionId,
        path: "/v1/workflows",
        query: { limit: 100, ...(activeOnly ? { active: true } : {}), ...(cursor ? { cursor } : {}) },
      });
      if (!res.ok) throw new Error(`n8n workflows failed (${res.status})`);
      for (const w of res.data?.data ?? []) {
        if (allow && !allow.includes(w.id)) continue;
        stats.workflows += 1;
        if (w.name) names.set(w.id, w.name);
        if (w.updatedAt && Date.parse(w.updatedAt) > sinceMs) {
          stats.edited += 1;
          signals.push({
            external_id: `workflow:${w.id}`,
            title: `Workflow · ${w.name ?? w.id}`,
            text: [
              `State: ${w.active ? "active" : "inactive"} · Edited: ${w.updatedAt}${w.tags?.length ? ` · Tags: ${w.tags.map((t) => t.name).filter(Boolean).join(", ")}` : ""}`,
              w.nodes?.length ? `Nodes: ${w.nodes.map((n) => n.name).filter(Boolean).slice(0, 25).join(" → ")}` : null,
            ]
              .filter((x) => x !== null)
              .join("\n"),
            url: baseUrl ? n8nWorkflowUrl(baseUrl, w.id) : undefined,
            at: w.updatedAt,
            kind_hint: "automation",
          });
        }
      }
      cursor = res.data?.nextCursor;
      pages += 1;
    } while (cursor && pages < 5);

    // Errored executions since the cursor.
    let execCursor: string | null | undefined;
    let execPages = 0;
    let reachedCursor = false;
    do {
      const res = await client.proxy<Cursor<N8nExecution>>({
        method: "GET",
        providerConfigKey: "n8n",
        connectionId,
        path: "/v1/executions",
        query: { status: "error", limit: 50, includeData: true, ...(execCursor ? { cursor: execCursor } : {}) },
      });
      if (!res.ok) throw new Error(`n8n executions failed (${res.status})`);
      for (const e of res.data?.data ?? []) {
        const at = e.stoppedAt ?? e.startedAt;
        if (!at || Date.parse(at) <= sinceMs) {
          reachedCursor = true;
          continue;
        }
        if (allow && e.workflowId && !allow.includes(e.workflowId)) continue;
        const err = e.data?.resultData?.error;
        const node = err?.node?.name ?? e.data?.resultData?.lastNodeExecuted;
        stats.failures += 1;
        signals.push({
          external_id: `execution:${e.id}`,
          title: `Workflow run failed · ${(e.workflowId && names.get(e.workflowId)) ?? e.workflowId ?? e.id}`,
          text: [
            `Status: ${e.status ?? "error"} · Mode: ${e.mode ?? "?"} · Started: ${e.startedAt ?? "?"} · Stopped: ${e.stoppedAt ?? "?"}`,
            node ? `Failed node: ${node}${err?.node?.type ? ` (${err.node.type})` : ""}` : null,
            err?.message ? `Error: ${clip(err.message, 1500)}` : null,
            err?.description ? clip(err.description, 1000) : null,
          ]
            .filter((x) => x !== null)
            .join("\n"),
          url: baseUrl && e.workflowId ? `${n8nWorkflowUrl(baseUrl, e.workflowId)}/executions/${e.id}` : undefined,
          at,
          kind_hint: "automation_run",
        });
        if (signals.length >= limit) break;
      }
      execCursor = res.data?.nextCursor;
      execPages += 1;
    } while (execCursor && !reachedCursor && signals.length < limit && execPages < 3);

    return { signals: signals.slice(0, limit), stats };
  },
};
