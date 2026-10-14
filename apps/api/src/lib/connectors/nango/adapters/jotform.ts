/**
 * Jotform — `jotform` → Nango `jotform` (API_KEY; proxy base
 * https://api.jotform.com, Nango injects the `apikey` header).
 * `/user/submissions` newest first with the `created_at:gt` filter Jotform
 * documents (`YYYY-MM-DD HH:MM:SS`, account timezone — UTC is close
 * enough for a "since" window), offset-paged (≤ 5 pages), plus
 * `/user/forms` once for titles. One signal per submission with
 * "Question: answer" lines (`prettyFormat` when Jotform provides it).
 * `config.form_ids` narrows to some forms.
 */
import type { IngestSignal } from "@/lib/ingest/batch-extract";
import { allowList, clip, str, type NangoAdapter } from "./shared";

interface JotformAnswer {
  name?: string;
  text?: string;
  type?: string;
  answer?: unknown;
  prettyFormat?: string;
}

interface JotformSubmission {
  id: string;
  form_id?: string;
  created_at?: string;
  updated_at?: string | null;
  status?: string;
  ip?: string;
  answers?: Record<string, JotformAnswer>;
}

interface JotformEnvelope<T> {
  responseCode?: number;
  content?: T;
  resultSet?: { offset?: number; limit?: number; count?: number };
}

const MAX_PAGES = 5;
const PAGE = 100;

/** Jotform's filter timestamps: "YYYY-MM-DD HH:MM:SS". */
export function jotformDate(d: Date): string {
  return d.toISOString().slice(0, 19).replace("T", " ");
}

/** "2026-09-01 10:00:00" (Jotform, no zone) → ISO, read as UTC. */
export function jotformToIso(s: string | undefined): string | undefined {
  if (!s) return undefined;
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/.exec(s);
  return m ? `${m[1]}T${m[2]}Z` : s;
}

export function jotformAnswerText(a: JotformAnswer): string {
  if (a.prettyFormat) return str(a.prettyFormat);
  const v = a.answer;
  if (v == null) return "";
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return v.map(str).filter(Boolean).join(", ");
  if (typeof v === "object") {
    return Object.entries(v as Record<string, unknown>)
      .map(([k, x]) => `${k}: ${str(x)}`)
      .join(", ");
  }
  return "";
}

export const jotformAdapter: NangoAdapter = {
  id: "jotform",
  provider: "jotform",
  sourceHint: "jotform:submissions",
  async fetchChanges({ client, connectionId, config, since, limit }) {
    const wanted = allowList(config, "form_ids");
    const forms = await client.proxy<JotformEnvelope<Array<{ id: string; title?: string }>>>({
      method: "GET",
      providerConfigKey: "jotform",
      connectionId,
      path: "/user/forms",
      query: { limit: 500 },
    });
    const titles = new Map<string, string>();
    for (const f of forms.ok ? (forms.data?.content ?? []) : []) if (f.id) titles.set(f.id, f.title ?? f.id);

    const signals: IngestSignal[] = [];
    const stats = { submissions: 0, skipped: 0 };
    let offset = 0;
    let pages = 0;
    do {
      const res = await client.proxy<JotformEnvelope<JotformSubmission[]>>({
        method: "GET",
        providerConfigKey: "jotform",
        connectionId,
        path: "/user/submissions",
        query: {
          limit: PAGE,
          offset,
          orderby: "created_at",
          direction: "DESC",
          filter: JSON.stringify({ "created_at:gt": jotformDate(since) }),
        },
      });
      if (!res.ok) throw new Error(`jotform submissions failed (${res.status})`);
      pages++;
      const rows = res.data?.content ?? [];
      for (const s of rows) {
        if (wanted && (!s.form_id || !wanted.includes(s.form_id))) {
          stats.skipped++;
          continue;
        }
        stats.submissions++;
        const formTitle = (s.form_id && titles.get(s.form_id)) || s.form_id || "form";
        const lines = Object.values(s.answers ?? {})
          .map((a) => ({ q: a.text ?? a.name ?? "?", v: jotformAnswerText(a) }))
          .filter((x) => x.v)
          .map((x) => `- ${x.q}: ${x.v}`);
        signals.push({
          external_id: `submission:${s.id}`,
          title: `${formTitle} · submission ${s.created_at ?? s.id}`,
          text: clip([`Form: ${formTitle}`, `Status: ${s.status ?? "?"}`, lines.length ? `\nAnswers:\n${lines.join("\n")}` : null].filter(Boolean).join("\n")),
          url: s.form_id ? `https://www.jotform.com/inbox/${s.form_id}/${s.id}` : `https://www.jotform.com/edit/${s.id}`,
          at: jotformToIso(s.created_at),
          kind_hint: "form_response",
        });
        if (signals.length >= limit) break;
      }
      offset += rows.length;
      if (rows.length < PAGE) break;
    } while (pages < MAX_PAGES && signals.length < limit);
    return { signals: signals.slice(0, limit), stats };
  },
};
