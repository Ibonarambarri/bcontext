/**
 * POST /api/signup — a self-service account (`SignupBody` → `SignupResult`).
 *
 * Anonymous by definition; the gate still applies with `allowAnonymous`
 * because the same-origin check and the per-IP rate limit are what keep an
 * endpoint that creates auth users from being scripted, and a second limit
 * keyed to this endpoint sits on top. Refused with 403 `signup_closed` when
 * `ORG_CREATION=admin`; 503 `confirm_email_failed` when the confirmation
 * email could not be sent (the account is removed, so a retry is clean).
 * The rules live in `@/lib/auth/signup`.
 */
import { z } from "zod";
import { gate } from "@/lib/auth/require";
import { readJsonBody } from "@/lib/parse-json";
import { withRoute } from "@/lib/route";
import { rateLimit } from "@/lib/rate-limit";
import { signUp, SignupError } from "@/lib/auth/signup";
import { MAX_NAME_LENGTH, MIN_PASSWORD_LENGTH } from "@bcontext-dev/contract/me";

const Body = z.object({
  email: z.string().trim().toLowerCase().email("Enter a valid email address.").max(254),
  password: z
    .string()
    .min(MIN_PASSWORD_LENGTH, `Use at least ${MIN_PASSWORD_LENGTH} characters.`)
    .max(200),
  first_name: z.string().trim().min(1, "Tell us your name.").max(MAX_NAME_LENGTH),
  last_name: z.string().trim().max(MAX_NAME_LENGTH).optional(),
});

export const POST = withRoute(async (req: Request) => {
  const gated = await gate(req, undefined, { allowAnonymous: true });
  if (gated instanceof Response) return gated;

  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "unknown";
  const rl = rateLimit(`signup:${ip}`, "public");
  if (!rl.ok) {
    return Response.json(
      { error: "rate_limited", message: "Too many attempts. Try again in a minute." },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } },
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

  try {
    const result = await signUp({
      email: parsed.data.email,
      password: parsed.data.password,
      firstName: parsed.data.first_name,
      lastName: parsed.data.last_name ?? null,
    });
    return Response.json(result, { status: 201 });
  } catch (err) {
    if (err instanceof SignupError) {
      return Response.json({ error: err.code, message: err.message }, { status: err.status });
    }
    throw err;
  }
});
