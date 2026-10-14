/**
 * Server Actions behind the sign-in and password-recovery forms.
 *
 * Auth is the one thing the web app does not route through the API: these
 * talk to Supabase Auth via `getSession()` and let it write the session
 * cookie. The only API read here is `/api/workspaces`, to decide where a
 * freshly signed-in person lands. Every `next` is filtered to a same-site
 * path before it is followed — the forms are reachable from any link.
 */
"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { appOrigin } from "@/web/public-origin";
import type { Route } from "next";
import { isSupabaseConfigured } from "@bcontext-dev/contract/env";
import { getSession } from "@/web/session";

/** What `useActionState` carries back to the form: one error or one notice. */
export type AuthState = {

  error?: string;
  message?: string;
};

function parseCredentials(formData: FormData): {
  email: string;
  password: string;
  next: string | null;
  error?: string;
} {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");
  const rawNext = String(formData.get("next") ?? "");
  const next =
    rawNext.startsWith("/") && !rawNext.startsWith("//") ? rawNext : null;
  if (!email || !email.includes("@")) {
    return { email, password, next, error: "Enter a valid email address." };
  }
  if (password.length < 6) {
    return {
      email,
      password,
      next,
      error: "Password must be at least 6 characters.",
    };
  }
  return { email, password, next };
}

/**
 * Password sign-in. Without Supabase configured (demo) there is nobody to
 * sign in as, so the hub is the answer straight away.
 */
export async function signInAction(

  _prev: AuthState,
  formData: FormData,
): Promise<AuthState> {
  if (!isSupabaseConfigured()) {
    redirect("/workspaces");
  }
  const { email, password, next, error } = parseCredentials(formData);
  if (error) return { error };

  const supabase = await getSession();
  const { error: signInError } = await supabase.auth.signInWithPassword({
    email,
    password,
  });
  if (signInError) {
    return { error: signInError.message };
  }

  // Honour ?next= (used by /invite/[token] and any deep link). Already
  // filtered by `parseCredentials` to a path of our own: `/auth/callback`
  // and `/auth/confirm` check the same thing, and a sign-in that forwarded
  // to wherever the query string said is an open redirect.
  if (next) redirect(next as Route);

  // The hub, whatever they have: it sends somebody with no organization to
  // create one (or tells them who can invite them), and does it in one place.
  redirect("/workspaces");
}

/**
 * Send a password-recovery email. The link routes through /auth/confirm
 * (the implicit-grant fragment bridge — same path invites use) which sets
 * the session client-side and forwards to /auth/reset.
 *
 * Always answers with the same neutral message whether or not the email
 * has an account, so the form can't be used to enumerate users. Supabase
 * applies its own per-email rate limit on recovery sends.
 */
export async function forgotPasswordAction(
  _prev: AuthState,
  formData: FormData,
): Promise<AuthState> {
  if (!isSupabaseConfigured()) {
    return { error: "Authentication is not configured on this deployment." };
  }
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  if (!email || !email.includes("@")) {
    return { error: "Enter a valid email address." };
  }

  const base = appOrigin(await headers());
  const redirectTo =
    `${base}/auth/confirm?next=` + encodeURIComponent("/auth/reset");

  const supabase = await getSession();
  // Errors (rate limit, SMTP hiccup) are deliberately not surfaced —
  // differentiating them would leak which addresses exist.
  await supabase.auth.resetPasswordForEmail(email, { redirectTo });

  return {
    // Says the same thing whether or not the address exists: which addresses
    // have accounts is not something this form tells strangers.
    message: "Check your inbox. The reset link is on its way.",
  };
}
