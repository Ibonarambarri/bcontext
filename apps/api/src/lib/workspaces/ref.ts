/**
 * A workspace's full name, `<org>/<workspace>`, resolved from the row.
 *
 * Anything that hands a workspace's name to somebody outside the server —
 * an MCP reply, an agent-facing payload, a link — has to say which
 * organization it belongs to, because the slug alone is unique only inside
 * one. The organization slug is not on the workspace row, so it takes a
 * lookup; callers hold it for the length of a request, which is why this is
 * a plain function and not a cache.
 */
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { workspaceRefName } from "@bcontext-dev/contract/workspace-ref";

export async function workspaceRefFor(workspace: {
  organization_id: string;
  slug: string;
}): Promise<string> {
  try {
    const { data } = await getSupabaseAdmin()
      .from("organizations")
      .select("slug")
      .eq("id", workspace.organization_id)
      .maybeSingle();
    const org = (data?.slug as string | undefined) ?? null;
    // Demo storage has no organizations table behind it; the bare slug is
    // the honest answer there, and nothing resolves it back anyway.
    return org ? workspaceRefName(org, workspace.slug) : workspace.slug;
  } catch {
    return workspace.slug;
  }
}
