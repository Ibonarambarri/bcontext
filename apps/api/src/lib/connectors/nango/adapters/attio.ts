/**
 * Attio — `attio` → Nango `attio` (OAuth2; proxy base https://api.attio.com).
 *
 * Records of the objects in `config.objects` (default deals + companies)
 * through `POST /v2/objects/{object}/records/query`. Attio has no
 * server-side "updated since" filter on records: the query is sorted by
 * `created_at` desc and every record's last change is derived from the
 * newest `active_from` across its attribute values — the moment an
 * attribute took its current value. Records whose last change is at/before
 * the cursor are skipped; paging stops after a few pages.
 *
 * Notes come from `GET /v2/notes` (newest first, `content_plaintext`),
 * filtered by `created_at`.
 *
 * Attribute values are flattened generically (text, numbers, currency,
 * select options, statuses, names, emails, domains, record references) so a
 * new attribute needs no code here.
 */
import type { IngestSignal } from "@/lib/ingest/batch-extract";
import { allowList, clip, type NangoAdapter } from "./shared";

type AttioValue = Record<string, unknown> & { active_from?: string; active_until?: string | null };

interface AttioRecord {
  id?: { workspace_id?: string; object_id?: string; record_id?: string };
  created_at?: string;
  web_url?: string;
  values?: Record<string, AttioValue[]>;
}

interface AttioNote {
  id?: { note_id?: string };
  parent_object?: string;
  parent_record_id?: string;
  title?: string;
  content_plaintext?: string;
  created_at?: string;
  created_by_actor?: { type?: string; id?: string | null; name?: string };
}

const PAGE = 50;
const MAX_PAGES = 4;
const DEFAULT_OBJECTS = ["deals", "companies"];

/** One attribute value → a short human string, or "" when there is nothing to say. */
export function attioValueText(v: AttioValue): string {
  const s = (x: unknown) => (x == null ? "" : String(x)).trim();
  if (v.full_name) return s(v.full_name);
  if (v.option && typeof v.option === "object") return s((v.option as { title?: string }).title);
  if (v.status && typeof v.status === "object") return s((v.status as { title?: string }).title);
  if (v.currency_value != null) return `${s(v.currency_value)} ${s(v.currency_code)}`.trim();
  if (v.email_address) return s(v.email_address);
  if (v.domain) return s(v.domain);
  if (v.phone_number) return s(v.phone_number);
  if (v.target_record_id) return `→ ${s(v.target_object)}/${s(v.target_record_id)}`;
  if (v.referenced_actor_id) return s(v.referenced_actor_type) === "workspace-member" ? `member ${s(v.referenced_actor_id)}` : s(v.referenced_actor_id);
  if (v.value != null && typeof v.value !== "object") return s(v.value);
  return "";
}

/** Latest `active_from` across the record's current values (its last change), or its created_at. */
export function attioUpdatedAt(record: AttioRecord): string | undefined {
  let latest: string | undefined = record.created_at;
  for (const values of Object.values(record.values ?? {})) {
    for (const v of values) {
      if (v.active_from && (!latest || v.active_from > latest)) latest = v.active_from;
    }
  }
  return latest;
}

export function attioRecordText(record: AttioRecord): { title: string; text: string } {
  const lines: string[] = [];
  let title = "";
  for (const [slug, values] of Object.entries(record.values ?? {})) {
    const current = values.filter((v) => !v.active_until);
    const rendered = current.map(attioValueText).filter(Boolean);
    if (!rendered.length) continue;
    const label = slug.replace(/_/g, " ");
    if (slug === "name" && !title) title = rendered[0] ?? "";
    lines.push(`${label}: ${rendered.join(", ")}`);
  }
  return { title, text: lines.join("\n") };
}

export const attioAdapter: NangoAdapter = {
  id: "attio",
  provider: "attio",
  sourceHint: "attio:crm",
  async fetchChanges({ client, connectionId, config, since, limit }) {
    const objects = allowList(config, "objects") ?? DEFAULT_OBJECTS;
    const signals: IngestSignal[] = [];
    const stats: Record<string, number> = { notes: 0 };
    const sinceIso = since.toISOString();

    for (const object of objects.slice(0, 6)) {
      stats[object] = 0;
      for (let page = 0; page < MAX_PAGES && signals.length < limit; page++) {
        const res = await client.proxy<{ data?: AttioRecord[] }>({
          method: "POST",
          providerConfigKey: "attio",
          connectionId,
          path: `/v2/objects/${encodeURIComponent(object)}/records/query`,
          body: { sorts: [{ attribute: "created_at", direction: "desc" }], limit: PAGE, offset: page * PAGE },
        });
        if (!res.ok) throw new Error(`attio ${object} query failed (${res.status})`);
        const rows = res.data?.data ?? [];
        let fresh = 0;
        for (const r of rows) {
          const at = attioUpdatedAt(r);
          if (!at || at <= sinceIso) continue;
          fresh++;
          const id = r.id?.record_id ?? "";
          if (!id) continue;
          const { title, text } = attioRecordText(r);
          if (!text) continue;
          stats[object] = (stats[object] ?? 0) + 1;
          signals.push({
            external_id: `${object}:${id}`,
            title: title || `${object.replace(/s$/, "")} ${id.slice(0, 8)}`,
            text: clip(text),
            url: r.web_url,
            at,
            kind_hint: object.replace(/s$/, ""),
          });
          if (signals.length >= limit) break;
        }
        // Sorted by creation only: keep paging while the page still holds
        // recent activity; a page with nothing fresh means the rest is stale.
        if (rows.length < PAGE || fresh === 0) break;
      }
    }

    for (let page = 0; page < MAX_PAGES && signals.length < limit; page++) {
      const res = await client.proxy<{ data?: AttioNote[] }>({
        method: "GET",
        providerConfigKey: "attio",
        connectionId,
        path: "/v2/notes",
        query: { limit: PAGE, offset: page * PAGE },
      });
      if (!res.ok) throw new Error(`attio notes failed (${res.status})`);
      const rows = res.data?.data ?? [];
      let stop = false;
      for (const n of rows) {
        if (n.created_at && n.created_at <= sinceIso) {
          stop = true;
          break;
        }
        const body = (n.content_plaintext ?? "").trim();
        if (!body) continue;
        stats.notes = (stats.notes ?? 0) + 1;
        signals.push({
          external_id: `note:${n.id?.note_id ?? `${n.parent_object}:${n.parent_record_id}:${n.created_at}`}`,
          title: n.title?.trim() || `Note on ${n.parent_object ?? "record"}`,
          text: clip([`On: ${n.parent_object ?? "?"}/${n.parent_record_id ?? "?"}`, "", body].join("\n")),
          author: n.created_by_actor?.name ?? undefined,
          at: n.created_at,
          kind_hint: "note",
        });
        if (signals.length >= limit) break;
      }
      if (stop || rows.length < PAGE) break;
    }

    return { signals: signals.slice(0, limit), stats };
  },
};
