/**
 * Cal.com — `cal-com` → Nango `cal-com-v2` (API_KEY; proxy base
 * https://api.cal.com/v2, header `cal-api-version: 2024-08-13`).
 * `/bookings?afterStart=<since>&status=upcoming,past,cancelled` newest
 * first, ≤ 5 pages of 100. One signal per booking: title, window, status,
 * hosts, attendees, booking-form responses and the cancellation reason.
 * Cursor is `afterStart` (bookings that start after `since`); the API has
 * no "updated since", same trade-off as Calendly.
 */
import type { IngestSignal } from "@/lib/ingest/batch-extract";
import { clip, type NangoAdapter } from "./shared";

export const CAL_API_VERSION = "2024-08-13";

interface CalBooking {
  id?: number | string;
  uid: string;
  title?: string | null;
  description?: string | null;
  status?: string | null;
  start?: string | null;
  end?: string | null;
  updatedAt?: string | null;
  createdAt?: string | null;
  location?: string | null;
  meetingUrl?: string | null;
  cancellationReason?: string | null;
  hosts?: Array<{ name?: string | null; email?: string | null }> | null;
  attendees?: Array<{ name?: string | null; email?: string | null }> | null;
  bookingFieldsResponses?: Record<string, unknown> | null;
}

interface BookingsResponse {
  status?: string;
  data?: CalBooking[];
  pagination?: { hasNextPage?: boolean; nextCursor?: number | string | null };
}

const MAX_PAGES = 5;
const SKIP_FIELDS = new Set(["name", "email", "guests", "rescheduleReason", "location"]);

function responsesToLines(r: Record<string, unknown> | null | undefined): string[] {
  if (!r) return [];
  return Object.entries(r)
    .filter(([k, v]) => !SKIP_FIELDS.has(k) && v != null && String(v).trim() !== "")
    .map(([k, v]) => `    - ${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`);
}

export const calComAdapter: NangoAdapter = {
  id: "cal-com",
  provider: "cal-com-v2",
  sourceHint: "cal-com:bookings",
  async fetchChanges({ client, connectionId, since, limit }) {
    const signals: IngestSignal[] = [];
    const stats = { bookings: 0 };
    let skip = 0;
    let pages = 0;
    for (;;) {
      const res = await client.proxy<BookingsResponse>({
        method: "GET",
        providerConfigKey: "cal-com",
        connectionId,
        path: "/bookings",
        headers: { "cal-api-version": CAL_API_VERSION },
        query: {
          afterStart: since.toISOString(),
          status: "upcoming,past,cancelled",
          sortStart: "desc",
          take: Math.min(100, limit),
          skip,
        },
      });
      if (!res.ok) throw new Error(`cal.com bookings failed (${res.status})`);
      pages++;
      const rows = res.data?.data ?? [];
      stats.bookings += rows.length;
      for (const b of rows) {
        const hosts = (b.hosts ?? []).map((h) => h.name ?? h.email).filter(Boolean).join(", ");
        const attendees = (b.attendees ?? [])
          .map((a) => `- ${a.name ?? "?"}${a.email ? ` <${a.email}>` : ""}`)
          .join("\n");
        const responses = responsesToLines(b.bookingFieldsResponses);
        signals.push({
          external_id: `booking:${b.uid}`,
          title: `${b.title ?? "Booking"} · ${b.start ?? ""}`.trim(),
          text: clip(
            [
              `Status: ${b.status ?? "?"} · ${b.start ?? "?"} → ${b.end ?? "?"}`,
              hosts ? `Host: ${hosts}` : null,
              b.location || b.meetingUrl ? `Location: ${b.meetingUrl ?? b.location}` : null,
              b.cancellationReason ? `Cancellation reason: ${b.cancellationReason}` : null,
              b.description ? `\n${b.description}` : null,
              attendees ? `\nAttendees:\n${attendees}` : null,
              responses.length ? `\nResponses:\n${responses.join("\n")}` : null,
            ]
              .filter(Boolean)
              .join("\n"),
          ),
          url: `https://app.cal.com/booking/${b.uid}`,
          author: hosts || undefined,
          at: b.updatedAt ?? b.createdAt ?? b.start ?? undefined,
          kind_hint: "meeting",
        });
        if (signals.length >= limit) break;
      }
      const more = !!res.data?.pagination?.hasNextPage && rows.length > 0;
      if (!more || signals.length >= limit || pages >= MAX_PAGES) break;
      skip += rows.length;
    }
    return { signals: signals.slice(0, limit), stats };
  },
};
