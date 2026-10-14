/**
 * The Nexo inbox, from the runtime's side: filing an escalation (and telling
 * the people it names), and acting on a person's decision about an item.
 *
 * Callers: `./runner` (the `escalate` tool, the budget ceiling),
 * `POST /api/nexos/inbox/:itemId` (resolve), and the triggers if they need to
 * escalate outside a run.
 *
 * Must not break:
 *   - Approving a `draft_reply` sends FIRST and resolves after: a send that
 *     fails leaves the item open so the person can retry, rather than marking
 *     as approved a message nobody received. The resolve is compare-and-set on
 *     `open`, so two people approving at once is one 409, not two messages —
 *     the loser's send is the cost, made rare by re-reading the item first.
 *   - Auditing is the route's (`auditNexo`), which knows who is acting.
 *   - Email is best-effort: no key, no recipients or a provider error is
 *     logged and swallowed; the inbox item is the record.
 *   - Email only reaches people who can read the workspace: `notify_user_ids`
 *     is a list anyone with write access can edit, and an escalation carries
 *     workspace content.
 *   - An approved draft goes only where the Nexo may still speak: the
 *     destination stored with the draft is re-checked against a live
 *     `listen_reply` binding of this Nexo at send time, so a binding removed
 *     or downgraded after the draft was filed closes that door too.
 */
import { Resend } from "resend";
import { log } from "@bcontext-dev/contract/log";
import type { Nexo, NexoInboxAction, NexoInboxItem } from "@bcontext-dev/contract/nexos";
import { appBaseUrl } from "@/lib/app-url";
import { emailFrom } from "@/lib/emails/sender";
import { escapeHtml, renderPaperHtml, renderPaperText, type PaperEmail } from "@/lib/emails/paper";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { workspaceRefFor } from "@/lib/workspaces/ref";
import { sendNexoMessage } from "@/lib/nexos/outbound";
import { resolveGrantForPrincipal, isDenied } from "@/lib/auth/grants";
import {
  channelScopeKey,
  createInboxItem,
  findBindingForEvent,
  getInboxItem,
  resolveInboxItem,
} from "@/lib/nexos/store";
import type { NexoTarget } from "@/lib/nexos/types";

export interface WorkspaceLabel {
  id: string;
  organization_id: string;
  slug: string;
  name: string;
}

/** File an escalation and notify. Returns the item; throws only if the item cannot be written. */
export async function escalate(args: {
  target: NexoTarget;
  nexo: Nexo;
  workspace: WorkspaceLabel;
  runId?: string | null;
  title: string;
  body_md: string;
  reason?: string;
  payload?: Record<string, unknown>;
}): Promise<NexoInboxItem> {
  const item = await createInboxItem(args.target, {
    nexoId: args.nexo.id,
    runId: args.runId ?? null,
    kind: "escalation",
    title: args.title,
    body_md: args.body_md,
    payload: { ...(args.payload ?? {}), ...(args.reason ? { reason: args.reason } : {}) },
  });
  await notifyEscalation({ target: args.target, nexo: args.nexo, workspace: args.workspace, item });
  return item;
}

/**
 * Emails of these users, resolved through the auth server. Unknown ids, and
 * ids without read access to the workspace, are skipped.
 */
async function emailsFor(userIds: string[], workspaceId: string): Promise<string[]> {
  const admin = getSupabaseAdmin();
  const emails = new Set<string>();
  for (const id of userIds.slice(0, 20)) {
    try {
      const grant = await resolveGrantForPrincipal({ kind: "user", id }, workspaceId);
      if (isDenied(grant) || !grant.verbs.includes("read")) continue;
      const { data } = await admin.auth.admin.getUserById(id);
      if (data?.user?.email) emails.add(data.user.email.toLowerCase());
    } catch {
      // A user the auth server cannot resolve simply gets no mail.
    }
  }
  return [...emails];
}

/**
 * Email the Nexo's escalation recipients when `escalation.via` includes
 * `email`. Never throws; returns what happened for logs and tests.
 */
