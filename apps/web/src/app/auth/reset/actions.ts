/**
 * Server Action behind the new-password form. Talks to Supabase Auth only
 * (`getSession()`); the recovery session it needs was written by
 * `/auth/confirm` before the person reached the form.
 */
"use server";

import { redirect } from "next/navigation";
import type { Route } from "next";
import { isSupabaseConfigured } from "@bcontext-dev/contract/env";
import { getSession } from "@/web/session";

export type ResetPasswordState = {
  error?: string;
};

const MIN_LENGTH = 6;

/**
 * Set a new password from a recovery session. The recovery email's link
 * went through /auth/confirm, which turned the URL-fragment tokens into a
 * session cookie — by the time this action runs the user is authenticated,
 * so `updateUser` is all that's left: unlike somebody finishing an
 * invitation, there is no signup metadata to flip.
 */
export async function resetPasswordAction(
  _prev: ResetPasswordState,
  formData: FormData,
): Promise<ResetPasswordState> {
  if (!isSupabaseConfigured()) {
    return { error: "Authentication is not configured on this deployment." };
  }

  const password = String(formData.get("password") ?? "");
  const confirm = String(formData.get("confirm") ?? "");

  if (password.length < MIN_LENGTH) {
    return { error: `Password must be at least ${MIN_LENGTH} characters.` };
  }
  if (confirm !== password) {
    return { error: "Passwords don't match." };
  }

  const supabase = await getSession();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) {
    // Recovery session expired before the form was submitted.
    redirect("/forgot" as Route);
  }

  const { error } = await supabase.auth.updateUser({ password });
  if (error) {
    return { error: error.message };
  }

  redirect("/workspaces");
}
