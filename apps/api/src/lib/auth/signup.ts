/**
 * Self-service accounts: `POST /api/signup` on an instance with
 * `ORG_CREATION=open`. On an `admin` instance accounts arrive only by
 * invitation (`/api/invites/:token/signup`), so this refuses.
 *
 * The account is created through the service role (`generateLink`), which
 * works whether or not public signups are enabled on the auth server, and
 * hands the confirmation link back instead of sending GoTrue's default mail.
 * With an email transport configured the link goes out in our own letter and
 * the account waits for it; without one there is nobody to send it, so the
 * account is confirmed on creation — the operator chose an open instance
 * without email, and a person who can never confirm is worse than one whose
 * address was not proven.
 *
 * Must not break: an account whose confirmation could not be built or
 * sent is deleted and the call fails (503 `confirm_email_failed`), so the
 * person is never told to check an inbox that nothing reached, and a retry
 * is never told the address is taken.
 */
import { Resend } from "resend";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { supabaseConfigured } from "@/lib/env";
import { appBaseUrl } from "@/lib/app-url";
import { emailFrom, instanceName } from "@/lib/emails/sender";
import { nameMetadata } from "@/lib/auth/profile";
import { orgCreationPolicy } from "@/lib/organizations/create";
import {
  escapeHtml,
  renderPaperHtml,
  renderPaperText,
  type PaperEmail,
} from "@/lib/emails/paper";
import { log } from "@bcontext-dev/contract/log";
import type { SignupResult } from "@bcontext-dev/contract/me";

export class SignupError extends Error {
  constructor(
    readonly status: 400 | 403 | 409 | 503,
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "SignupError";
  }
}

/** Whether an account already exists for this address, and whether it is confirmed. */
async function accountStateFor(
  email: string,
): Promise<{ userId: string | null; emailConfirmed: boolean }> {
  const { data, error } = await getSupabaseAdmin().rpc("account_state_for_email", {
    p_email: email,
  });
  if (error) throw new SignupError(503, "lookup_failed", error.message);
  const row = Array.isArray(data) ? (data[0] as { user_id?: string; email_confirmed?: boolean }) : null;
  return { userId: row?.user_id ?? null, emailConfirmed: row?.email_confirmed === true };
}

/** `/auth/confirm` turns GoTrue's fragment into a session, then the hub offers to create an organization. */
function confirmRedirect(): string {
  return `${appBaseUrl()}/auth/confirm?next=${encodeURIComponent("/workspaces")}`;
}

/**
 * Create the account, unconfirmed, and the link that confirms it.
 * `generateLink({type:"signup"})` is refused by some GoTrue builds when
 * public signups are disabled; creating the user and minting a magic link
 * reaches the same place.
 */
async function createUnconfirmedAccount(input: {
  email: string;
  password: string;
  metadata: Record<string, unknown>;
}): Promise<{ userId: string; confirmUrl: string }> {
  const admin = getSupabaseAdmin();
  const redirectTo = confirmRedirect();
  const signup = await admin.auth.admin.generateLink({
    type: "signup",
    email: input.email,
    password: input.password,
    options: { data: input.metadata, redirectTo },
  });
  if (!signup.error && signup.data?.properties?.action_link && signup.data.user) {
    return { userId: signup.data.user.id, confirmUrl: signup.data.properties.action_link };
  }
  log.warn("signup.link_fallback", { error: signup.error?.message ?? "no action link" });

  const created = await admin.auth.admin.createUser({
    email: input.email,
    password: input.password,
    email_confirm: false,
    user_metadata: input.metadata,
  });
  if (created.error || !created.data.user) {
    throw new SignupError(400, "create_failed", created.error?.message ?? "Could not create the account.");
  }
  const magic = await admin.auth.admin.generateLink({
    type: "magiclink",
    email: input.email,
    options: { redirectTo },
  });
  if (magic.error || !magic.data?.properties?.action_link) {
    await admin.auth.admin.deleteUser(created.data.user.id);
    throw new SignupError(503, "confirm_link_failed", magic.error?.message ?? "Could not build a confirmation link.");
  }
  return { userId: created.data.user.id, confirmUrl: magic.data.properties.action_link };
}

