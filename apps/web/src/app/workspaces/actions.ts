/**
 * Server Actions behind the workspace settings dialog on the hub.
 */
"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { isSupabaseConfigured } from "@bcontext-dev/contract/env";
import { apiJson } from "@/web/api-client";
import { getSession } from "@/web/session";
import type { WorkspacePatch } from "@bcontext-dev/contract/workspaces";
import type { Workspace } from "@bcontext-dev/contract/types";

/**
 * Forms post here; the API does the work. The action takes `FormData` — the
 * settings dialog submits it — and its body is one call to the route that
 * owns the write, which is where "is this person an admin here" is decided.
 */

/** A session is required before the API is even asked; the API decides the rest. */
async function requireUser() {
  if (!isSupabaseConfigured()) {
    throw new Error("Authentication is not configured.");
  }
  const { data } = await (await getSession()).auth.getUser();
  if (!data.user) redirect("/login?next=/workspaces");
  return data.user;
}

/** Every workspace route takes the `<org>~<workspace>` ref as one segment. */
const wsPath = (ref: string) => `/api/workspaces/${encodeURIComponent(ref)}`;

/* -------------------------------------------------------------------------- */
/*  Workspace — rename / accent                                                */
/* -------------------------------------------------------------------------- */

/**
 * Rename and/or re-tint a workspace. `slug` in the form is the `<org>~<workspace>`
 * ref, not the bare slug; fields left empty are simply not patched.
 */
export async function updateWorkspaceAction(formData: FormData) {
  await requireUser();
  const ref = String(formData.get("slug") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  const rawAccent = String(formData.get("accent_hue") ?? "").trim();
  const accentHue = rawAccent === "" ? null : Number.parseInt(rawAccent, 10);
  const accentGradient = String(formData.get("accent_gradient") ?? "").trim();

  const patch: WorkspacePatch = {};
  if (name) patch.name = name;
  if (accentHue !== null && Number.isFinite(accentHue) && accentHue >= 0 && accentHue <= 360) {
    patch.accent_hue = accentHue;
  }
  if (accentGradient) patch.accent_gradient = accentGradient;

  if (Object.keys(patch).length === 0) {
    revalidatePath("/workspaces");
    return;
  }

  await apiJson<{ workspace: Workspace }>(wsPath(ref), {
    method: "PATCH",
    json: patch,
  });

  revalidatePath("/workspaces");
}
