/**
 * The one email Bcontext writes, with different words in it.
 *
 * Every message that leaves the product — an invitation, "confirm your
 * address", "your organization is ready" — is the same page: the brand's
 * paper palette, a kicker in small caps, a headline whose last word is a
 * serif italic, a black pill for the one thing to do, and the same link
 * printed underneath for the clients that eat buttons. Inlined because email
 * has no CSS variables and no stylesheet.
 *
 * It lives here rather than in the invitation module because the second
 * caller was the moment the shell stopped being about invitations. Copy is
 * the caller's business; the shape is not.
 */

import { emailFooter } from "@/lib/emails/sender";

export const PAPER = "#ffffff";
const PAPER_2 = "#f5f5f3";
export const INK = "#101010";
export const INK_2 = "#6b6b66";
export const INK_3 = "#9a9a94";
export const LINE = "#e6e6e2";
export const SANS =
  "-apple-system,BlinkMacSystemFont,'IBM Plex Sans','Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace";

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface PaperEmail {
  /** Small caps above the headline: "bcontext · your organization". */
  kicker: string;
  /** The headline, split so the last part can be the serif italic. */
  headlineLead: string;
  headlineAccent: string;
  /** Body paragraphs. Trusted HTML — callers escape what came from a user. */
  paragraphs: string[];
  /** The single action. Omitted for a message that asks for nothing. */
  cta?: { label: string; url: string };
  /** Whether to print the URL under the button for clients that strip it. */
  showLink?: boolean;
  /** Small print under the rule. Escaped. */
  footnotes?: string[];
  subject: string;
}

export function renderPaperHtml(email: PaperEmail): string {
  const url = email.cta ? escapeHtml(email.cta.url) : null;
  const body = email.paragraphs
    .map(
      (p) =>
        `<p style="margin:0 0 18px;font-size:15px;color:${INK_2};">${p}</p>`,
    )
    .join("\n                ");

  const button =
    email.cta && url
      ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:12px 0 30px;">
                  <tr>
                    <td align="center" bgcolor="${INK}" style="border-radius:999px;">
                      <a href="${url}" target="_blank" style="display:inline-block;padding:14px 28px;font-size:15px;font-weight:500;color:#ffffff;text-decoration:none;border-radius:999px;background:${INK};">
                        ${escapeHtml(email.cta.label)}
                      </a>
                    </td>
                  </tr>
                </table>`
      : "";

  const linkBlock =
    email.showLink !== false && url
      ? `<p style="margin:0 0 8px;font-size:12px;color:${INK_3};letter-spacing:.04em;">
                  or paste this link into your browser
                </p>
                <p style="margin:0 0 30px;font-family:${MONO};font-size:11.5px;color:${INK_2};word-break:break-all;background:${PAPER_2};border:1px solid ${LINE};border-radius:12px;padding:11px 14px;">
                  ${url}
                </p>`
      : "";

  const footnotes = (email.footnotes ?? [])
    .map(
      (line, i) =>
        `<p style="margin:0 0 ${i === (email.footnotes?.length ?? 0) - 1 ? "0" : "6px"};font-size:12.5px;color:${INK_3};">${escapeHtml(line)}</p>`,
    )
    .join("\n                ");

  const rule = footnotes
    ? `<hr style="border:0;border-top:1px solid ${LINE};margin:26px 0 18px;" />`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(email.subject)}</title>
  </head>
  <body style="margin:0;padding:0;background:${PAPER};font-family:${SANS};color:${INK};line-height:1.55;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${PAPER};padding:44px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;width:100%;background:${PAPER};padding:0 8px;">
            <tr>
              <td>
                <div style="font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:${INK_3};margin-bottom:18px;">
                  ${escapeHtml(email.kicker)}
                </div>
                <h1 style="font-weight:500;font-size:34px;line-height:1.06;letter-spacing:-.028em;color:${INK};margin:0 0 16px;">
                  ${escapeHtml(email.headlineLead)} <em style="font-family:Georgia,'IBM Plex Serif',serif;font-style:italic;font-weight:400;">${escapeHtml(email.headlineAccent)}</em>
                </h1>
                ${body}
                ${button}
                ${linkBlock}
                ${rule}
                ${footnotes}
              </td>
            </tr>
          </table>
          <p style="font-size:12.5px;color:${INK_3};margin:20px 0 0;">
            ${escapeHtml(emailFooter())}
          </p>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

/**
 * The same message for a client that refuses HTML. Tags are stripped rather
 * than re-authored: two hand-written versions of one paragraph drift, and the
 * one that drifts is always the plain-text one nobody reads.
 */
export function renderPaperText(email: PaperEmail): string {
  const lines = [
    `${email.headlineLead} ${email.headlineAccent}`,
    "",
    ...email.paragraphs.map((p) => stripTags(p)),
  ];
  if (email.cta) {
    lines.push("", `${email.cta.label.replace(/\s*→\s*$/, "")}:`, email.cta.url);
  }
  if (email.footnotes?.length) {
    lines.push("", ...email.footnotes);
  }
  return lines.join("\n");
}

function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}
