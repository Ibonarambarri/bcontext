/**
 * Zoho CRM — `zoho-crm` → Nango `zoho-crm` (OAuth2 via the `zoho` base
 * provider). Zoho is region-sharded, so every call carries
 * `Base-Url-Override: https://www.zohoapis.<extension>` built from the
 * connection_config (`extension` = com | eu | in | com.au | jp | …), which is
 * what providers.yaml resolves for the base provider anyway.
 *
 * Reads records modified since the cursor in Deals, Notes and Tasks (or
 * `config.modules`) with `If-Modified-Since` and a Modified_Time sort, one
 * signal per record. Contact and lead PII is never copied; only names of
 * the linked account/deal are used.
 *
 * Assumptions to check live: v6 module list endpoints honour
 * `If-Modified-Since` (documented) and return 304 with an empty body when
 * nothing changed (treated as zero records).
 */
import type { IngestSignal } from "@/lib/ingest/batch-extract";
import { allowList, clip, htmlToText, str, type NangoAdapter } from "./shared";

interface ZohoRecord {
  id: string;
  Deal_Name?: string;
  Stage?: string;
  Amount?: number;
  Closing_Date?: string;
  Description?: string;
  Account_Name?: { name?: string } | null;
  Owner?: { name?: string } | null;
  Modified_Time?: string;
  Modified_By?: { name?: string } | null;
  // Notes
  Note_Title?: string;
  Note_Content?: string;
  Parent_Id?: { name?: string; id?: string } | null;
  $se_module?: string;
  // Tasks
  Subject?: string;
  Status?: string;
  Priority?: string;
  Due_Date?: string;
  What_Id?: { name?: string } | null;
}

const DEFAULT_MODULES = ["Deals", "Notes", "Tasks"];

export function zohoApiBase(connectionConfig: Record<string, unknown>): string {
  const explicit = str(connectionConfig.api_domain);
  if (explicit) return explicit.replace(/\/+$/, "");
  const ext = str(connectionConfig.extension) || "com";
  return `https://www.zohoapis.${ext}`;
}

export function zohoCrmUrl(connectionConfig: Record<string, unknown>, module: string, id: string): string {
  const ext = str(connectionConfig.extension) || "com";
  return `https://crm.zoho.${ext}/crm/tab/${module}/${id}`;
}

function name(v: { name?: string } | null | undefined): string {
  return v?.name ?? "";
}

function describe(module: string, r: ZohoRecord): { title: string; text: string; kind: string } {
  if (module === "Notes") {
    const parent = name(r.Parent_Id);
    return {
      kind: "note",
      title: r.Note_Title || `Note on ${parent || r.$se_module || "record"}`,
      text: [
        parent ? `On: ${parent}${r.$se_module ? ` (${r.$se_module})` : ""}` : null,
        "",
        clip(htmlToText(r.Note_Content ?? "")),
      ]
        .filter((x) => x !== null)
        .join("\n"),
    };
  }
  if (module === "Tasks") {
    return {
      kind: "task",
      title: r.Subject ?? "(untitled task)",
      text: [
        `Status: ${r.Status ?? "?"}${r.Priority ? ` · Priority: ${r.Priority}` : ""}`,
        r.Due_Date ? `Due: ${r.Due_Date}` : null,
        name(r.What_Id) ? `Related to: ${name(r.What_Id)}` : null,
        name(r.Owner) ? `Owner: ${name(r.Owner)}` : null,
        "",
        clip(htmlToText(r.Description ?? "")),
      ]
        .filter((x) => x !== null)
        .join("\n"),
    };
  }
  return {
    kind: "deal",
    title: r.Deal_Name ?? r.Subject ?? "(untitled)",
    text: [
      r.Stage ? `Stage: ${r.Stage}` : null,
      typeof r.Amount === "number" ? `Amount: ${Math.round(r.Amount)}` : null,
      r.Closing_Date ? `Closing: ${r.Closing_Date}` : null,
      name(r.Account_Name) ? `Account: ${name(r.Account_Name)}` : null,
      name(r.Owner) ? `Owner: ${name(r.Owner)}` : null,
      "",
      clip(htmlToText(r.Description ?? "")),
    ]
      .filter((x) => x !== null)
      .join("\n"),
  };
}

export const zohoCrmAdapter: NangoAdapter = {
  id: "zoho-crm",
  provider: "zoho-crm",
  sourceHint: "zoho-crm:records",
  async fetchChanges({ client, connectionId, connectionConfig, config, since, limit }) {
    const modules = allowList(config, "modules") ?? DEFAULT_MODULES;
    const baseUrlOverride = zohoApiBase(connectionConfig);
    const sinceIso = since.toISOString().replace(/\.\d{3}Z$/, "+00:00");
    const signals: IngestSignal[] = [];
    const stats: Record<string, number> = {};
    for (const module of modules.slice(0, 6)) {
      let page = 1;
      let more = true;
      while (more && signals.length < limit && page <= 3) {
        const res = await client.proxy<{ data?: ZohoRecord[]; info?: { more_records?: boolean } }>({
          method: "GET",
          providerConfigKey: "zoho-crm",
          connectionId,
          path: `/crm/v6/${module}`,
          query: { sort_by: "Modified_Time", sort_order: "desc", per_page: Math.min(100, limit), page },
          headers: { "If-Modified-Since": sinceIso },
          baseUrlOverride,
        });
        if (res.status === 304) break;
        if (!res.ok) throw new Error(`zoho crm ${module} failed (${res.status})`);
        const rows = res.data?.data ?? [];
        stats[module] = (stats[module] ?? 0) + rows.length;
        for (const r of rows) {
          if (r.Modified_Time && new Date(r.Modified_Time) <= since) {
            more = false;
            break;
          }
          const d = describe(module, r);
          signals.push({
            external_id: `${module.toLowerCase()}:${r.id}`,
            title: d.title,
            text: d.text,
            url: zohoCrmUrl(connectionConfig, module, r.id),
            author: name(r.Modified_By) || name(r.Owner) || undefined,
            at: r.Modified_Time ? new Date(r.Modified_Time).toISOString() : undefined,
            kind_hint: d.kind,
          });
          if (signals.length >= limit) break;
        }
        more = more && !!res.data?.info?.more_records;
        page += 1;
      }
      if (signals.length >= limit) break;
    }
    return { signals: signals.slice(0, limit), stats };
  },
};
