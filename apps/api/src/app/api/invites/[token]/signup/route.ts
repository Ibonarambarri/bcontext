/**
 * POST /api/invites/:token/signup — an account for a brand-new invitee.
 *
 * Account creation is closed platform-wide during the private beta, so the
 * invite token IS the access ticket: holding a valid, unaccepted one for the
 * address is what lets this request through. The account is created
 * pre-confirmed with the chosen password and marked `signup_complete` so
 * `/auth/set-password` does not route them through the password page on their
 * next visit; the caller then signs in with that password, which is Supabase
 * Auth's business, not this API's.
 *
 * Refused for an address that already has a confirmed account — that person
 * should sign in — and a half-built row from an older invite is cleared first
 * so the create can succeed.
 */
import { z } from "zod";
import { gate } from "@/lib/auth/require";
import { readJsonBody } from "@/lib/parse-json";
import { withRoute } from "@/lib/route";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { findInviteByToken } from "@/lib/workspaces/orgs";
import { nameMetadata } from "@/lib/auth/profile";
import { MAX_NAME_LENGTH } from "@bcontext-dev/contract/me";

const MIN_PASSWORD = 6;

const Body = z.object({
  password: z.string().min(MIN_PASSWORD, `Password must be at least ${MIN_PASSWORD} characters.`),
  // The name is asked for here because this is the only moment an account is
  // created: skip it and the person's first sight of the product calls them
  // by their email address.
  first_name: z.string().max(MAX_NAME_LENGTH).optional(),
  last_name: z.string().max(MAX_NAME_LENGTH).optional(),
});

export const POST = withRoute(async (
  req: Request,
  { params }: { params: Promise<{ token: string }> },
) => {
  // Nobody is signed in yet, by definition. The gate still applies the
  // same-origin check and the per-IP rate limit.
  const gated = await gate(req, undefined, { allowAnonymous: true });
  if (gated instanceof Response) return gated;
  const { token } = await params;
  const invite = await findInviteByToken(token);
  if (!invite) {
    return Response.json(
      { error: "not_found", message: "This invitation is invalid or has already been used." },
      { status: 404 },
    );
  }
  const body = await readJsonBody(req);
  if (!body.ok) return body.response;
  const parsed = Body.safeParse(body.data);
  if (!parsed.success) {
    return Response.json(
      { error: "invalid_body", message: parsed.error.issues[0]?.message ?? "invalid body" },
      { status: 400 },
    );
  }

  const admin = getSupabaseAdmin();
  const { data: existing, error: lookupErr } = await admin.rpc(
    "waitlist_invite_user_state",
    { p_email: invite.email },
  );
  if (lookupErr) {
    return Response.json(
      { error: "lookup_failed", message: `Couldn't check email: ${lookupErr.message}` },
      { status: 500 },
    );
  }
  if (Array.isArray(existing) && existing.length > 0) {
    const state = existing[0] as { state: string; user_id?: string };
    if (state.state === "confirmed") {
      return Response.json(
        { error: "account_exists", message: `An account already exists for ${invite.email}. Use Sign in instead.` },
        { status: 409 },
      );
    }
    if (state.user_id) {
      const { error: delErr } = await admin.auth.admin.deleteUser(state.user_id);
      if (delErr) {
        return Response.json(
          { error: "reset_failed", message: `Couldn't reset prior signup: ${delErr.message}` },
          { status: 500 },
        );
      }
    }
  }

  const { error: createErr } = await admin.auth.admin.createUser({
    email: invite.email,
    password: parsed.data.password,
    email_confirm: true,
    user_metadata: {
      signup_complete: true,
      signup_completed_at: new Date().toISOString(),
      source: "workspace_invite",
      ...nameMetadata({
        first_name: parsed.data.first_name ?? null,
        last_name: parsed.data.last_name ?? null,
      }),
    },
  });
  if (createErr) {
    return Response.json({ error: "create_failed", message: createErr.message }, { status: 400 });
  }
  return Response.json({ email: invite.email }, { status: 201 });
});
