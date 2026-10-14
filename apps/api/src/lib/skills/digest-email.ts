/**
 * Weekly digest by email, via Resend — the same path the workspace invite
 * travels (`@/lib/workspaces/invite-email`), same paper palette.
 *
 * Best-effort by contract: no key or no `EMAIL_FROM` → `skipped`, a provider error → `error`,
 * never a throw. The digest node is already published by the time this
 * runs; the mail is one more way to read it, not the record of it.
 */
import { Resend } from "resend";
import { log } from "@bcontext-dev/contract/log";
import { appBaseUrl } from "@/lib/app-url";
import { emailFooter, emailFrom } from "@/lib/emails/sender";
import { workspaceRefFor } from "@/lib/workspaces/ref";

export interface DigestEmailInput {
  to: string[];
  workspaceName: string;
  workspaceSlug: string;
  /** Needed to build the `/w/<org>/<ws>/n/<id>` link; falls back to the slug. */
  organizationId?: string;
  nodeId: string;
  title: string;
  markdown: string;
}

export interface DigestEmailResult {
  status: "sent" | "skipped" | "error";
  error: string | null;
  messageId: string | null;
}

const PAPER = "#ffffff";
const INK = "#101010";
const INK_2 = "#6b6b66";
const INK_3 = "#9a9a94";
const LINE = "#e6e6e2";
const SANS =
  "-apple-system,BlinkMacSystemFont,'IBM Plex Sans','Segoe UI',Roboto,Helvetica,Arial,sans-serif";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * The digest is bullets under four H2s with `/n/<id>` links; that is all
 * this needs to render. Anything else in the markdown is left as text.
 */
function digestMarkdownToHtml(markdown: string, base: string): string {
  const out: string[] = [];
  let inList = false;
  const inline = (s: string) =>
    escapeHtml(s)
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/_(.+?)_/g, "<em>$1</em>")
      .replace(/`(.+?)`/g, "<code>$1</code>")
      .replace(/\[([^\]]+)\]\((\/n\/[A-Za-z0-9-]+)\)/g, (_, text: string, href: string) =>
        `<a href="${base}${href}" style="color:${INK};">${text}</a>`);
  for (const raw of markdown.split("\n")) {
    const line = raw.trimEnd();
    if (line.startsWith("- ")) {
      if (!inList) { out.push(`<ul style="margin:0 0 16px;padding-left:20px;color:${INK_2};font-size:14.5px;">`); inList = true; }
      out.push(`<li style="margin:0 0 6px;">${inline(line.slice(2))}</li>`);
      continue;
    }
    if (inList) { out.push("</ul>"); inList = false; }
    if (!line) continue;
    if (line.startsWith("## ")) {
      out.push(`<h2 style="font-weight:500;font-size:18px;letter-spacing:-.01em;color:${INK};margin:22px 0 10px;">${inline(line.slice(3))}</h2>`);
    } else {
      out.push(`<p style="margin:0 0 12px;font-size:14.5px;color:${INK_2};">${inline(line)}</p>`);
    }
  }
  if (inList) out.push("</ul>");
  return out.join("\n");
}

function renderHtml(input: { title: string; workspaceName: string; url: string; body: string }): string {
  return `<!DOCTYPE html>
<html lang="es">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(input.title)}</title>
  </head>
  <body style="margin:0;padding:0;background:${PAPER};font-family:${SANS};color:${INK};line-height:1.55;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${PAPER};padding:44px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;width:100%;background:${PAPER};padding:0 8px;">
            <tr>
              <td>
                <div style="font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:${INK_3};margin-bottom:18px;">
                  bcontext · ${escapeHtml(input.workspaceName)}
                </div>
                <h1 style="font-weight:500;font-size:30px;line-height:1.06;letter-spacing:-.028em;color:${INK};margin:0 0 18px;">
                  ${escapeHtml(input.title)}
                </h1>
                ${input.body}
                <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:26px 0 30px;">
                  <tr>
                    <td align="center" bgcolor="${INK}" style="border-radius:999px;">
                      <a href="${escapeHtml(input.url)}" target="_blank" style="display:inline-block;padding:14px 28px;font-size:15px;font-weight:500;color:#ffffff;text-decoration:none;border-radius:999px;background:${INK};">
                        Abrir el digest en Bcontext →
                      </a>
                    </td>
                  </tr>
                </table>
                <hr style="border:0;border-top:1px solid ${LINE};margin:26px 0 18px;" />
                <p style="margin:0;font-size:12.5px;color:${INK_3};">
                  Lo escribe NEXO cada semana a partir de los cambios del workspace. Se desactiva desde los ajustes del workspace.
                </p>
              </td>
            </tr>
          </table>
          <p style="font-size:12.5px;color:${INK_3};margin:20px 0 0;">${escapeHtml(emailFooter())}</p>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

export async function sendDigestEmail(input: DigestEmailInput): Promise<DigestEmailResult> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    log.warn("digest.email.skipped", { reason: "missing RESEND_API_KEY", workspace: input.workspaceSlug });
    return { status: "skipped", error: "RESEND_API_KEY not set", messageId: null };
  }
  const from = emailFrom();
  if (!from) {
    log.warn("digest.email.skipped", { reason: "missing EMAIL_FROM", workspace: input.workspaceSlug });
    return { status: "skipped", error: "EMAIL_FROM not set", messageId: null };
  }
  if (input.to.length === 0) return { status: "skipped", error: "no recipients", messageId: null };

  const base = appBaseUrl();
  const ref = input.organizationId
    ? await workspaceRefFor({ organization_id: input.organizationId, slug: input.workspaceSlug })
    : input.workspaceSlug;
  const url = `${base}/w/${ref}/n/${input.nodeId}`;
  const html = renderHtml({
    title: input.title,
    workspaceName: input.workspaceName,
    url,
    body: digestMarkdownToHtml(input.markdown, `${base}/w/${ref}`),
  });
  const text = `${input.title}\n\n${input.markdown}\n\n${url}`;

  try {
    const resend = new Resend(apiKey);
    const result = await resend.emails.send({
      from,
      to: input.to,
      subject: `${input.title} · ${input.workspaceName}`,
      html,
      text,
      tags: [
        { name: "type", value: "digest_weekly" },
        { name: "workspace", value: input.workspaceSlug.slice(0, 32) },
      ],
    });
    if (result.error) {
      log.error("digest.email.failed", { workspace: input.workspaceSlug, error: result.error.message ?? "resend error" });
      return { status: "error", error: result.error.message ?? "resend error", messageId: null };
    }
    log.info("digest.email.sent", { workspace: input.workspaceSlug, recipients: input.to.length, message_id: result.data?.id ?? null });
    return { status: "sent", error: null, messageId: result.data?.id ?? null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    log.error("digest.email.failed", { workspace: input.workspaceSlug, error: msg });
    return { status: "error", error: msg, messageId: null };
  }
}
