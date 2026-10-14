/**
 * Typeform — `typeform` → Nango `typeform` (OAuth2; proxy base
 * https://${connectionConfig.apiHost} || https://api.typeform.com).
 * Lists the account's forms (or `config.form_ids`), pulls the fields of
 * each so answers carry the question title, then `/forms/{id}/responses`
 * completed after `since` (newest first, ≤ 5 pages per form). One signal
 * per response: "Question: answer" lines, hidden fields, referer.
 * Cursor: `since` on `submitted_at` — Typeform supports it natively.
 */
import type { IngestSignal } from "@/lib/ingest/batch-extract";
import { allowList, clip, str, type NangoAdapter } from "./shared";

interface TypeformForm {
  id: string;
  title?: string;
  _links?: { display?: string };
}

interface TypeformField {
  id: string;
  ref?: string;
  title?: string;
  type?: string;
  properties?: { fields?: TypeformField[] };
}

interface TypeformAnswer {
  field?: { id?: string; ref?: string; type?: string };
  type?: string;
  text?: string;
  email?: string;
  url?: string;
  number?: number;
  boolean?: boolean;
  date?: string;
  file_url?: string;
  phone_number?: string;
  choice?: { label?: string; other?: string };
  choices?: { labels?: string[]; other?: string };
  payment?: { amount?: string; name?: string };
}

interface TypeformResponse {
  response_id: string;
  landed_at?: string;
  submitted_at?: string;
  hidden?: Record<string, string>;
  metadata?: { referer?: string; platform?: string };
  answers?: TypeformAnswer[];
}

interface Page<T> {
  items?: T[];
  page_count?: number;
  total_items?: number;
}

const MAX_PAGES = 5;
const MAX_FORMS = 25;

/** Flatten a Typeform answer to a string an LLM can read. */
export function typeformAnswerText(a: TypeformAnswer): string {
  if (a.text != null) return a.text;
  if (a.email != null) return a.email;
  if (a.url != null) return a.url;
  if (a.phone_number != null) return a.phone_number;
  if (a.file_url != null) return a.file_url;
  if (a.date != null) return a.date;
  if (a.number != null) return String(a.number);
  if (a.boolean != null) return a.boolean ? "yes" : "no";
  if (a.choice) return a.choice.label ?? a.choice.other ?? "";
  if (a.choices) return [...(a.choices.labels ?? []), ...(a.choices.other ? [a.choices.other] : [])].join(", ");
  if (a.payment) return `${a.payment.amount ?? ""} ${a.payment.name ?? ""}`.trim();
  return "";
}

function flattenFields(fields: TypeformField[] | undefined, out: Map<string, string>): Map<string, string> {
  for (const f of fields ?? []) {
    if (f.id && f.title) out.set(f.id, f.title);
    if (f.ref && f.title) out.set(`ref:${f.ref}`, f.title);
    flattenFields(f.properties?.fields, out);
  }
  return out;
}

export const typeformAdapter: NangoAdapter = {
  id: "typeform",
  provider: "typeform",
  sourceHint: "typeform:responses",
  async fetchChanges({ client, connectionId, config, since, limit }) {
    const wanted = allowList(config, "form_ids");
    const listed = await client.proxy<Page<TypeformForm>>({
      method: "GET",
      providerConfigKey: "typeform",
      connectionId,
      path: "/forms",
      query: { page_size: 200 },
    });
    if (!listed.ok) throw new Error(`typeform forms failed (${listed.status})`);
    const forms = (listed.data?.items ?? [])
      .filter((f) => !wanted || wanted.includes(f.id))
      .slice(0, MAX_FORMS);

    const signals: IngestSignal[] = [];
    const stats = { forms: forms.length, responses: 0 };
    for (const form of forms) {
      const detail = await client.proxy<{ fields?: TypeformField[]; title?: string }>({
        method: "GET",
        providerConfigKey: "typeform",
        connectionId,
        path: `/forms/${encodeURIComponent(form.id)}`,
      });
      const titles = flattenFields(detail.ok ? detail.data?.fields : [], new Map());
      const formTitle = form.title ?? detail.data?.title ?? form.id;

      let before: string | undefined;
      let pages = 0;
      do {
        const res = await client.proxy<Page<TypeformResponse>>({
          method: "GET",
          providerConfigKey: "typeform",
          connectionId,
          path: `/forms/${encodeURIComponent(form.id)}/responses`,
          query: {
            since: since.toISOString(),
            page_size: Math.min(100, limit),
            completed: true,
            sort: "submitted_at,desc",
            ...(before ? { before } : {}),
          },
        });
        if (!res.ok) throw new Error(`typeform responses failed (${res.status})`);
        pages++;
        const items = res.data?.items ?? [];
        for (const r of items) {
          stats.responses++;
          const lines = (r.answers ?? []).map((a) => {
            const q = (a.field?.id && titles.get(a.field.id)) || (a.field?.ref && titles.get(`ref:${a.field.ref}`)) || a.field?.ref || a.field?.id || "?";
            return `- ${q}: ${typeformAnswerText(a)}`;
          });
          const hidden = Object.entries(r.hidden ?? {}).map(([k, v]) => `- ${k}: ${str(v)}`);
          signals.push({
            external_id: `response:${r.response_id}`,
            title: `${formTitle} · response ${r.submitted_at ?? r.response_id}`,
            text: clip(
              [
                `Form: ${formTitle}`,
                r.metadata?.referer ? `Referer: ${r.metadata.referer}` : null,
                lines.length ? `\nAnswers:\n${lines.join("\n")}` : null,
                hidden.length ? `\nHidden fields:\n${hidden.join("\n")}` : null,
              ]
                .filter(Boolean)
                .join("\n"),
            ),
            url: form._links?.display ?? `https://admin.typeform.com/form/${form.id}/results`,
            at: r.submitted_at ?? r.landed_at,
            kind_hint: "form_response",
          });
          if (signals.length >= limit) break;
        }
        before = items.length && items.length >= Math.min(100, limit) ? items[items.length - 1]?.response_id : undefined;
      } while (before && pages < MAX_PAGES && signals.length < limit);
      if (signals.length >= limit) break;
    }
    return { signals: signals.slice(0, limit), stats };
  },
};
