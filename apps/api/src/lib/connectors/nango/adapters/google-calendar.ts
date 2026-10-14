/**
 * Google Calendar — `google-calendar` → Nango `google-calendar` (OAuth2 via
 * `google`; proxy base https://www.googleapis.com). Events created or
 * updated since the cursor on the calendars in `config.calendar_ids`
 * (default: `primary`). Only events that carry something to learn from — a
 * description or attendees — become signals.
 */
import type { IngestSignal } from "@/lib/ingest/batch-extract";
import { allowList, clip, htmlToText, type NangoAdapter } from "./shared";

interface CalendarEvent {
  id: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  htmlLink?: string;
  hangoutLink?: string;
  updated?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  organizer?: { email?: string; displayName?: string };
  attendees?: Array<{ email?: string; displayName?: string; responseStatus?: string; organizer?: boolean }>;
}

function when(ev: CalendarEvent): string {
  const s = ev.start?.dateTime ?? ev.start?.date ?? "";
  const e = ev.end?.dateTime ?? ev.end?.date ?? "";
  return e ? `${s} → ${e}` : s;
}

export const googleCalendarAdapter: NangoAdapter = {
  id: "google-calendar",
  provider: "google-calendar",
  sourceHint: "google-calendar:events",
  async fetchChanges({ client, connectionId, config, since, limit }) {
    const calendars = allowList(config, "calendar_ids") ?? ["primary"];
    const signals: IngestSignal[] = [];
    let pages = 0;
    let skipped = 0;
    for (const calendarId of calendars.slice(0, 5)) {
      let pageToken: string | undefined;
      do {
        const res = await client.proxy<{ items?: CalendarEvent[]; nextPageToken?: string }>({
          method: "GET",
          providerConfigKey: "google-calendar",
          connectionId,
          path: `/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
          query: {
            updatedMin: since.toISOString(),
            singleEvents: true,
            orderBy: "updated",
            showDeleted: false,
            maxResults: Math.min(50, limit),
            ...(pageToken ? { pageToken } : {}),
          },
        });
        if (!res.ok) throw new Error(`google calendar events.list failed (${res.status})`);
        for (const ev of res.data?.items ?? []) {
          if (ev.status === "cancelled") continue;
          const attendees = (ev.attendees ?? []).map((a) => a.displayName ?? a.email ?? "").filter(Boolean);
          if (!ev.description && attendees.length === 0) {
            skipped += 1;
            continue;
          }
          const organizer = ev.organizer?.displayName ?? ev.organizer?.email;
          signals.push({
            external_id: `event:${calendarId}:${ev.id}`,
            title: ev.summary ?? "(untitled event)",
            text: [
              `When: ${when(ev)}`,
              organizer ? `Organizer: ${organizer}` : null,
              attendees.length ? `Attendees: ${attendees.join(", ")}` : null,
              ev.location ? `Where: ${ev.location}` : null,
              ev.hangoutLink ? `Call: ${ev.hangoutLink}` : null,
              "",
              clip(htmlToText(ev.description ?? "")),
            ]
              .filter((x) => x !== null)
              .join("\n"),
            url: ev.htmlLink,
            author: organizer,
            at: ev.updated,
            kind_hint: "event",
          });
          if (signals.length >= limit) break;
        }
        pageToken = res.data?.nextPageToken;
        pages += 1;
      } while (pageToken && signals.length < limit && pages < 5);
      if (signals.length >= limit) break;
    }
    return { signals: signals.slice(0, limit), stats: { pages, skipped } };
  },
};
