"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { isSupabaseConfigured } from "@bcontext-dev/contract/env";
import { apiJson, ApiError } from "@/web/api-client";
import type {
  AdminInvite,
  CreateAdminOrgResult,
  SendInviteEmailResult,
} from "@bcontext-dev/contract/admin-orgs";

/**
 * The panel's writes. Creating an organization or an invitation produces a
 * link and nothing else; `sendInviteEmailAction` is the only one that puts a
 * message in someone's inbox, and it exists as its own action so it can
 * never happen as a side effect of creating something.
 */
async function call<T>(path: string, init: Parameters<typeof apiJson>[1]): Promise<T> {
  if (!isSupabaseConfigured()) {
    throw new Error("Authentication is not configured.");
  }
  try {
    return await apiJson<T>(path, init);
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      redirect("/login?next=/admin/orgs");
    }
    throw err instanceof ApiError ? new Error(err.message) : err;
  }
}

export interface OrgFormState {
  error?: string;
  created?: CreateAdminOrgResult;
}

export async function createOrgAction(
  _prev: OrgFormState,
  formData: FormData,
): Promise<OrgFormState> {
  const name = String(formData.get("name") ?? "").trim();
  const slug = String(formData.get("slug") ?? "").trim();
  const owner_email = String(formData.get("owner_email") ?? "").trim();
  const role = String(formData.get("role") ?? "owner");
  if (!name) return { error: "The organization needs a name." };
  if (!owner_email) return { error: "Who owns it? Enter their email." };
  try {
    const created = await call<CreateAdminOrgResult>("/api/admin/organizations", {
      method: "POST",
      json: { name, slug: slug || undefined, owner_email, role },
    });
    revalidatePath("/admin/orgs");
    return { created };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Couldn't create it." };
  }
}

export interface InviteFormState {
  error?: string;
  invite?: AdminInvite;
}

export async function createInviteAction(
  _prev: InviteFormState,
  formData: FormData,
): Promise<InviteFormState> {
  const orgId = String(formData.get("org_id") ?? "");
  const email = String(formData.get("email") ?? "").trim();
  const role = String(formData.get("role") ?? "admin");
  if (!orgId) return { error: "Missing organization." };
  if (!email) return { error: "Enter an email address." };
  try {
    const { invite } = await call<{ invite: AdminInvite }>(
      `/api/admin/organizations/${encodeURIComponent(orgId)}/invites`,
      { method: "POST", json: { email, role } },
    );
    revalidatePath(`/admin/orgs/${orgId}`);
    return { invite };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Couldn't invite them." };
  }
}

export interface SendEmailState {
  error?: string;
  sent?: SendInviteEmailResult;
}

/** The one irreversible action in the panel, and it takes a click of its own. */
export async function sendInviteEmailAction(
  _prev: SendEmailState,
  formData: FormData,
): Promise<SendEmailState> {
  const inviteId = String(formData.get("invite_id") ?? "");
  const orgId = String(formData.get("org_id") ?? "");
  if (!inviteId) return { error: "Missing invitation." };
  try {
    const sent = await call<SendInviteEmailResult>(
      `/api/admin/invites/${encodeURIComponent(inviteId)}/email`,
      { method: "POST" },
    );
    if (orgId) revalidatePath(`/admin/orgs/${orgId}`);
    return { sent };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Couldn't send it." };
  }
}

export async function revokeInviteAction(formData: FormData) {
  const orgId = String(formData.get("org_id") ?? "");
  const inviteId = String(formData.get("invite_id") ?? "");
  if (!orgId || !inviteId) throw new Error("Missing invitation.");
  await call(
    `/api/admin/organizations/${encodeURIComponent(orgId)}/invites/${encodeURIComponent(inviteId)}`,
    { method: "DELETE" },
  );
  revalidatePath(`/admin/orgs/${orgId}`);
}
