/**
 * Server Actions for the invite page's inline sign-in / sign-up. The invite
 * itself lives in the API (`/api/invites/:token`); only the Supabase session
 * is written here. Both actions end by bouncing back to `/invite/<token>`,
 * where the page accepts the invitation for the now-signed-in person.
 */
"use server";

import { redirect } from "next/navigation";
import { isSupabaseConfigured } from "@bcontext-dev/contract/env";
import { ApiError, apiJson, apiJsonOrNull } from "@/web/api-client";
import { getSession } from "@/web/session";
import type { InvitePreview } from "@bcontext-dev/contract/workspaces";

export type InviteAuthState = {
  error?: string;
};

const MIN_PASSWORD = 6;

const invitePath = (token: string) => `/api/invites/${encodeURIComponent(token)}`;

async function lookupInvite(token: string): Promise<InvitePreview | null> {
  const found = await apiJsonOrNull<{ invite: InvitePreview }>(invitePath(token));
  return found?.invite ?? null;
}

/**
 * Sign in an existing user from the invite page and bounce them back to
 * `/invite/<token>` so the page-level auto-accept can finish the flow.
 */
export async function inviteSignInAction(
  _prev: InviteAuthState,
  formData: FormData,
): Promise<InviteAuthState> {
  if (!isSupabaseConfigured()) {
    return { error: "Accounts are not available here." };
  }
  const token = String(formData.get("token") ?? "");
  const password = String(formData.get("password") ?? "");
  if (!token) return { error: "Missing invitation token." };

  const invite = await lookupInvite(token);
  if (!invite) {
    return {
      error: "This invitation no longer works. Ask for a new one.",
    };
  }

  if (password.length < MIN_PASSWORD) {
    return { error: `Password must be at least ${MIN_PASSWORD} characters.` };
  }

  // Supabase Auth, not our API: the session is the one thing the web side
  // still talks to Supabase about.
  const supabase = await getSession();
  const { error } = await supabase.auth.signInWithPassword({
    email: invite.email,
    password,
  });
  if (error) {
    return { error: error.message };
  }
  redirect(`/invite/${token}`);
}

/**
 * Create an account for a brand-new invitee. The API owns the creation
 * (`POST /api/invites/:token/signup` — the token is the access ticket while
 * signup is closed); this signs the new person in with the password they
 * chose and bounces to `/invite/<token>`, which then auto-accepts.
 */
export async function inviteSignUpAction(
  _prev: InviteAuthState,
  formData: FormData,
): Promise<InviteAuthState> {
  if (!isSupabaseConfigured()) {
    return { error: "Accounts are not available here." };
  }
  const token = String(formData.get("token") ?? "");
  const password = String(formData.get("password") ?? "");
  const confirm = String(formData.get("confirm") ?? "");
  const firstName = String(formData.get("first_name") ?? "").trim();
  const lastName = String(formData.get("last_name") ?? "").trim();
  if (!token) return { error: "Missing invitation token." };
  if (!firstName) return { error: "Tell us your name." };
  if (password.length < MIN_PASSWORD) {
    return { error: `Password must be at least ${MIN_PASSWORD} characters.` };
  }
  if (confirm && confirm !== password) {
    return { error: "Passwords don't match." };
  }

  let email: string;
  try {
    // The name is asked for here because this is the one moment an account
    // is created: without it the product's first sentence to this person
    // would call them by their email address.
    ({ email } = await apiJson<{ email: string }>(`${invitePath(token)}/signup`, {
      method: "POST",
      json: { password, first_name: firstName, last_name: lastName },
    }));
  } catch (err) {
    if (err instanceof ApiError) {
      return {
        error:
          err.status === 404
            ? "This invitation no longer works. Ask for a new one."
            : err.message,
      };
    }
    throw err;
  }

  const supabase = await getSession();
  const { error: signInErr } = await supabase.auth.signInWithPassword({
    email,
    password,
  });
  if (signInErr) {
    return { error: signInErr.message };
  }
  redirect(`/invite/${token}`);
}
