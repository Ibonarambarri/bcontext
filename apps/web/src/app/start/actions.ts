"use server";

/**
 * The two server actions behind `/start`: sign up (account + organization in
 * one form) and create an organization for somebody already signed in.
 *
 * They are actions rather than `fetch` from the browser because the API's
 * same-origin guard and rate limit key on the request, and `apiJson`
 * forwards the person's own origin and cookies. Signing in after an account
 * that needs no confirmation goes through Supabase Auth here
 * (`getSession`), which writes the session cookie into this action's jar —
 * the jar `apiJson` reads, so the `POST /api/organizations` right after it
 * already travels as the new person.
 *
 * Must not break: `redirect()` throws, so it is never called inside a
 * `try`; and an account is never left half-made without telling the person
 * where to continue (`/start` picks up a signed-in person with no
 * organization).
 */
import { redirect } from "next/navigation";
import type { Route } from "next";
import { ApiError, apiJson } from "@/web/api-client";
import { getSession } from "@/web/session";
import { workspacePath } from "@/web/workspace-url";
import { MIN_PASSWORD_LENGTH, type SignupResult } from "@bcontext-dev/contract/me";
import {
  ORG_NAME_MAX,
  type CreateOrganizationResult,
} from "@bcontext-dev/contract/organizations";

export interface SignupState {
  error?: string;
  /** The account waits for the confirmation link sent to this address. */
  sent?: { email: string; organization: string };
}

export interface OrganizationState {
  error?: string;
}

function message(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    const body = err.body as { message?: string; error?: string } | null;
    return body?.message ?? body?.error ?? fallback;
  }
  return fallback;
}

function organizationName(formData: FormData): { name: string; error?: string } {
  const name = String(formData.get("organization_name") ?? "").trim();
  if (!name) return { name, error: "What's the organization called?" };
  if (name.length > ORG_NAME_MAX) {
    return { name, error: `Keep the name under ${ORG_NAME_MAX} characters.` };
  }
  return { name };
}

/** Create the organization as the signed-in person; the path of its first workspace, or an error. */
async function createOrganization(name: string): Promise<{ path?: string; error?: string }> {
  try {
    const { organization, workspace } = await apiJson<CreateOrganizationResult>(
      "/api/organizations",
      { method: "POST", body: JSON.stringify({ name }) },
    );
    return { path: workspacePath({ org: organization.slug, slug: workspace.slug }) };
  } catch (err) {
    return { error: message(err, "We couldn't create the organization. Try again.") };
  }
}

/** Account and organization in one go — or, when the address needs confirming, the account now and the organization after the link. */
export async function signupAction(
  _prev: SignupState,
  formData: FormData,
): Promise<SignupState> {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");
  const confirm = String(formData.get("confirm") ?? "");
  const firstName = String(formData.get("first_name") ?? "").trim();
  const lastName = String(formData.get("last_name") ?? "").trim();
  const org = organizationName(formData);

  if (!firstName) return { error: "Tell us your name." };
  if (!email.includes("@")) return { error: "Enter a valid email address." };
  if (password.length < MIN_PASSWORD_LENGTH) {
    return { error: `Use at least ${MIN_PASSWORD_LENGTH} characters.` };
  }
  // Checked here and not by the API: the API never sees the second field,
  // and a typo in a password nobody can read back locks the person out of
  // the account they just made.
  if (password !== confirm) return { error: "The two passwords don't match." };
  if (org.error) return { error: org.error };

  let result: SignupResult;
  try {
    result = await apiJson<SignupResult>("/api/signup", {
      method: "POST",
      body: JSON.stringify({
        email,
        password,
        first_name: firstName,
        last_name: lastName || undefined,
      }),
    });
  } catch (err) {
    return { error: message(err, "We couldn't create the account. Try again.") };
  }

  if (result.confirmation === "email_sent") {
    return { sent: { email: result.email, organization: org.name } };
  }

  // No email transport on this instance: the account is already confirmed,
  // so sign in and create the organization now.
  const { error: signInError } = await (await getSession()).auth.signInWithPassword({
    email,
    password,
  });
  if (signInError) redirect("/login?next=/start" as Route);

  const created = await createOrganization(org.name);
  if (!created.path) {
    // Signed in, organization missing: `/start` asks for it again.
    redirect(`/start?error=${encodeURIComponent(created.error ?? "")}` as Route);
  }
  redirect(created.path as Route);
}

/** A signed-in person with no organization names one. */
export async function createOrganizationAction(
  _prev: OrganizationState,
  formData: FormData,
): Promise<OrganizationState> {
  const org = organizationName(formData);
  if (org.error) return { error: org.error };
  const created = await createOrganization(org.name);
  if (!created.path) return { error: created.error };
  redirect(created.path as Route);
}
