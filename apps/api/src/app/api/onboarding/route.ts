/**
 * GET /api/onboarding?workspace=<org>/<ws> — the "Getting started" checklist
 * for the person asking, derived from the workspace on every read (see
 * `@bcontext-dev/contract/onboarding`). The dismissal comes from the
 * person's own auth metadata, so it follows them across workspaces.
 *
 * Session-cookie callers only: an agent has no guide to follow, and the
 * dismissal is a property of a person. Membership is proven by
 * `openWorkspace`, which is also what turns a workspace the caller cannot
 * see into a 404 rather than a 403.
 */
import { openWorkspace } from "@/lib/auth/workspace";
import { withRoute } from "@/lib/route";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { readOnboardingFacts } from "@/lib/onboarding/facts";
import {
  ONBOARDING_STEP_IDS,
  onboardingCompleted,
  onboardingDismissedAt,
  onboardingSteps,
  type Onboarding,
  type OnboardingFacts,
} from "@bcontext-dev/contract/onboarding";

export const GET = withRoute(async (req: Request) => {
  const workspace = new URL(req.url).searchParams.get("workspace")?.trim();
  const opened = await openWorkspace(req, workspace, "read", { scope: null });
  if (opened instanceof Response) return opened;
  if (opened.actor.kind !== "user") {
    return Response.json(
      { error: "user_session_required", message: "The guide is for people, not tokens." },
      { status: 401 },
    );
  }

  // The demo backend has none of the tables the facts live in; a demo
  // workspace simply has nothing done yet, which is also true.
  let facts: OnboardingFacts;
  let dismissedAt: string | null = null;
  if (opened.storage.backend === "supabase") {
    const admin = getSupabaseAdmin();
    const [read, { data: current }] = await Promise.all([
      readOnboardingFacts(admin, {
        workspaceId: opened.storage.workspace.id,
        userId: opened.actor.userId,
      }),
      admin.auth.admin.getUserById(opened.actor.userId),
    ]);
    facts = read;
    dismissedAt = onboardingDismissedAt(current?.user?.user_metadata);
  } else {
    facts = Object.fromEntries(ONBOARDING_STEP_IDS.map((id) => [id, false])) as OnboardingFacts;
  }

  const steps = onboardingSteps(facts);
  const body: Onboarding = {
    workspace: workspace!,
    steps,
    completed: onboardingCompleted(steps),
    dismissed_at: dismissedAt,
  };
  return Response.json(body);
});
