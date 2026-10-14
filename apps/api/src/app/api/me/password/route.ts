/**
 * POST /api/me/password — change the password of the signed-in account.
 *
 * A change, not a reset: the current password is the proof of presence, so a
 * borrowed session cannot lock its owner out. There is no Supabase call that
 * both verifies and replaces, so this does it in two steps — sign in on a
 * throwaway client to check the old password, then set the new one with the
 * service role. The throwaway client persists nothing; the caller's session
 * is untouched and stays valid.
 *
 * The reset-by-email flow (`/forgot` → `/auth/reset`) stays as it is, for the
 * person who cannot supply the current password because they have forgotten
 * it. This is the other half: the one who knows it and wants a new one.
 */
import { z } from "zod";
import { gate } from "@/lib/auth/require";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { getSupabaseAnon } from "@/lib/supabase/anon";
import { readJsonBody } from "@/lib/parse-json";
import { withRoute } from "@/lib/route";
import { hasPasswordIdentity } from "@/lib/auth/profile";
import { MIN_PASSWORD_LENGTH } from "@bcontext-dev/contract/me";

const Body = z.object({
  current_password: z.string().min(1, "Enter your current password."),
  new_password: z
    .string()
    .min(
      MIN_PASSWORD_LENGTH,
      `The new password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
    )
    .max(200),
});

export const POST = withRoute(async (req: Request) => {
  const gated = await gate(req);
  if (gated instanceof Response) return gated;
  if (gated.kind !== "user") {
    return Response.json(
      { error: "user_session_required", message: "Sign in to change your password." },
      { status: 401 },
    );
  }

  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = Body.safeParse(parsed.data);
  if (!body.success) {
    return Response.json(
      { error: "invalid_body", message: body.error.issues[0]?.message ?? "invalid body" },
      { status: 400 },
    );
  }
  if (body.data.current_password === body.data.new_password) {
    return Response.json(
      { error: "same_password", message: "The new password is the one you already have." },
      { status: 400 },
    );
  }

  const admin = getSupabaseAdmin();
  const { data: found } = await admin.auth.admin.getUserById(gated.userId);
  const user = found?.user ?? null;
  const email = user?.email ?? null;
  if (!email || !hasPasswordIdentity(user)) {
    return Response.json(
      {
        error: "no_password_identity",
        message: "This account signs in without a password, so there is none to change.",
      },
      { status: 409 },
    );
  }

  const check = getSupabaseAnon();
  const { error: signInErr } = await check.auth.signInWithPassword({
    email,
    password: body.data.current_password,
  });
  if (signInErr) {
    return Response.json(
      { error: "wrong_password", message: "That is not your current password." },
      { status: 403 },
    );
  }
  // The verification session is of no use to anyone; do not leave it open.
  await check.auth.signOut().catch(() => {});

  const { error: updateErr } = await admin.auth.admin.updateUserById(gated.userId, {
    password: body.data.new_password,
  });
  if (updateErr) {
    return Response.json(
      { error: "update_failed", message: updateErr.message },
      { status: 400 },
    );
  }

  return Response.json({ ok: true });
});
