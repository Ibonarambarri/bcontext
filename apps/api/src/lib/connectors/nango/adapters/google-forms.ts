/**
 * Google Forms — `google-forms` → Nango `google-forms` (OAuth2 via `google`;
 * proxy base https://forms.googleapis.com). The Forms API has no "list my
 * forms" call, so `config.form_ids` is required — discovery lives in the
 * `google-drive` connector (mimeType application/vnd.google-apps.form).
 * For each form: the questions once, then responses submitted since the
 * cursor, one signal per response as "Question: answer" lines.
 */
import type { IngestSignal } from "@/lib/ingest/batch-extract";
import { allowList, clip, type NangoAdapter } from "./shared";

interface FormItem {
  itemId?: string;
  title?: string;
  questionItem?: { question?: { questionId?: string } };
  questionGroupItem?: { questions?: Array<{ questionId?: string; rowQuestion?: { title?: string } }> };
}

interface Form {
  formId?: string;
  info?: { title?: string; documentTitle?: string };
  responderUri?: string;
  items?: FormItem[];
}

interface FormResponse {
  responseId: string;
  createTime?: string;
  lastSubmittedTime?: string;
  respondentEmail?: string;
  answers?: Record<string, { questionId?: string; textAnswers?: { answers?: Array<{ value?: string }> } }>;
}

/** questionId → question title, group rows included. */
export function questionTitles(form: Form): Map<string, string> {
  const map = new Map<string, string>();
  for (const item of form.items ?? []) {
    const qid = item.questionItem?.question?.questionId;
    if (qid) map.set(qid, item.title ?? qid);
    for (const q of item.questionGroupItem?.questions ?? []) {
      if (q.questionId) map.set(q.questionId, `${item.title ?? ""} — ${q.rowQuestion?.title ?? q.questionId}`.trim());
    }
  }
  return map;
}

export const googleFormsAdapter: NangoAdapter = {
  id: "google-forms",
  provider: "google-forms",
  sourceHint: "google-forms:responses",
  async fetchChanges({ client, connectionId, config, since, limit }) {
    const formIds = allowList(config, "form_ids");
    const signals: IngestSignal[] = [];
    const stats: Record<string, number> = {};
    if (!formIds) return { signals, stats: { missing_form_ids: 1 } };
    let pages = 0;
    for (const formId of formIds.slice(0, 20)) {
      const formRes = await client.proxy<Form>({
        method: "GET",
        providerConfigKey: "google-forms",
        connectionId,
        path: `/v1/forms/${encodeURIComponent(formId)}`,
      });
      if (!formRes.ok) throw new Error(`google forms forms.get failed (${formRes.status})`);
      const form = formRes.data ?? {};
      const titles = questionTitles(form);
      const formTitle = form.info?.title ?? form.info?.documentTitle ?? formId;
      let pageToken: string | undefined;
      do {
        const res = await client.proxy<{ responses?: FormResponse[]; nextPageToken?: string }>({
          method: "GET",
          providerConfigKey: "google-forms",
          connectionId,
          path: `/v1/forms/${encodeURIComponent(formId)}/responses`,
          query: {
            filter: `timestamp >= ${since.toISOString()}`,
            pageSize: Math.min(100, limit),
            ...(pageToken ? { pageToken } : {}),
          },
        });
        if (!res.ok) throw new Error(`google forms responses.list failed (${res.status})`);
        for (const r of res.data?.responses ?? []) {
          const lines = Object.values(r.answers ?? {}).map((a) => {
            const q = a.questionId ? titles.get(a.questionId) ?? a.questionId : "?";
            const v = (a.textAnswers?.answers ?? []).map((x) => x.value ?? "").filter(Boolean).join(", ");
            return `${q}: ${v}`;
          });
          signals.push({
            external_id: `response:${formId}:${r.responseId}`,
            title: `${formTitle} · response`,
            text: clip([`Form: ${formTitle}`, r.lastSubmittedTime ? `Submitted: ${r.lastSubmittedTime}` : null, "", ...lines]
              .filter((x) => x !== null)
              .join("\n")),
            url: form.responderUri,
            author: r.respondentEmail,
            at: r.lastSubmittedTime ?? r.createTime,
            kind_hint: "response",
          });
          if (signals.length >= limit) break;
        }
        pageToken = res.data?.nextPageToken;
        pages += 1;
      } while (pageToken && signals.length < limit && pages < 10);
      if (signals.length >= limit) break;
    }
    stats.forms = formIds.length;
    stats.pages = pages;
    return { signals: signals.slice(0, limit), stats };
  },
};