function confirmEmail(confirmUrl: string, firstName: string): PaperEmail {
  return {
    kicker: `${instanceName().toLowerCase()} · confirm your email`,
    headlineLead: "One click and",
    headlineAccent: "you're in.",
    paragraphs: [
      `${escapeHtml(firstName)}, confirm this address to finish creating your account. Then sign in and create your organization.`,
    ],
    cta: { label: "Confirm my email →", url: confirmUrl },
    footnotes: [
      "Didn't ask for this? Ignore the message — the account stays unconfirmed and unusable.",
    ],
    subject: `Confirm your email · ${instanceName()}`,
  };
}

/**
 * Send the confirmation; `skipped` when the instance has no email transport
 * (no `RESEND_API_KEY` or no `EMAIL_FROM`, `@/lib/emails/sender`).
 */
async function sendConfirmEmail(
  to: string,
  email: PaperEmail,
): Promise<"sent" | "skipped" | "error"> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = emailFrom();
  if (!apiKey || !from) return "skipped";
  try {
    const result = await new Resend(apiKey).emails.send({
      from,
      to: [to],
      subject: email.subject,
      html: renderPaperHtml(email),
      text: renderPaperText(email),
      tags: [{ name: "type", value: "signup_confirm" }],
    });
    if (result.error) {
      log.error("signup.confirm_email_failed", { error: result.error.message ?? "resend error" });
      return "error";
    }
    return "sent";
  } catch (err) {
    log.error("signup.confirm_email_failed", { error: err instanceof Error ? err.message : String(err) });
    return "error";
  }
}

export async function signUp(input: {
  email: string;
  password: string;
  firstName: string;
  lastName?: string | null;
}): Promise<SignupResult> {
  if (orgCreationPolicy() !== "open") {
    throw new SignupError(403, "signup_closed", "Accounts on this instance are by invitation.");
  }
  if (!supabaseConfigured()) {
    throw new SignupError(503, "not_configured", "Signup needs the Supabase backend.");
  }
  const email = input.email.trim().toLowerCase();
  const admin = getSupabaseAdmin();

  const account = await accountStateFor(email);
  if (account.userId && account.emailConfirmed) {
    throw new SignupError(409, "account_exists", `There's already an account for ${email}. Sign in instead.`);
  }
  // An unconfirmed account for this address is an abandoned earlier attempt:
  // nothing was ever proven, so it is cleared and the person starts again.
  if (account.userId) {
    const { error } = await admin.auth.admin.deleteUser(account.userId);
    if (error) throw new SignupError(503, "reset_failed", `Couldn't clear the earlier attempt: ${error.message}`);
  }

  const metadata = {
    source: "signup",
    signup_complete: true,
    signup_completed_at: new Date().toISOString(),
    ...nameMetadata({ first_name: input.firstName, last_name: input.lastName ?? null }),
  };
  const { userId, confirmUrl } = await createUnconfirmedAccount({
    email,
    password: input.password,
    metadata,
  });

  const firstName = input.firstName.trim().split(/\s+/)[0] || "Hi";
  const mail = await sendConfirmEmail(email, confirmEmail(confirmUrl, firstName));
  if (mail === "error") {
    // Nobody can confirm an account whose letter never left; keeping it would
    // only make the next attempt look like a taken address.
    await admin.auth.admin.deleteUser(userId);
    throw new SignupError(
      503,
      "confirm_email_failed",
      "We couldn't send the confirmation email. Try again in a few minutes.",
    );
  }
  if (mail === "skipped") {
    const { error } = await admin.auth.admin.updateUserById(userId, { email_confirm: true });
    if (error) {
      await admin.auth.admin.deleteUser(userId);
      throw new SignupError(503, "confirm_failed", error.message);
    }
  }
  log.info("signup.account_created", {
    email_domain: email.split("@")[1] ?? null,
    confirmation: mail,
  });
  return { email, confirmation: mail === "skipped" ? "not_required" : "email_sent" };
}
