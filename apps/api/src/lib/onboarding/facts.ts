/**
 * The facts behind the "Getting started" checklist, read from the workspace
 * rather than stored — see `@bcontext-dev/contract/onboarding` for why.
 * Called by `GET /api/onboarding`; each fact is one existence query and the
 * four run together, so the route costs a single round of the pool.
 *
 * Every query goes through the admin client because the route has already
 * proven membership by hand; nothing here relies on RLS. Keep each fact an
 * existence check (`head` + count): the guide only asks "has this happened
 * once", never "how many times".
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { OnboardingFacts } from "@bcontext-dev/contract/onboarding";

export interface OnboardingSubject {
  workspaceId: string;
  /** Asking Nexo is personal: another member's conversation is not yours. */
  userId: string;
}

// The minimum a query builder must offer for `exists` to run it; typed this
// way so tests can hand in a fake without standing up a Supabase client.
type CountResult = PromiseLike<{ count: number | null; error: { message: string } | null }>;

async function exists(query: CountResult, fact: string): Promise<boolean> {
  const { count, error } = await query;
  if (error) throw new Error(`onboarding ${fact}: ${error.message}`);
  return (count ?? 0) > 0;
}

export async function readOnboardingFacts(
  admin: SupabaseClient,
  subject: OnboardingSubject,
): Promise<OnboardingFacts> {
  const head = { count: "exact" as const, head: true };
  const [connect_agent, first_agent_write, ask_nexo, connect_integration] = await Promise.all([
    // An approved, unrevoked connection is enough: the Agents page issued it.
    // Whether the agent then used it is what the next step answers.
    exists(
      admin
        .from("agent_workspace_access")
        .select("agent_id", head)
        .eq("workspace_id", subject.workspaceId)
        .is("revoked_at", null),
      "connect_agent",
    ),
    exists(
      admin
        .from("activity")
        .select("id", head)
        .eq("workspace_id", subject.workspaceId)
        .eq("actor_kind", "agent"),
      "first_agent_write",
    ),
    exists(
      admin
        .from("chat_sessions")
        .select("id", head)
        .eq("workspace_id", subject.workspaceId)
        .eq("user_id", subject.userId),
      "ask_nexo",
    ),
    exists(
      admin
        .from("connector_installs")
        .select("id", head)
        .eq("workspace_id", subject.workspaceId)
        .neq("status", "uninstalled"),
      "connect_integration",
    ),
  ]);
  return { connect_agent, first_agent_write, ask_nexo, connect_integration };
}
