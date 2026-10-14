/**
 * POST /api/onboarding/dismiss — the person closes the "Getting started"
 * guide for good, in every workspace they have or will join. No body: there
 * is nothing to choose. Idempotent — a second call keeps the first stamp, so
 * "when did they dismiss it" stays an honest answer.
 *
 * The stamp lives in the auth user's `user_metadata`, next to the name,
 * for the reason `@/lib/auth/profile` gives: one row per person already
 * exists on the auth server, and a table for one timestamp would be a
 * second source of truth. Session-cookie callers only.
 */
import { gate } from "@/lib/auth/require";
import { withRoute } from "@/lib/route";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import {
  ONBOARDING_DISMISSED_KEY,
  onboardingDismissedAt,
  type OnboardingDismissal,
} from "@bcontext-dev/contract/onboarding";

export const POST = withRoute(async (req: Request) => {
  const gated = await gate(req);
  if (gated instanceof Response) return gated;
  if (gated.kind !== "user") {
    return Response.json(
      { error: "user_session_required", message: "Sign in to dismiss the guide." },
      { status: 401 },
    );
  }

  const admin = getSupabaseAdmin();
  const { data: current } = await admin.auth.admin.getUserById(gated.userId);
  const existing = (current?.user?.user_metadata ?? {}) as Record<string, unknown>;
  const already = onboardingDismissedAt(existing);
  if (already) {
    const body: OnboardingDismissal = { dismissed_at: already };
    return Response.json(body);
  }

  // `updateUserById` replaces `user_metadata` wholesale: merge, never send
  // the one key alone, or the name and signup provenance go with it.
  const dismissed_at = new Date().toISOString();
  const { error } = await admin.auth.admin.updateUserById(gated.userId, {
    user_metadata: { ...existing, [ONBOARDING_DISMISSED_KEY]: dismissed_at },
  });
  if (error) {
    return Response.json({ error: "internal", message: error.message }, { status: 500 });
  }
  const body: OnboardingDismissal = { dismissed_at };
  return Response.json(body);
});
