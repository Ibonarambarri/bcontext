import { NextResponse } from "next/server";
import { isSupabaseConfigured } from "@bcontext-dev/contract/env";
import { getSession } from "@/web/session";
import { publicOrigin } from "@/web/public-origin";

/**
 * Browser-only, like auth/callback: it ends the Supabase session held in the
 * cookie and sends the person to /login. Not an API route — it is one of the
 * few route files this repo serves itself, because the cookie it clears is
 * this host's. The redirect target comes from the forwarded host, not from
 * `req.url`, which behind the proxy is the container's own bind address.
 */
export async function POST(req: Request) {
  const origin = publicOrigin(req);
  if (isSupabaseConfigured()) {
    const supabase = await getSession();
    await supabase.auth.signOut();
  }
  return NextResponse.redirect(`${origin}/login`, { status: 303 });
}
