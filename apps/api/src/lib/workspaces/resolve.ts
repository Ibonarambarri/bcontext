/**
 * The workspace a request names, for the handful of places that need the row
 * rather than a `Storage`.
 *
 * Most routes go through `openWorkspace`, which resolves and authorises in one
 * step. A few need only the row — an agent roster, a migration status — and
 * used to look it up with `.eq("slug", …)`. That worked while every workspace
 * had an organization to itself and stopped working the moment they did not:
 * a slug is unique inside its organization, so on its own it names one
 * workspace per organization that chose it.
 */
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { parseWorkspaceRef } from "@bcontext-dev/contract/workspace-ref";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Accepts `<org>/<workspace>`, `<org>~<workspace>` or a workspace id, and
 * refuses a bare slug rather than guessing an organization on the caller's
 * behalf — which is how somebody ends up reading another company's roster.
 */
export async function findWorkspaceByRef(
  named: string,
  columns = "id, slug, name, organization_id",
): Promise<Record<string, unknown> | null> {
  const value = (named ?? "").trim();
  if (!value) return null;
  const admin = getSupabaseAdmin();

  if (UUID.test(value)) {
    const { data } = await admin
      .from("workspaces")
      .select(columns)
      .eq("id", value)
      .maybeSingle();
    return data ?? null;
  }

  const ref = parseWorkspaceRef(value);
  if (!ref) return null;
  const { data } = await admin
    .from("workspaces")
    .select(`${columns}, organization:organizations!inner(slug)`)
    .eq("slug", ref.workspace)
    .eq("organization.slug", ref.org)
    .maybeSingle();
  return data ?? null;
}
