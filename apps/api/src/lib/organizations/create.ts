/**
 * Creating an organization: the row itself, and the self-service path where a
 * signed-in person creates one, becomes its owner and gets a first workspace.
 *
 * Called by `POST /api/organizations` (`createOrganizationForUser`), by the
 * instance admin's create-and-invite flow in `@/lib/admin/orgs`
 * (`insertOrganization`), and by `/api/me` and `/api/signup`
 * (`orgCreationPolicy`, `mayCreateOrganization`).
 *
 * Who may create one is the instance's choice, `ORG_CREATION`:
 *   open   (default) any signed-in person — and anyone may sign up;
 *   admin  only the instance admins (`ADMIN_EMAILS`), who invite the owners.
 *
 * Must not break: an organization nobody can open is worse than none, so a
 * failure after the row is written (membership, first workspace) undoes it,
 * and pressing the button again is a clean retry.
 */
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { baseSlug, disambiguate } from "@/lib/slugs";
import { isAdminEmail } from "@/lib/admin/access";
import { createWorkspaceForUser, WorkspaceCreateError } from "@/lib/workspaces/registry";
import { log } from "@bcontext-dev/contract/log";
import {
  ORG_NAME_MAX,
  type CreateOrganizationResult,
  type CreatedOrganization,
  type OrgCreationPolicy,
} from "@bcontext-dev/contract/organizations";

/** The first workspace's name when the caller does not give one. */
export const DEFAULT_FIRST_WORKSPACE = "General";

export class OrgCreateError extends Error {
  constructor(
    readonly status: 400 | 403 | 409 | 503,
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "OrgCreateError";
  }
}

/** `ORG_CREATION`, read per call so a test (or an operator) can flip it. */
export function orgCreationPolicy(): OrgCreationPolicy {
  const raw = (process.env.ORG_CREATION ?? "").trim().toLowerCase();
  return raw === "admin" ? "admin" : "open";
}

/** Whether a person with this address may create an organization here. */
export function mayCreateOrganization(email: string | null | undefined): boolean {
  return orgCreationPolicy() === "open" || isAdminEmail(email);
}

/**
 * Write the organization row.
 *
 * Without `slug` the address comes from the name and is disambiguated
 * (`acme`, `acme-2`). With `strictSlug`, a slug given explicitly is taken as
 * is or refused — the self-service form shows the address the person typed,
 * and handing back a different one would be a surprise.
 */
export async function insertOrganization(input: {
  name: string;
  slug?: string;
  strictSlug?: boolean;
}): Promise<CreatedOrganization> {
  const admin = getSupabaseAdmin();
  const wanted = baseSlug(input.slug?.trim() || input.name, "org");
  // Organization slugs are unique across the instance.
  const { data: existing } = await admin.from("organizations").select("slug");
  const taken = ((existing ?? []) as Array<{ slug: string }>).map((o) => o.slug);
  let slug = wanted;
  if (input.slug?.trim() && input.strictSlug) {
    if (taken.some((t) => t.toLowerCase() === wanted)) {
      throw new OrgCreateError(409, "slug_taken", `The address "${wanted}" is already in use.`);
    }
  } else {
    slug = disambiguate(wanted, taken);
  }

  const { data, error } = await admin
    .from("organizations")
    .insert({ slug, name: input.name })
    .select("id, slug, name, created_at")
    .single();
  if (error || !data) {
    // A unique violation here is a race with another create of the same slug.
    if (error?.code === "23505") {
      throw new OrgCreateError(409, "slug_taken", `The address "${slug}" is already in use.`);
    }
    throw new Error(`insertOrganization: ${error?.message ?? "no row"}`);
  }
  return data as CreatedOrganization;
}

/**
 * A signed-in person creates an organization: the row, their owner
 * membership, and a first workspace they own, in that order.
 */
export async function createOrganizationForUser(input: {
  userId: string;
  email: string | null;
  name: string;
  slug?: string;
  workspaceName?: string;
}): Promise<CreateOrganizationResult> {
  if (!mayCreateOrganization(input.email)) {
    throw new OrgCreateError(
      403,
      "org_creation_restricted",
      "On this instance, organizations are created by an administrator.",
    );
  }
  const name = input.name.trim().slice(0, ORG_NAME_MAX);
  if (!name) throw new OrgCreateError(400, "invalid_name", "The organization needs a name.");

  const org = await insertOrganization({ name, slug: input.slug, strictSlug: true });
  const admin = getSupabaseAdmin();

  const undo = async () => {
    await admin.from("organization_memberships").delete().eq("organization_id", org.id);
    await admin.from("organizations").delete().eq("id", org.id);
  };

  const { error: memberErr } = await admin.from("organization_memberships").insert({
    user_id: input.userId,
    organization_id: org.id,
    role: "owner",
  });
  if (memberErr) {
    await undo();
    throw new OrgCreateError(503, "membership_failed", memberErr.message);
  }

  let workspace;
  try {
    workspace = await createWorkspaceForUser(input.userId, {
      organization: org.id,
      name: input.workspaceName?.trim() || DEFAULT_FIRST_WORKSPACE,
    });
  } catch (err) {
    // Deleting the organization cascades to anything the workspace create
    // managed to write, so a retry starts clean.
    await undo();
    if (err instanceof WorkspaceCreateError && err.status === 400) {
      throw new OrgCreateError(400, err.code, err.message);
    }
    throw err;
  }

  log.info("organization.created", {
    organization_id: org.id,
    slug: org.slug,
    workspace_id: workspace.id,
    policy: orgCreationPolicy(),
  });

  return { organization: org, workspace };
}
