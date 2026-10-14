/**
 * Salesforce — `salesforce` → Nango `salesforce` (OAuth2; proxy base is the
 * org's `connectionConfig.instance_url`). SOQL over the objects where
 * commitments live: Opportunity (stage, amount, next step, description),
 * Task and Event (subject + description), ContentNote (title + text
 * preview) — each `WHERE LastModifiedDate > <since>`, newest first, paged
 * through `nextRecordsUrl`. `config.objects` narrows the list (default
 * Opportunity, Task, Event, ContentNote).
 *
 * Assumptions: REST API v60.0; SOQL datetimes are unquoted ISO-8601 in UTC;
 * links use the Lightning `/lightning/r/<Object>/<Id>/view` form.
 */
import type { IngestSignal } from "@/lib/ingest/batch-extract";
import type { ProxyResponse } from "@/lib/nango/client";
import { allowList, clip, str, type NangoAdapter } from "./shared";

export const SALESFORCE_API = "/services/data/v60.0";

interface SfRecord {
  Id: string;
  Name?: string;
  Subject?: string;
  Title?: string;
  StageName?: string;
  Amount?: number | null;
  CloseDate?: string | null;
  NextStep?: string | null;
  Description?: string | null;
  TextPreview?: string | null;
  Status?: string | null;
  StartDateTime?: string | null;
  LastModifiedDate?: string;
  Owner?: { Name?: string } | null;
  Account?: { Name?: string } | null;
  attributes?: { type?: string };
}

interface SfQuery {
  totalSize?: number;
  done?: boolean;
  nextRecordsUrl?: string;
  records?: SfRecord[];
}

interface ObjectSpec {
  object: string;
  fields: string[];
  title: (r: SfRecord) => string;
  body: (r: SfRecord) => string;
  kind: string;
}

const SPECS: Record<string, ObjectSpec> = {
  Opportunity: {
    object: "Opportunity",
    fields: ["Id", "Name", "StageName", "Amount", "CloseDate", "NextStep", "Description", "LastModifiedDate", "Owner.Name", "Account.Name"],
    title: (r) => `${r.Account?.Name ? `${r.Account.Name} · ` : ""}${r.Name ?? "Opportunity"}`,
    body: (r) =>
      [
        `Stage: ${r.StageName ?? "?"}${r.Amount != null ? ` · Amount: ${r.Amount}` : ""}${r.CloseDate ? ` · Close: ${r.CloseDate}` : ""}`,
        r.NextStep ? `Next step: ${r.NextStep}` : null,
        "",
        r.Description ?? "",
      ]
        .filter((l) => l !== null)
        .join("\n"),
    kind: "opportunity",
  },
  Task: {
    object: "Task",
    fields: ["Id", "Subject", "Description", "Status", "LastModifiedDate", "Owner.Name"],
    title: (r) => r.Subject ?? "Task",
    body: (r) => [`Status: ${r.Status ?? "?"}`, "", r.Description ?? ""].join("\n"),
    kind: "task",
  },
  Event: {
    object: "Event",
    fields: ["Id", "Subject", "Description", "StartDateTime", "LastModifiedDate", "Owner.Name"],
    title: (r) => r.Subject ?? "Event",
    body: (r) => [r.StartDateTime ? `When: ${r.StartDateTime}` : null, "", r.Description ?? ""].filter((l) => l !== null).join("\n"),
    kind: "event",
  },
  ContentNote: {
    object: "ContentNote",
    fields: ["Id", "Title", "TextPreview", "LastModifiedDate", "Owner.Name"],
    title: (r) => r.Title ?? "Note",
    body: (r) => r.TextPreview ?? "",
    kind: "note",
  },
};

const DEFAULT_OBJECTS = ["Opportunity", "Task", "Event", "ContentNote"];

export function soql(spec: ObjectSpec, since: Date, limit: number): string {
  return `SELECT ${spec.fields.join(", ")} FROM ${spec.object} WHERE LastModifiedDate > ${since.toISOString()} ORDER BY LastModifiedDate DESC LIMIT ${Math.min(200, limit)}`;
}

export const salesforceAdapter: NangoAdapter = {
  id: "salesforce",
  provider: "salesforce",
  sourceHint: "salesforce:crm",
  async fetchChanges({ client, connectionId, connectionConfig, config, since, limit }) {
    const instance = str(connectionConfig.instance_url).replace(/\/+$/, "");
    const wanted = (allowList(config, "objects") ?? DEFAULT_OBJECTS).filter((o) => SPECS[o]);
    const signals: IngestSignal[] = [];
    const stats: Record<string, number> = {};
    for (const name of wanted) {
      const spec = SPECS[name]!;
      let path: string | null = `${SALESFORCE_API}/query`;
      let query: Record<string, string> | undefined = { q: soql(spec, since, limit) };
      let pages = 0;
      while (path && pages < 5 && signals.length < limit) {
        const res: ProxyResponse<SfQuery> = await client.proxy<SfQuery>({ method: "GET", providerConfigKey: "salesforce", connectionId, path, query });
        if (!res.ok) throw new Error(`salesforce ${spec.object} query failed (${res.status})`);
        const rows = res.data?.records ?? [];
        stats[spec.object] = (stats[spec.object] ?? 0) + rows.length;
        for (const r of rows) {
          signals.push({
            external_id: `${spec.object.toLowerCase()}:${r.Id}`,
            title: spec.title(r),
            text: clip(spec.body(r)),
            url: instance ? `${instance}/lightning/r/${spec.object}/${r.Id}/view` : undefined,
            author: r.Owner?.Name ?? undefined,
            at: r.LastModifiedDate,
            kind_hint: spec.kind,
          });
          if (signals.length >= limit) break;
        }
        path = res.data?.done === false && res.data.nextRecordsUrl ? res.data.nextRecordsUrl : null;
        query = undefined;
        pages += 1;
      }
    }
    return { signals: signals.slice(0, limit), stats };
  },
};
