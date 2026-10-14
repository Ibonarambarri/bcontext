/**
 * HubSpot — `hubspot` → Nango `hubspot` (OAuth2; proxy base
 * https://api.hubapi.com). CRM v3 search over deals and the engagements
 * where commitments are written down — notes, calls, meetings — filtered by
 * `hs_lastmodifieddate` since the cursor. Capped to ~100 objects per run.
 *
 * Install config: `portal_id` (only used to build links back to HubSpot).
 */
import type { IngestSignal } from "@/lib/ingest/batch-extract";
import { clip, configString, htmlToText, type NangoAdapter } from "./shared";

interface HubSpotObject {
  id: string;
  properties?: Record<string, string | null>;
}

interface SearchSpec {
  object: "deals" | "notes" | "calls" | "meetings";
  properties: string[];
  title: (p: Record<string, string | null>) => string;
  body: (p: Record<string, string | null>) => string;
  kind: string;
}

const SEARCHES: SearchSpec[] = [
  {
    object: "deals",
    properties: ["dealname", "amount", "dealstage", "pipeline", "closedate", "description", "hs_lastmodifieddate", "hubspot_owner_id"],
    title: (p) => p.dealname ?? "Deal",
    body: (p) => [`Stage: ${p.dealstage ?? "?"}${p.amount ? ` · Amount: ${p.amount}` : ""}${p.closedate ? ` · Close: ${p.closedate}` : ""}`, "", p.description ?? ""].join("\n"),
    kind: "deal",
  },
  {
    object: "notes",
    properties: ["hs_note_body", "hs_timestamp", "hs_lastmodifieddate"],
    title: () => "Note",
    body: (p) => htmlToText(p.hs_note_body ?? ""),
    kind: "note",
  },
  {
    object: "calls",
    properties: ["hs_call_title", "hs_call_body", "hs_call_disposition", "hs_timestamp", "hs_lastmodifieddate"],
    title: (p) => p.hs_call_title ?? "Call",
    body: (p) => htmlToText(p.hs_call_body ?? ""),
    kind: "call",
  },
  {
    object: "meetings",
    properties: ["hs_meeting_title", "hs_meeting_body", "hs_internal_meeting_notes", "hs_meeting_outcome", "hs_timestamp", "hs_lastmodifieddate"],
    title: (p) => p.hs_meeting_title ?? "Meeting",
    body: (p) => [htmlToText(p.hs_meeting_body ?? ""), htmlToText(p.hs_internal_meeting_notes ?? "")].filter(Boolean).join("\n\n"),
    kind: "meeting",
  },
];

export const hubspotAdapter: NangoAdapter = {
  id: "hubspot",
  provider: "hubspot",
  sourceHint: "hubspot:crm",
  async fetchChanges({ client, connectionId, config, since, limit }) {
    const portal = configString(config, "portal_id");
    const signals: IngestSignal[] = [];
    const perObject = Math.max(10, Math.min(50, Math.floor(limit / SEARCHES.length)));
    const stats: Record<string, number> = {};
    for (const spec of SEARCHES) {
      const res = await client.proxy<{ results?: HubSpotObject[] }>({
        method: "POST",
        providerConfigKey: "hubspot",
        connectionId,
        path: `/crm/v3/objects/${spec.object}/search`,
        body: {
          filterGroups: [{ filters: [{ propertyName: "hs_lastmodifieddate", operator: "GTE", value: String(since.getTime()) }] }],
          sorts: [{ propertyName: "hs_lastmodifieddate", direction: "DESCENDING" }],
          properties: spec.properties,
          limit: perObject,
        },
      });
      if (!res.ok) throw new Error(`hubspot ${spec.object} search failed (${res.status})`);
      const rows = res.data?.results ?? [];
      stats[spec.object] = rows.length;
      for (const row of rows) {
        const p = row.properties ?? {};
        const body = clip(spec.body(p).trim());
        if (!body && spec.object !== "deals") continue;
        signals.push({
          external_id: `${spec.object}:${row.id}`,
          title: spec.title(p),
          text: body,
          url: portal ? `https://app.hubspot.com/contacts/${portal}/${spec.object === "deals" ? "deal" : "record/0-" + spec.object}/${row.id}` : undefined,
          at: p.hs_lastmodifieddate ?? p.hs_timestamp ?? undefined,
          kind_hint: spec.kind,
        });
        if (signals.length >= limit) break;
      }
      if (signals.length >= limit) break;
    }
    return { signals: signals.slice(0, limit), stats };
  },
};
