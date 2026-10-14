/**
 * PandaDoc — `pandadoc` → Nango `pandadoc-api-key` (API_KEY; proxy
 * https://api.pandadoc.com).
 *
 * Documents modified since the cursor (`modified_from`, newest first,
 * `count`/`page` pagination), enriched with `/details` for the first few:
 * recipients and their state, the grand total, and metadata/fields — so a
 * completed proposal becomes "Acme signed the 50-seat plan for €12k on the
 * 3rd", not a row.
 *
 * Install config: `statuses` (names from the PandaDoc enum; default sent,
 * completed, declined, viewed, paid, voided), `details_limit` (default 20).
 */
import type { IngestSignal } from "@/lib/ingest/batch-extract";
import { allowList, clip, type NangoAdapter } from "./shared";

interface DocRow {
  id: string;
  name?: string;
  status?: string;
  date_created?: string;
  date_modified?: string;
  date_completed?: string | null;
  expiration_date?: string | null;
  version?: string;
}

interface DocDetails extends DocRow {
  recipients?: Array<{
    first_name?: string;
    last_name?: string;
    email?: string;
    role?: string;
    has_completed?: boolean;
    signing_order?: number | null;
  }>;
  grand_total?: { amount?: string; currency?: string };
  metadata?: Record<string, unknown>;
  fields?: Array<{ name?: string; title?: string; value?: unknown }>;
  tokens?: Array<{ name?: string; value?: unknown }>;
  created_by?: { first_name?: string; last_name?: string; email?: string };
}

/** PandaDoc's status enum → the API's `document.<name>` strings. */
export const PANDADOC_STATUS_NAMES = [
  "draft",
  "sent",
  "completed",
  "uploaded",
  "error",
  "viewed",
  "waiting_approval",
  "approved",
  "rejected",
  "waiting_pay",
  "paid",
  "voided",
  "declined",
  "external_review",
  "scheduled",
] as const;

const DEFAULT_STATUSES = ["sent", "completed", "declined", "viewed", "paid", "voided"];

function statusName(raw: string | undefined): string {
  return (raw ?? "").replace(/^document\./, "") || "?";
}

function person(p: { first_name?: string; last_name?: string; email?: string }): string {
  const name = [p.first_name, p.last_name].filter(Boolean).join(" ");
  return name || p.email || "?";
}

export const pandadocAdapter: NangoAdapter = {
  id: "pandadoc",
  provider: "pandadoc-api-key",
  sourceHint: "pandadoc:documents",
  async fetchChanges({ client, connectionId, config, since, limit }) {
    const statuses = new Set(allowList(config, "statuses") ?? DEFAULT_STATUSES);
    const detailsLimit = typeof config.details_limit === "number" ? config.details_limit : 20;
    const signals: IngestSignal[] = [];
    let page = 1;
    let details = 0;
    let listed = 0;
    for (;;) {
      const res = await client.proxy<{ results?: DocRow[] }>({
        method: "GET",
        providerConfigKey: "pandadoc",
        connectionId,
        path: "/public/v1/documents",
        query: { modified_from: since.toISOString(), order_by: "-date_modified", count: 100, page },
      });
      if (!res.ok) throw new Error(`pandadoc documents failed (${res.status})`);
      const rows = res.data?.results ?? [];
      listed += rows.length;
      for (const row of rows) {
        const status = statusName(row.status);
        if (!statuses.has(status)) continue;
        let detail: DocDetails | undefined;
        if (details < detailsLimit) {
          details += 1;
          const d = await client.proxy<DocDetails>({
            method: "GET",
            providerConfigKey: "pandadoc",
            connectionId,
            path: `/public/v1/documents/${row.id}/details`,
          });
          if (d.ok) detail = d.data;
        }
        const recipients = detail?.recipients ?? [];
        const total = detail?.grand_total?.amount ? `${detail.grand_total.amount} ${detail.grand_total.currency ?? ""}`.trim() : null;
        const fields = (detail?.fields ?? [])
          .filter((f) => f.value !== undefined && f.value !== null && f.value !== "")
          .slice(0, 20)
          .map((f) => `${f.title ?? f.name}: ${typeof f.value === "object" ? JSON.stringify(f.value) : String(f.value)}`);
        signals.push({
          external_id: `document:${row.id}`,
          title: `${status} · ${row.name ?? row.id}`,
          text: [
            `Status: ${status} · Modified: ${row.date_modified ?? "?"} · Created: ${row.date_created ?? "?"}${row.date_completed ? ` · Completed: ${row.date_completed}` : ""}${row.expiration_date ? ` · Expires: ${row.expiration_date}` : ""}`,
            total ? `Total: ${total}` : null,
            recipients.length
              ? `Recipients:\n${recipients.map((r) => `- ${person(r)}${r.role ? ` (${r.role})` : ""}: ${r.has_completed ? "completed" : "pending"}`).join("\n")}`
              : null,
            fields.length ? `Fields:\n${clip(fields.join("\n"), 2000)}` : null,
            detail?.metadata && Object.keys(detail.metadata).length
              ? `Metadata: ${clip(JSON.stringify(detail.metadata), 800)}`
              : null,
          ]
            .filter((x) => x !== null)
            .join("\n"),
          url: `https://app.pandadoc.com/a/#/documents/${row.id}`,
          author: detail?.created_by ? person(detail.created_by) : undefined,
          at: row.date_modified,
          kind_hint: "agreement",
        });
        if (signals.length >= limit) break;
      }
      if (rows.length < 100 || signals.length >= limit || page >= 3) break;
      page += 1;
    }
    return { signals: signals.slice(0, limit), stats: { listed, details, pages: page } };
  },
};
