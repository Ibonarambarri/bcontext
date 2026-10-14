/**
 * Airtable — `airtable` → Nango `airtable-pat` (API_KEY: personal access
 * token). Walks bases → tables → records modified since the cursor
 * (`LAST_MODIFIED_TIME()` filter), capped to a handful of bases/tables.
 */
import type { IngestSignal } from "@/lib/ingest/batch-extract";
import { allowList, type NangoAdapter } from "./shared";

interface AirtableBase { id: string; name?: string }
interface AirtableTable { id: string; name?: string }
interface AirtableRecord { id: string; createdTime?: string; fields?: Record<string, unknown> }

export function airtableFieldsToText(fields: Record<string, unknown>): string {
  return Object.entries(fields)
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.map((x) => (typeof x === "object" && x ? JSON.stringify(x) : String(x))).join(", ") : typeof v === "object" && v ? JSON.stringify(v) : String(v)}`)
    .join("\n");
}

export const airtableAdapter: NangoAdapter = {
  id: "airtable",
  provider: "airtable-pat",
  sourceHint: "airtable:records",
  async fetchChanges({ client, connectionId, config, since, limit }) {
    const baseFilter = allowList(config, "bases");
    const tableFilter = allowList(config, "tables");
    const basesRes = await client.proxy<{ bases?: AirtableBase[] }>({
      method: "GET",
      providerConfigKey: "airtable",
      connectionId,
      path: "/v0/meta/bases",
    });
    if (!basesRes.ok) throw new Error(`airtable bases failed (${basesRes.status})`);
    const bases = (basesRes.data?.bases ?? []).filter((b) => !baseFilter || baseFilter.includes(b.id) || baseFilter.includes(b.name ?? "")).slice(0, 5);
    const signals: IngestSignal[] = [];
    let tablesScanned = 0;
    for (const base of bases) {
      const tablesRes = await client.proxy<{ tables?: AirtableTable[] }>({
        method: "GET",
        providerConfigKey: "airtable",
        connectionId,
        path: `/v0/meta/bases/${base.id}/tables`,
      });
      if (!tablesRes.ok) continue;
      const tables = (tablesRes.data?.tables ?? []).filter((t) => !tableFilter || tableFilter.includes(t.id) || tableFilter.includes(t.name ?? "")).slice(0, 10);
      for (const table of tables) {
        tablesScanned += 1;
        const recordsRes = await client.proxy<{ records?: AirtableRecord[] }>({
          method: "GET",
          providerConfigKey: "airtable",
          connectionId,
          path: `/v0/${base.id}/${encodeURIComponent(table.id)}`,
          query: {
            pageSize: Math.min(50, limit),
            filterByFormula: `IS_AFTER(LAST_MODIFIED_TIME(), '${since.toISOString()}')`,
          },
        });
        if (!recordsRes.ok) continue;
        for (const rec of recordsRes.data?.records ?? []) {
          signals.push({
            external_id: `record:${base.id}:${table.id}:${rec.id}`,
            title: `${base.name ?? base.id} / ${table.name ?? table.id} / ${rec.id}`,
            text: airtableFieldsToText(rec.fields ?? {}),
            url: `https://airtable.com/${base.id}/${table.id}/${rec.id}`,
            at: rec.createdTime,
            kind_hint: "row",
          });
          if (signals.length >= limit) break;
        }
        if (signals.length >= limit) break;
      }
      if (signals.length >= limit) break;
    }
    return { signals, stats: { bases: bases.length, tables: tablesScanned } };
  },
};
