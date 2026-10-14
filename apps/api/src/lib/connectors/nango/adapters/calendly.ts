/**
 * Calendly — `calendly` → Nango `calendly` (OAuth2; proxy base
 * https://api.calendly.com). `/users/me` gives the user URI, then
 * `/scheduled_events` after `since` (active + canceled, newest first, ≤ 5
 * pages) and `/scheduled_events/{uuid}/invitees` for who booked and what
 * they answered. One signal per event: title, window, status, location,
 * invitees with their questions/answers, cancellation reason when any.
 * Cursor: `min_start_time` — Calendly has no "updated since" filter, so an
 * event cancelled after it started is only seen while it is still in the
 * window; that is the documented trade-off.
 */
import type { IngestSignal } from "@/lib/ingest/batch-extract";
import { clip, type NangoAdapter } from "./shared";

interface CalendlyEvent {
  uri: string;
  name?: string | null;
  status?: string | null;
  start_time?: string | null;
  end_time?: string | null;
  updated_at?: string | null;
  location?: { type?: string | null; location?: string | null; join_url?: string | null } | null;
  event_memberships?: Array<{ user_name?: string | null; user_email?: string | null }> | null;
  cancellation?: { canceled_by?: string | null; reason?: string | null } | null;
}

interface CalendlyInvitee {
  name?: string | null;
  email?: string | null;
  status?: string | null;
  questions_and_answers?: Array<{ question?: string | null; answer?: string | null }> | null;
}

interface Page<T> {
  collection?: T[];
  pagination?: { next_page_token?: string | null };
}

const MAX_PAGES = 5;

export function calendlyEventUuid(uri: string): string {
  return uri.split("/").filter(Boolean).pop() ?? uri;
}

export const calendlyAdapter: NangoAdapter = {
  id: "calendly",
  provider: "calendly",
  sourceHint: "calendly:scheduled_events",
  async fetchChanges({ client, connectionId, since, limit }) {
    const me = await client.proxy<{ resource?: { uri?: string; name?: string } }>({
      method: "GET",
      providerConfigKey: "calendly",
      connectionId,
      path: "/users/me",
    });
    if (!me.ok) throw new Error(`calendly users/me failed (${me.status})`);
    const userUri = me.data?.resource?.uri;
    if (!userUri) throw new Error("calendly users/me returned no uri");

    const signals: IngestSignal[] = [];
    const stats = { events: 0, invitees: 0 };
    let pageToken: string | undefined;
    let pages = 0;
    do {
      const res = await client.proxy<Page<CalendlyEvent>>({
        method: "GET",
        providerConfigKey: "calendly",
        connectionId,
        path: "/scheduled_events",
        query: {
          user: userUri,
          min_start_time: since.toISOString(),
          sort: "start_time:desc",
          count: Math.min(100, limit),
          ...(pageToken ? { page_token: pageToken } : {}),
        },
      });
      if (!res.ok) throw new Error(`calendly scheduled_events failed (${res.status})`);
      pages++;
      for (const ev of res.data?.collection ?? []) {
        const uuid = calendlyEventUuid(ev.uri);
        stats.events++;
        const inv = await client.proxy<Page<CalendlyInvitee>>({
          method: "GET",
          providerConfigKey: "calendly",
          connectionId,
          path: `/scheduled_events/${uuid}/invitees`,
          query: { count: 100 },
        });
        const invitees = inv.ok ? (inv.data?.collection ?? []) : [];
        stats.invitees += invitees.length;
        const hosts = (ev.event_memberships ?? [])
          .map((m) => m.user_name ?? m.user_email)
          .filter(Boolean)
          .join(", ");
        const inviteeLines = invitees.map((i) => {
          const qa = (i.questions_and_answers ?? [])
            .filter((x) => x.question && x.answer)
            .map((x) => `    - ${x.question}: ${x.answer}`)
            .join("\n");
          return `- ${i.name ?? "?"}${i.email ? ` <${i.email}>` : ""}${i.status ? ` (${i.status})` : ""}${qa ? `\n${qa}` : ""}`;
        });
        const location = ev.location?.join_url ?? ev.location?.location ?? ev.location?.type ?? "";
        signals.push({
          external_id: `event:${uuid}`,
          title: `${ev.name ?? "Meeting"} · ${ev.start_time ?? ""}`.trim(),
          text: clip(
            [
              `Status: ${ev.status ?? "?"} · ${ev.start_time ?? "?"} → ${ev.end_time ?? "?"}`,
              hosts ? `Host: ${hosts}` : null,
              location ? `Location: ${location}` : null,
              ev.cancellation
                ? `Cancelled by ${ev.cancellation.canceled_by ?? "?"}${ev.cancellation.reason ? `: ${ev.cancellation.reason}` : ""}`
                : null,
              inviteeLines.length ? `\nInvitees:\n${inviteeLines.join("\n")}` : null,
            ]
              .filter(Boolean)
              .join("\n"),
          ),
          url: `https://calendly.com/scheduled_events/${uuid}`,
          author: hosts || undefined,
          at: ev.updated_at ?? ev.start_time ?? undefined,
          kind_hint: "meeting",
        });
        if (signals.length >= limit) break;
      }
      pageToken = res.data?.pagination?.next_page_token ?? undefined;
    } while (pageToken && pages < MAX_PAGES && signals.length < limit);
    return { signals: signals.slice(0, limit), stats };
  },
};
