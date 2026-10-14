/**
 * ServiceNow — `servicenow` → Nango `servicenow` (OAuth2; proxy base
 * https://<hostname> or https://<subdomain>.service-now.com from the
 * connection_config). Table API reads of records updated since the cursor:
 * incidents, change requests and published knowledge articles by default,
 * or only the tables in `config.tables`. Journal fields
 * (`comments_and_work_notes`) come back as one joined string when the
 * instance exposes them; we do not query `sys_journal_field` separately.
 *
 * Assumptions to check against a real instance: `sysparm_query` with
 * `sys_updated_on>=` accepting "YYYY-MM-DD HH:MM:SS" (UTC on the instance),
 * `sysparm_display_value=true` returning display strings for references.
 */
import type { IngestSignal } from "@/lib/ingest/batch-extract";
import { allowList, clip, htmlToText, str, type NangoAdapter } from "./shared";

interface NowRecord {
  sys_id?: string;
  number?: string;
  short_description?: string;
  description?: string;
  state?: string;
  priority?: string;
  category?: string;
  assignment_group?: string;
  assigned_to?: string;
  sys_updated_on?: string;
  sys_updated_by?: string;
  opened_by?: string;
  close_notes?: string;
  comments_and_work_notes?: string;
  // change_request
  risk?: string;
  type?: string;
  justification?: string;
  implementation_plan?: string;
  // kb_knowledge
  text?: string;
  workflow_state?: string;
  kb_category?: string;
  author?: string;
}

interface TableSpec {
  table: string;
  kind: string;
  fields: string[];
  path: string;
}

const TABLES: TableSpec[] = [
  {
    table: "incident",
    kind: "incident",
    path: "incident.do",
    fields: [
      "sys_id", "number", "short_description", "description", "state", "priority", "category",
      "assignment_group", "assigned_to", "opened_by", "close_notes", "comments_and_work_notes",
      "sys_updated_on", "sys_updated_by",
    ],
  },
  {
    table: "change_request",
    kind: "change",
    path: "change_request.do",
    fields: [
      "sys_id", "number", "short_description", "description", "state", "priority", "risk", "type",
      "assignment_group", "assigned_to", "justification", "implementation_plan",
      "comments_and_work_notes", "sys_updated_on", "sys_updated_by",
    ],
  },
  {
    table: "kb_knowledge",
    kind: "article",
    path: "kb_knowledge.do",
    fields: [
      "sys_id", "number", "short_description", "text", "workflow_state", "kb_category", "author",
      "sys_updated_on", "sys_updated_by",
    ],
  },
];

/** ServiceNow's glide date format, UTC. */
export function nowDate(d: Date): string {
  return d.toISOString().slice(0, 19).replace("T", " ");
}

/** Base URL of the instance for deep links, from connection_config. */
export function servicenowBase(connectionConfig: Record<string, unknown>): string {
  const host = str(connectionConfig.hostname);
  if (host) return host.startsWith("http") ? host.replace(/\/+$/, "") : `https://${host}`;
  const sub = str(connectionConfig.subdomain);
  return sub ? `https://${sub}.service-now.com` : "";
}

function line(label: string, value: unknown): string | null {
  const v = str(value).trim();
  return v ? `${label}: ${v}` : null;
}

export const servicenowAdapter: NangoAdapter = {
  id: "servicenow",
  provider: "servicenow",
  sourceHint: "servicenow:records",
  async fetchChanges({ client, connectionId, connectionConfig, config, since, limit }) {
    const wanted = allowList(config, "tables");
    const specs = wanted ? TABLES.filter((t) => wanted.includes(t.table)) : TABLES;
    const base = servicenowBase(connectionConfig);
    const signals: IngestSignal[] = [];
    const stats: Record<string, number> = {};
    for (const spec of specs) {
      const query = [
        `sys_updated_on>=${nowDate(since)}`,
        spec.table === "kb_knowledge" ? "workflow_state=published" : null,
        "ORDERBYDESCsys_updated_on",
      ]
        .filter(Boolean)
        .join("^");
      const res = await client.proxy<{ result?: NowRecord[] }>({
        method: "GET",
        providerConfigKey: "servicenow",
        connectionId,
        path: `/api/now/table/${spec.table}`,
        query: {
          sysparm_query: query,
          sysparm_limit: Math.min(100, limit),
          sysparm_display_value: true,
          sysparm_fields: spec.fields.join(","),
        },
        headers: { Accept: "application/json" },
      });
      if (!res.ok) throw new Error(`servicenow ${spec.table} failed (${res.status})`);
      const rows = res.data?.result ?? [];
      stats[spec.table] = rows.length;
      for (const r of rows) {
        const id = r.sys_id ?? r.number ?? "";
        if (!id) continue;
        const ref = r.number ?? id;
        const body =
          spec.table === "kb_knowledge"
            ? clip(htmlToText(r.text ?? ""), 8000)
            : clip(htmlToText(r.description ?? ""));
        signals.push({
          external_id: `${spec.kind}:${id}`,
          title: `${ref} · ${r.short_description ?? ""}`.trim(),
          text: [
            line("State", r.state ?? r.workflow_state),
            line("Priority", r.priority),
            line("Category", r.category ?? r.kb_category),
            line("Type", r.type),
            line("Risk", r.risk),
            line("Assignment group", r.assignment_group),
            line("Assigned to", r.assigned_to),
            "",
            body,
            r.justification ? `\nJustification: ${clip(r.justification, 1500)}` : null,
            r.implementation_plan ? `\nPlan: ${clip(r.implementation_plan, 1500)}` : null,
            r.close_notes ? `\nClose notes: ${clip(r.close_notes, 1500)}` : null,
            r.comments_and_work_notes ? `\nWork notes:\n${clip(r.comments_and_work_notes, 3000)}` : null,
          ]
            .filter((x) => x !== null)
            .join("\n"),
          url: base ? `${base}/${spec.path}?sys_id=${encodeURIComponent(id)}` : undefined,
          author: r.sys_updated_by ?? r.author ?? r.opened_by,
          at: r.sys_updated_on ? new Date(r.sys_updated_on.replace(" ", "T") + "Z").toISOString() : undefined,
          kind_hint: spec.kind,
        });
        if (signals.length >= limit) break;
      }
      if (signals.length >= limit) break;
    }
    return { signals: signals.slice(0, limit), stats };
  },
};
