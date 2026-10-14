/**
 * DocuSign — `docusign` → Nango `docusign` (OAuth2; proxy
 * https://www.docusign.net, the eSignature REST host).
 *
 * The account id is not in the connection (DocuSign returns it from
 * account.docusign.com/oauth/userinfo, a different host than the proxy base),
 * so the install needs `config.account_id`; we also honour a
 * `connection_config.accountId` if the owner adds it in Nango. Envelopes are
 * listed with `listStatusChanges` (`from_date`, status filter, recipients
 * included) — completed, declined and voided agreements are the knowledge
 * (what was signed, by whom, when); `sent` ones show what is pending.
 *
 * Install config: `account_id` (required), `statuses` (default completed,
 * declined, voided, sent), `base_path` (e.g. https://eu.docusign.net for EU
 * accounts — passed as Base-Url-Override).
 */
import type { IngestSignal } from "@/lib/ingest/batch-extract";
import { allowList, clip, configString, str, type NangoAdapter } from "./shared";

interface Signer {
  name?: string;
  email?: string;
  status?: string;
  signedDateTime?: string;
  declinedDateTime?: string;
  declinedReason?: string;
  roleName?: string;
}

interface Envelope {
  envelopeId: string;
  emailSubject?: string;
  emailBlurb?: string;
  status?: string;
  statusChangedDateTime?: string;
  sentDateTime?: string;
  completedDateTime?: string;
  declinedDateTime?: string;
  voidedDateTime?: string;
  voidedReason?: string;
  sender?: { userName?: string; email?: string };
  recipients?: { signers?: Signer[]; carbonCopies?: Signer[] };
  customFields?: { textCustomFields?: Array<{ name?: string; value?: string }> };
}

interface EnvelopesPage {
  envelopes?: Envelope[];
  resultSetSize?: string | number;
  totalSetSize?: string | number;
  nextUri?: string;
  endPosition?: string | number;
}

const DEFAULT_STATUSES = ["completed", "declined", "voided", "sent"];
const PAGE = 50;

export function docusignEnvelopeUrl(accountId: string, envelopeId: string): string {
  return `https://app.docusign.com/documents/details/${envelopeId}?account=${encodeURIComponent(accountId)}`;
}

export const docusignAdapter: NangoAdapter = {
  id: "docusign",
  provider: "docusign",
  sourceHint: "docusign:envelopes",
  async fetchChanges({ client, connectionId, connectionConfig, config, since, limit }) {
    const accountId = configString(config, "account_id") ?? str(connectionConfig.accountId);
    if (!accountId) {
      const stats: Record<string, number> = { envelopes: 0, missing_account_id: 1 };
      return { signals: [], stats };
    }
    const statuses = allowList(config, "statuses") ?? DEFAULT_STATUSES;
    const basePath = configString(config, "base_path");

    const signals: IngestSignal[] = [];
    let startPosition = 0;
    let pages = 0;
    let total = 0;
    do {
      const res = await client.proxy<EnvelopesPage>({
        method: "GET",
        providerConfigKey: "docusign",
        connectionId,
        path: `/restapi/v2.1/accounts/${encodeURIComponent(accountId)}/envelopes`,
        query: {
          from_date: since.toISOString(),
          status: statuses.join(","),
          include: "recipients,custom_fields",
          order: "desc",
          order_by: "status_changed",
          count: PAGE,
          start_position: startPosition,
        },
        ...(basePath ? { baseUrlOverride: basePath } : {}),
      });
      if (!res.ok) throw new Error(`docusign envelopes failed (${res.status})`);
      const rows = res.data?.envelopes ?? [];
      total = Number(res.data?.totalSetSize ?? rows.length);
      for (const env of rows) {
        const signers = env.recipients?.signers ?? [];
        const cc = env.recipients?.carbonCopies ?? [];
        const at = env.statusChangedDateTime ?? env.completedDateTime ?? env.sentDateTime;
        signals.push({
          external_id: `envelope:${env.envelopeId}`,
          title: `${env.status ?? "envelope"} · ${env.emailSubject ?? env.envelopeId}`,
          text: [
            `Status: ${env.status ?? "?"} · Sent: ${env.sentDateTime ?? "?"} · Completed: ${env.completedDateTime ?? "—"} · Changed: ${at ?? "?"}`,
            env.sender?.userName ? `Sender: ${env.sender.userName}${env.sender.email ? ` <${env.sender.email}>` : ""}` : null,
            signers.length
              ? `Signers:\n${signers
                  .map(
                    (s) =>
                      `- ${s.name ?? "?"}${s.roleName ? ` (${s.roleName})` : ""}: ${s.status ?? "?"}${s.signedDateTime ? ` at ${s.signedDateTime}` : ""}${s.declinedReason ? ` — declined: ${s.declinedReason}` : ""}`,
                  )
                  .join("\n")}`
              : null,
            cc.length ? `CC: ${cc.map((c) => c.name ?? c.email ?? "?").join(", ")}` : null,
            env.voidedReason ? `Voided: ${env.voidedReason}` : null,
            env.customFields?.textCustomFields?.length
              ? `Fields: ${env.customFields.textCustomFields.map((f) => `${f.name}=${f.value ?? ""}`).join(", ")}`
              : null,
            env.emailBlurb ? `\n${clip(env.emailBlurb, 1500)}` : null,
          ]
            .filter((x) => x !== null)
            .join("\n"),
          url: docusignEnvelopeUrl(accountId, env.envelopeId),
          author: env.sender?.userName,
          at,
          kind_hint: "agreement",
        });
        if (signals.length >= limit) break;
      }
      pages += 1;
      startPosition += rows.length;
      if (!res.data?.nextUri || rows.length === 0) break;
    } while (signals.length < limit && pages < 4);

    const stats: Record<string, number> = { envelopes: total, pages };
    return { signals: signals.slice(0, limit), stats };
  },
};
