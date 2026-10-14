/**
 * Tally — `tally` → Nango `tally` (API_KEY; proxy base https://api.tally.so,
 * Nango sets the bearer header). `/forms` (or `config.form_ids`), then
 * `/forms/{id}/submissions?filter=completed` newest first; Tally has no
 * "since" parameter, so pages are read until the first submission older
 * than the cursor (≤ 5 pages per form). The response carries the form's
 * `questions`, used to label each answer. One signal per submission.
 */
import type { IngestSignal } from "@/lib/ingest/batch-extract";
import { allowList, clip, str, type NangoAdapter } from "./shared";

interface TallyForm {
  id: string;
  name?: string | null;
  status?: string;
  updatedAt?: string;
}

interface TallyQuestion {
  id: string;
  title?: string;
  type?: string;
}

interface TallySubmission {
  id: string;
  formId?: string;
  isCompleted?: boolean;
  submittedAt?: string;
  responses?: Array<{ questionId?: string; value?: unknown }>;
}

interface TallySubmissionsPage {
  page?: number;
  limit?: number;
  hasMore?: boolean;
  questions?: TallyQuestion[];
  submissions?: TallySubmission[];
}

const MAX_PAGES = 5;
const MAX_FORMS = 25;

export function tallyValueText(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) {
    return v
      .map((x) => (x && typeof x === "object" ? str((x as { name?: unknown; url?: unknown; value?: unknown }).name ?? (x as { url?: unknown }).url ?? (x as { value?: unknown }).value) : str(x)))
      .filter(Boolean)
      .join(", ");
  }
  if (typeof v === "object") {
    return Object.entries(v as Record<string, unknown>)
      .map(([k, x]) => `${k}: ${str(x)}`)
      .join(", ");
  }
  return "";
}

export const tallyAdapter: NangoAdapter = {
  id: "tally",
  provider: "tally",
  sourceHint: "tally:submissions",
  async fetchChanges({ client, connectionId, config, since, limit }) {
    const wanted = allowList(config, "form_ids");
    const listed = await client.proxy<{ items?: TallyForm[] }>({
      method: "GET",
      providerConfigKey: "tally",
      connectionId,
      path: "/forms",
      query: { page: 1, limit: 100 },
    });
    if (!listed.ok) throw new Error(`tally forms failed (${listed.status})`);
    const forms = (listed.data?.items ?? [])
      .filter((f) => !wanted || wanted.includes(f.id))
      .filter((f) => !f.updatedAt || new Date(f.updatedAt) > since || wanted)
      .slice(0, MAX_FORMS);

    const signals: IngestSignal[] = [];
    const stats = { forms: forms.length, submissions: 0 };
    for (const form of forms) {
      let page = 1;
      let done = false;
      while (!done && page <= MAX_PAGES && signals.length < limit) {
        const res = await client.proxy<TallySubmissionsPage>({
          method: "GET",
          providerConfigKey: "tally",
          connectionId,
          path: `/forms/${encodeURIComponent(form.id)}/submissions`,
          query: { page, filter: "completed" },
        });
        if (!res.ok) throw new Error(`tally submissions failed (${res.status})`);
        const titles = new Map((res.data?.questions ?? []).map((q) => [q.id, q.title ?? q.id]));
        const rows = res.data?.submissions ?? [];
        for (const s of rows) {
          if (s.submittedAt && new Date(s.submittedAt) <= since) {
            done = true;
            break;
          }
          stats.submissions++;
          const lines = (s.responses ?? [])
            .map((r) => ({ q: (r.questionId && titles.get(r.questionId)) || r.questionId || "?", v: tallyValueText(r.value) }))
            .filter((x) => x.v)
            .map((x) => `- ${x.q}: ${x.v}`);
          signals.push({
            external_id: `submission:${s.id}`,
            title: `${form.name ?? form.id} · submission ${s.submittedAt ?? s.id}`,
            text: clip([`Form: ${form.name ?? form.id}`, lines.length ? `\nAnswers:\n${lines.join("\n")}` : null].filter(Boolean).join("\n")),
            url: `https://tally.so/forms/${form.id}/submissions`,
            at: s.submittedAt,
            kind_hint: "form_response",
          });
          if (signals.length >= limit) break;
        }
        if (!res.data?.hasMore) done = true;
        page++;
      }
      if (signals.length >= limit) break;
    }
    return { signals: signals.slice(0, limit), stats };
  },
};
