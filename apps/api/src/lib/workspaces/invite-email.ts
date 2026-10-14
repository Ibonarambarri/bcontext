/**
 * Workspace-invite email delivery via Resend.
 *
 * Nothing here fires on its own. An invitation is created as a link, and a
 * person decides whether it travels by email at all — see `@/lib/admin/orgs`
 * and the roster route. The recipient lands on `/invite/<token>`, where the
 * page accepts the invitation once they're signed in (or offers an inline
 * signup if they don't have an account yet).
 *
 * Two voices, one template: `owner` is an instance admin handing a team the
 * organization they created for it ("it's ready, start using it"), `member`
 * is someone already inside adding a colleague. The product is named by
 * `INSTANCE_NAME` (`@/lib/emails/sender`). The shell — the brand's paper palette, the one
 * highlighted word in a serif italic — is shared with every other letter the
 * product sends (`@/lib/emails/paper`); only the words are here.
 *
 * Required env (without either of the first two the mail is skipped):
 *   RESEND_API_KEY       — Resend project API key
 *   EMAIL_FROM           — RFC-5322 from address (see `@/lib/emails/sender`)
 *   APP_URL              — base URL used to build the invite link (see `@/lib/app-url`)
 */
import { Resend } from "resend";
import { log } from "@bcontext-dev/contract/log";
import { appBaseUrl } from "@/lib/app-url";
import { emailFrom, instanceName } from "@/lib/emails/sender";
import {
  escapeHtml,
  renderPaperHtml,
  renderPaperText,
  type PaperEmail,
} from "@/lib/emails/paper";

export type InviteEmailVariant = "owner" | "member";

export interface InviteEmailInput {
  email: string;
  inviteToken: string;
  organizationName: string;
  role: "owner" | "admin" | "editor" | "viewer";
  invitedByEmail?: string | null;
  /** `owner` is the hand-made onboarding mail; defaults to `member`. */
  variant?: InviteEmailVariant;
}

export type InviteEmailStatus = "sent" | "skipped" | "error";

export interface InviteEmailResult {
  status: InviteEmailStatus;
  error: string | null;
  messageId: string | null;
}

/**
 * What the mail says, per variant. The accent word is the only italic —
 * same move as the product's headlines, and it survives a serif fallback
 * because Georgia is everywhere.
 */
function copyFor(input: {
  variant: InviteEmailVariant;
  organizationName: string;
  role: string;
  inviteUrl: string;
  invitedByEmail?: string | null;
}): PaperEmail {
  const org = escapeHtml(input.organizationName);
  const role = escapeHtml(input.role);
  const product = instanceName();
  const productHtml = escapeHtml(product);
  const footnotes = [
    "The link expires in 14 days. If it has, ask for a fresh one.",
    "Not expecting this? You can safely ignore the message — no account will be created.",
  ];

  if (input.variant === "owner") {
    return {
      kicker: `${product.toLowerCase()} · your organization`,
      headlineLead: `${input.organizationName} is`,
      headlineAccent: "ready.",
      paragraphs: [
        `<strong>${org}</strong> has been set up for you on ${productHtml}. Open it below to finish setting it up — you'll create your account on the way in, and you land as its owner.`,
        "From there you can add your team, connect Claude Code or any MCP client, and start writing the context your agents will read.",
      ],
      cta: { label: "Start using your organization →", url: input.inviteUrl },
      footnotes,
      subject: `${input.organizationName} is ready on ${product}`,
    };
  }

  const inviterLine = input.invitedByEmail
    ? [`${escapeHtml(input.invitedByEmail)} added you to the team.`]
    : [];

  return {
    kicker: `${product.toLowerCase()} · workspace invitation`,
    headlineLead: "You've been invited to",
    headlineAccent: `${input.organizationName}.`,
    paragraphs: [
      ...inviterLine,
      `You'll join the <strong>${org}</strong> workspace on ${productHtml} as a <strong>${role}</strong>. Accept the invitation below — it takes a few seconds.`,
      `If you don't have a ${productHtml} account yet, you'll be able to create one from the same page using this email address.`,
    ],
    cta: { label: "Accept invitation →", url: input.inviteUrl },
    footnotes,
    subject: `You've been invited to ${input.organizationName} on ${product}`,
  };
}

export async function sendWorkspaceInviteEmail(
  input: InviteEmailInput,
): Promise<InviteEmailResult> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    log.warn("workspace_invite.email.skipped", {
      reason: "missing RESEND_API_KEY",
      organization_name: input.organizationName,
    });
    return { status: "skipped", error: "RESEND_API_KEY not set", messageId: null };
  }
  const from = emailFrom();
  if (!from) {
    log.warn("workspace_invite.email.skipped", {
      reason: "missing EMAIL_FROM",
      organization_name: input.organizationName,
    });
    return { status: "skipped", error: "EMAIL_FROM not set", messageId: null };
  }

  const inviteUrl = `${appBaseUrl()}/invite/${input.inviteToken}`;
  const copy = copyFor({
    variant: input.variant ?? "member",
    organizationName: input.organizationName,
    role: input.role,
    inviteUrl,
    invitedByEmail: input.invitedByEmail ?? null,
  });

  try {
    const resend = new Resend(apiKey);
    const result = await resend.emails.send({
      from,
      to: [input.email],
      subject: copy.subject,
      html: renderPaperHtml(copy),
      text: renderPaperText(copy),
      tags: [
        { name: "type", value: input.variant === "owner" ? "org_ready" : "workspace_invite" },
        { name: "org", value: input.organizationName.slice(0, 32) },
      ],
    });

    if (result.error) {
      log.error("workspace_invite.email.failed", {
        organization_name: input.organizationName,
        error: result.error.message ?? "resend error",
      });
      return {
        status: "error",
        error: result.error.message ?? "resend error",
        messageId: null,
      };
    }

    log.info("workspace_invite.email.sent", {
      organization_name: input.organizationName,
      message_id: result.data?.id ?? null,
    });
    return { status: "sent", error: null, messageId: result.data?.id ?? null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    log.error("workspace_invite.email.failed", {
      organization_name: input.organizationName,
      error: msg,
    });
    return { status: "error", error: msg, messageId: null };
  }
}
