/**
 * Mailchimp — `mailchimp` → Nango `mailchimp` (OAuth2; the proxy base is
 * `https://<dc>.api.mailchimp.com`, `dc` comes from connection_config).
 *
 * Campaigns sent since the cursor with their report (opens, clicks,
 * unsubscribes) plus automations created since the cursor. The marketing
 * calendar is a record of decisions: what was said to whom, and how it
 * landed. Audience members are never read.
 *
 * Assumptions (docs, not exercised live): `/3.0/campaigns` accepts
 * `since_send_time` + `status=sent`; `/3.0/reports/{id}` exists for every
 * sent campaign (a 404 is tolerated); `/3.0/automations` has no "since"
 * filter, so it is filtered client-side on `create_time`.
 */
import type { IngestSignal } from "@/lib/ingest/batch-extract";
import { clip, str, type NangoAdapter } from "./shared";

interface MailchimpCampaign {
  id: string;
  web_id?: number;
  type?: string;
  status?: string;
  emails_sent?: number;
  send_time?: string;
  archive_url?: string;
  settings?: { subject_line?: string; preview_text?: string; title?: string; from_name?: string };
  recipients?: { list_name?: string; recipient_count?: number; segment_text?: string };
}

interface MailchimpReport {
  opens?: { open_rate?: number; unique_opens?: number };
  clicks?: { click_rate?: number; unique_clicks?: number };
  unsubscribed?: number;
  bounces?: { hard_bounces?: number; soft_bounces?: number };
}

interface MailchimpAutomation {
  id: string;
  status?: string;
  create_time?: string;
  start_time?: string;
  emails_sent?: number;
  settings?: { title?: string; from_name?: string };
  recipients?: { list_name?: string };
  trigger_settings?: { workflow_title?: string; workflow_type?: string };
}

export function mailchimpPercent(rate: number | undefined): string {
  return typeof rate === "number" ? `${(rate * 100).toFixed(1)}%` : "?";
}

export function mailchimpCampaignText(c: MailchimpCampaign, report: MailchimpReport | null): string {
  const s = c.settings ?? {};
  const r = c.recipients ?? {};
  return [
    `Subject: ${s.subject_line ?? ""}`,
    s.preview_text ? `Preview: ${s.preview_text}` : null,
    `From: ${s.from_name ?? "?"} · Audience: ${r.list_name ?? "?"}${r.segment_text ? ` (${r.segment_text})` : ""}`,
    `Sent: ${c.send_time ?? "?"} · Recipients: ${r.recipient_count ?? c.emails_sent ?? "?"}`,
    report
      ? `Results: opens ${mailchimpPercent(report.opens?.open_rate)} (${report.opens?.unique_opens ?? "?"} unique) · clicks ${mailchimpPercent(report.clicks?.click_rate)} (${report.clicks?.unique_clicks ?? "?"} unique) · unsubscribes ${report.unsubscribed ?? 0} · bounces ${(report.bounces?.hard_bounces ?? 0) + (report.bounces?.soft_bounces ?? 0)}`
      : "Results: report not available yet",
  ]
    .filter((x) => x !== null)
    .join("\n");
}

export const mailchimpAdapter: NangoAdapter = {
  id: "mailchimp",
  provider: "mailchimp",
  sourceHint: "mailchimp:campaigns",
  async fetchChanges({ client, connectionId, connectionConfig, since, limit }) {
    const dc = str(connectionConfig.dc);
    const signals: IngestSignal[] = [];
    const stats = { campaigns: 0, automations: 0 };
    const pageSize = Math.min(50, limit);
    let offset = 0;
    let pages = 0;
    do {
      const res = await client.proxy<{ campaigns?: MailchimpCampaign[]; total_items?: number }>({
        method: "GET",
        providerConfigKey: "mailchimp",
        connectionId,
        path: "/3.0/campaigns",
        query: {
          since_send_time: since.toISOString(),
          status: "sent",
          sort_field: "send_time",
          sort_dir: "DESC",
          count: pageSize,
          offset,
          fields: "campaigns.id,campaigns.web_id,campaigns.type,campaigns.status,campaigns.emails_sent,campaigns.send_time,campaigns.archive_url,campaigns.settings.subject_line,campaigns.settings.preview_text,campaigns.settings.title,campaigns.settings.from_name,campaigns.recipients.list_name,campaigns.recipients.recipient_count,campaigns.recipients.segment_text,total_items",
        },
      });
      if (!res.ok) throw new Error(`mailchimp campaigns failed (${res.status})`);
      const campaigns = res.data?.campaigns ?? [];
      for (const c of campaigns) {
        if (signals.length >= limit) break;
        const report = await client.proxy<MailchimpReport>({
          method: "GET",
          providerConfigKey: "mailchimp",
          connectionId,
          path: `/3.0/reports/${encodeURIComponent(c.id)}`,
          query: { fields: "opens.open_rate,opens.unique_opens,clicks.click_rate,clicks.unique_clicks,unsubscribed,bounces.hard_bounces,bounces.soft_bounces" },
        });
        signals.push({
          external_id: `campaign:${c.id}`,
          title: `Campaign · ${c.settings?.title || c.settings?.subject_line || c.id}`,
          text: clip(mailchimpCampaignText(c, report.ok ? report.data : null)),
          url: c.archive_url || (dc && c.web_id ? `https://${dc}.admin.mailchimp.com/campaigns/show/?id=${c.web_id}` : undefined),
          author: c.settings?.from_name,
          at: c.send_time,
          kind_hint: "campaign",
        });
        stats.campaigns += 1;
      }
      pages += 1;
      if (campaigns.length < pageSize) break;
      offset += pageSize;
    } while (signals.length < limit && pages < 5);

    if (signals.length < limit) {
      const res = await client.proxy<{ automations?: MailchimpAutomation[] }>({
        method: "GET",
        providerConfigKey: "mailchimp",
        connectionId,
        path: "/3.0/automations",
        query: { count: 100, fields: "automations.id,automations.status,automations.create_time,automations.start_time,automations.emails_sent,automations.settings.title,automations.settings.from_name,automations.recipients.list_name,automations.trigger_settings.workflow_title,automations.trigger_settings.workflow_type" },
      });
      if (res.ok) {
        for (const a of res.data?.automations ?? []) {
          if (signals.length >= limit) break;
          if (!a.create_time || new Date(a.create_time) <= since) continue;
          signals.push({
            external_id: `automation:${a.id}`,
            title: `Automation · ${a.settings?.title || a.trigger_settings?.workflow_title || a.id}`,
            text: [
              `Status: ${a.status ?? "?"} · Type: ${a.trigger_settings?.workflow_type ?? "?"}`,
              `Audience: ${a.recipients?.list_name ?? "?"} · From: ${a.settings?.from_name ?? "?"}`,
              `Created: ${a.create_time}${a.start_time ? ` · Started: ${a.start_time}` : ""} · Emails sent: ${a.emails_sent ?? 0}`,
            ].join("\n"),
            author: a.settings?.from_name,
            at: a.start_time || a.create_time,
            kind_hint: "automation",
          });
          stats.automations += 1;
        }
      }
    }
    return { signals: signals.slice(0, limit), stats };
  },
};
