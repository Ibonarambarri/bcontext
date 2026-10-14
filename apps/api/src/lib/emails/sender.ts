/**
 * Who the instance's emails are from, and how they sign off.
 *
 * Every letter the product sends (invitations, Nexo escalations, the weekly
 * digest) reads these instead of a hard-coded domain: a self-hosted instance
 * can only send from an address it owns, so there is no default sender. With
 * no `EMAIL_FROM` the senders skip, the same as with no `RESEND_API_KEY`.
 *
 * Read at call time: tests set and unset the env per case.
 */
import { appBaseUrl } from "@/lib/app-url";

/** `EMAIL_FROM` — RFC 5322 from address ("Acme Context <no-reply@acme.com>"), or null. */
export function emailFrom(): string | null {
  const raw = process.env.EMAIL_FROM?.trim();
  return raw ? raw : null;
}

/** `INSTANCE_NAME` — how the instance names itself in emails; "Bcontext" by default. */
export function instanceName(): string {
  return process.env.INSTANCE_NAME?.trim() || "Bcontext";
}

/** The line under every email: the instance's name and the host of its web app. */
export function emailFooter(): string {
  let host = "";
  try {
    host = new URL(appBaseUrl()).host;
  } catch {
    // An unparsable or missing APP_URL drops the host, never the email.
  }
  return host ? `${instanceName()} · ${host}` : instanceName();
}
