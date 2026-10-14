/**
 * Freshdesk — `freshdesk` → Nango `freshdesk` (BASIC: API key as username;
 * connection_config.subdomain). Tickets updated since the cursor with their
 * plain-text description.
 */
import type { IngestSignal } from "@/lib/ingest/batch-extract";
import { subdomain, type NangoAdapter } from "./shared";

interface FreshdeskTicket {
  id: number;
  subject?: string;
  description_text?: string;
  status?: number;
  priority?: number;
  type?: string | null;
  tags?: string[];
  updated_at?: string;
  requester_id?: number;
}

const FRESHDESK_STATUS: Record<number, string> = { 2: "Open", 3: "Pending", 4: "Resolved", 5: "Closed" };

export const freshdeskAdapter: NangoAdapter = {
  id: "freshdesk",
  provider: "freshdesk",
  sourceHint: "freshdesk:tickets",
  async fetchChanges({ client, connectionId, connectionConfig, since, limit }) {
    const signals: IngestSignal[] = [];
    let page = 1;
    do {
      const res = await client.proxy<FreshdeskTicket[]>({
        method: "GET",
        providerConfigKey: "freshdesk",
        connectionId,
        path: "/api/v2/tickets",
        query: {
          updated_since: since.toISOString(),
          order_by: "updated_at",
          order_type: "desc",
          include: "description",
          per_page: Math.min(100, limit),
          page,
        },
      });
      if (!res.ok) throw new Error(`freshdesk tickets failed (${res.status})`);
      const tickets = Array.isArray(res.data) ? res.data : [];
      for (const t of tickets) {
        signals.push({
          external_id: `ticket:${t.id}`,
          title: `#${t.id} · ${t.subject ?? ""}`.trim(),
          text: [
            `Status: ${FRESHDESK_STATUS[t.status ?? 0] ?? t.status ?? "?"} · Priority: ${t.priority ?? "?"}${t.type ? ` · Type: ${t.type}` : ""}`,
            t.tags?.length ? `Tags: ${t.tags.join(", ")}` : null,
            "",
            t.description_text ?? "",
          ]
            .filter((x) => x !== null)
            .join("\n"),
          url: subdomain(connectionConfig) ? `https://${subdomain(connectionConfig)}.freshdesk.com/a/tickets/${t.id}` : undefined,
          at: t.updated_at,
          kind_hint: "ticket",
        });
      }
      if (tickets.length < Math.min(100, limit)) break;
      page += 1;
    } while (signals.length < limit && page <= 5);
    return { signals: signals.slice(0, limit), stats: { pages: page } };
  },
};