export async function notifyEscalation(args: {
  target: NexoTarget;
  nexo: Nexo;
  workspace: WorkspaceLabel;
  item: NexoInboxItem;
}): Promise<"sent" | "skipped" | "error"> {
  const { nexo, workspace, item } = args;
  try {
    if (args.target.backend !== "supabase") return "skipped";
    if (!nexo.escalation.via.includes("email") || nexo.escalation.notify_user_ids.length === 0) return "skipped";
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) {
      log.warn("nexos.escalation.email_skipped", { reason: "missing RESEND_API_KEY", nexo_id: nexo.id });
      return "skipped";
    }
    const from = emailFrom();
    if (!from) {
      log.warn("nexos.escalation.email_skipped", { reason: "missing EMAIL_FROM", nexo_id: nexo.id });
      return "skipped";
    }
    const to = await emailsFor(nexo.escalation.notify_user_ids, args.target.workspaceId);
    if (to.length === 0) return "skipped";

    const ref = await workspaceRefFor(workspace);
    const url = `${appBaseUrl()}/w/${ref}/nexos/${nexo.id}?tab=inbox&item=${item.id}`;
    const body = item.body_md.trim();
    const email: PaperEmail = {
      subject: `${nexo.name}: ${item.title}`.slice(0, 200),
      kicker: `bcontext · ${workspace.name}`,
      headlineLead: `${nexo.name} necesita`,
      headlineAccent: "tu ayuda",
      paragraphs: [
        `<strong>${escapeHtml(item.title)}</strong>`,
        ...(body ? body.split(/\n{2,}/).slice(0, 6).map((p) => escapeHtml(p).replace(/\n/g, "<br />")) : []),
      ],
      cta: { label: "Abrir la bandeja →", url },
      showLink: true,
      footnotes: [`Te llega porque ${nexo.name} te tiene como persona a la que avisar. Se cambia en los ajustes del Nexo.`],
    };
    const result = await new Resend(apiKey).emails.send({
      from,
      to,
      subject: email.subject,
      html: renderPaperHtml(email),
      text: renderPaperText(email),
      tags: [
        { name: "type", value: "nexo_escalation" },
        { name: "workspace", value: workspace.slug.slice(0, 32).replace(/[^A-Za-z0-9_-]/g, "_") },
      ],
    });
    if (result.error) {
      log.error("nexos.escalation.email_failed", { nexo_id: nexo.id, error: result.error.message ?? "resend error" });
      return "error";
    }
    return "sent";
  } catch (err) {
    log.error("nexos.escalation.email_failed", { nexo_id: nexo.id, error: err instanceof Error ? err.message : String(err) });
    return "error";
  }
}

export type InboxActionResult =
  | { ok: true; item: NexoInboxItem }
  | { ok: false; status: 400 | 404 | 409 | 502; error: string; message?: string };

/**
 * Apply a person's decision to an inbox item.
 *
 *   approve / edit  on a `draft_reply`: send the (edited) text through the
 *                   binding, then `approved` / `edited` with the sent ts.
 *   approve         on an escalation/approval: `approved`, nothing sent.
 *   reject          `rejected`.
 *   done            `done` (the escalation was handled by a person).
 */
export async function resolveNexoInboxAction(args: {
  target: NexoTarget;
  nexo: Nexo;
  itemId: string;
  action: NexoInboxAction;
  text?: string;
  userId: string | null;
}): Promise<InboxActionResult> {
  const item = await getInboxItem(args.target, args.itemId);
  if (!item || item.nexo_id !== args.nexo.id) return { ok: false, status: 404, error: "inbox_item_not_found" };
  if (item.status !== "open") return { ok: false, status: 409, error: "already_resolved" };

  let status: Exclude<NexoInboxItem["status"], "open">;
  const extra: Record<string, unknown> = {};

  if ((args.action === "approve" || args.action === "edit") && item.kind === "draft_reply") {
    const p = item.payload;
    const installId = typeof p.install_id === "string" ? p.install_id : null;
    const channel = typeof p.channel === "string" ? p.channel : null;
    const threadTs = typeof p.thread_ts === "string" ? p.thread_ts : undefined;
    const text = args.action === "edit" ? args.text?.trim() : typeof p.draft_text === "string" ? p.draft_text : "";
    if (!installId || !channel) return { ok: false, status: 400, error: "draft_missing_destination" };
    if (!text) return { ok: false, status: 400, error: "draft_empty" };
    if (!(await mayStillReply(args.target, args.nexo, installId, channel))) {
      return { ok: false, status: 409, error: "binding_gone", message: "This Nexo no longer replies on that channel." };
    }
    const sent = await sendNexoMessage({ target: args.target, nexo: args.nexo, installId, channel, threadTs, text });
    if (!sent.ok) return { ok: false, status: 502, error: "send_failed", message: sent.error };
    status = args.action === "edit" ? "edited" : "approved";
    extra.sent_text = text;
    extra.sent_ts = sent.ts ?? null;
    extra.sent_at = new Date().toISOString();
  } else if (args.action === "edit") {
    return { ok: false, status: 400, error: "only_drafts_can_be_edited" };
  } else {
    status = args.action === "approve" ? "approved" : args.action === "reject" ? "rejected" : "done";
  }

  const resolved = await resolveInboxItem(args.target, item.id, { status, resolvedBy: args.userId, payload: extra });
  if (!resolved) return { ok: false, status: 409, error: "already_resolved" };

  return { ok: true, item: resolved };
}

/** True when `nexo` holds a `listen_reply` binding that covers this install + channel today. */
async function mayStillReply(target: NexoTarget, nexo: Nexo, installId: string, channel: string): Promise<boolean> {
  const binding = await findBindingForEvent(target, installId, [channelScopeKey(channel), "*"]);
  return Boolean(binding && binding.nexo_id === nexo.id && binding.mode === "listen_reply");
}
