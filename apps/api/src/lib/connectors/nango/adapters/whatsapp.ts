/**
 * WhatsApp Business — `whatsapp` → Nango `whatsapp-business` (API_KEY: a
 * system-user access token; proxy https://graph.facebook.com).
 *
 * What this adapter can and cannot read: the Cloud API exposes NO message
 * history over GET — inbound and outbound messages only arrive through the
 * webhook subscription, which is a separate path (not built here). What is
 * readable is the account itself: the phone numbers (quality rating, name
 * status) and the message templates with their status, category and text.
 * Those have no "updated since" filter, so every run stamps them `at =
 * since` with stable ids; the graph's (source, external_id) dedupe keeps an
 * unchanged template from becoming a new candidate each day.
 *
 * `config.waba_id` (WhatsApp Business Account id) is required.
 */
import type { IngestSignal } from "@/lib/ingest/batch-extract";
import { clip, configString, type NangoAdapter } from "./shared";

export const GRAPH_VERSION = "v21.0";

interface WaPhoneNumber {
  id: string;
  display_phone_number?: string;
  verified_name?: string;
  quality_rating?: string;
  name_status?: string;
  code_verification_status?: string;
}

interface WaTemplateComponent {
  type?: string;
  format?: string;
  text?: string;
  buttons?: Array<{ type?: string; text?: string; url?: string }>;
}

interface WaTemplate {
  id: string;
  name?: string;
  status?: string;
  category?: string;
  language?: string;
  components?: WaTemplateComponent[];
  rejected_reason?: string;
}

interface GraphPage<T> {
  data?: T[];
  paging?: { cursors?: { after?: string }; next?: string };
}

const MAX_TEMPLATE_PAGES = 3;

export function templateText(components: WaTemplateComponent[] | undefined): string {
  const lines: string[] = [];
  for (const c of components ?? []) {
    const label = (c.type ?? "").toLowerCase();
    if (c.text) lines.push(`${label ? `${label}: ` : ""}${c.text}`);
    else if (c.format) lines.push(`${label}: <${c.format.toLowerCase()}>`);
    for (const b of c.buttons ?? []) {
      lines.push(`button (${b.type?.toLowerCase() ?? "?"}): ${b.text ?? ""}${b.url ? ` → ${b.url}` : ""}`);
    }
  }
  return lines.join("\n");
}

export const whatsappAdapter: NangoAdapter = {
  id: "whatsapp",
  provider: "whatsapp-business",
  sourceHint: "whatsapp:account",
  async fetchChanges({ client, connectionId, config, since, limit }) {
    const wabaId = configString(config, "waba_id");
    if (!wabaId) return { signals: [], stats: { missing_waba_id: 1 } as Record<string, number> };
    const at = since.toISOString();
    const signals: IngestSignal[] = [];

    const numbers = await client.proxy<GraphPage<WaPhoneNumber>>({
      method: "GET",
      providerConfigKey: "whatsapp",
      connectionId,
      path: `/${GRAPH_VERSION}/${wabaId}/phone_numbers`,
      query: { fields: "display_phone_number,verified_name,quality_rating,name_status,code_verification_status" },
    });
    if (!numbers.ok) throw new Error(`whatsapp phone_numbers failed (${numbers.status})`);
    for (const n of numbers.data?.data ?? []) {
      signals.push({
        external_id: `phone:${n.id}:${n.quality_rating ?? "?"}:${n.name_status ?? "?"}`,
        title: `WhatsApp number ${n.display_phone_number ?? n.id}${n.verified_name ? ` · ${n.verified_name}` : ""}`,
        text: [
          `Quality rating: ${n.quality_rating ?? "?"}`,
          `Name status: ${n.name_status ?? "?"}`,
          `Verification: ${n.code_verification_status ?? "?"}`,
        ].join("\n"),
        at,
        kind_hint: "phone_number",
      });
    }

    let after: string | undefined;
    let pages = 0;
    do {
      const res = await client.proxy<GraphPage<WaTemplate>>({
        method: "GET",
        providerConfigKey: "whatsapp",
        connectionId,
        path: `/${GRAPH_VERSION}/${wabaId}/message_templates`,
        query: { fields: "name,status,category,language,components,rejected_reason", limit: 100, ...(after ? { after } : {}) },
      });
      if (!res.ok) throw new Error(`whatsapp message_templates failed (${res.status})`);
      pages += 1;
      for (const t of res.data?.data ?? []) {
        signals.push({
          external_id: `template:${t.id}:${t.status ?? "?"}`,
          title: `Template ${t.name ?? t.id} (${t.language ?? "?"}) · ${t.status ?? "?"}`,
          text: clip(
            [
              `Category: ${t.category ?? "?"} · Status: ${t.status ?? "?"}${t.rejected_reason && t.rejected_reason !== "NONE" ? ` · Rejected: ${t.rejected_reason}` : ""}`,
              "",
              templateText(t.components),
            ].join("\n"),
          ),
          at,
          kind_hint: "template",
        });
        if (signals.length >= limit) break;
      }
      after = res.data?.paging?.next ? res.data?.paging?.cursors?.after : undefined;
    } while (after && pages < MAX_TEMPLATE_PAGES && signals.length < limit);

    return { signals: signals.slice(0, limit), stats: { template_pages: pages, signals: signals.length } };
  },
};
