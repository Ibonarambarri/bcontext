import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { isSupabaseConfigured } from "@bcontext-dev/contract/env";
import { authCookieName, publicEnv, serverSupabaseUrl } from "@/lib/public-env";
import { publicOrigin } from "@/web/public-origin";

/**
 * Supabase Auth redirect target for the PKCE flow (`?code=`): exchanges the
 * code for a session and writes the session cookie before forwarding to
 * `next`. Browser-only and served by this host, not proxied to the API,
 * because the cookie it writes is this host's (`auth/signout` is its twin).
 *
 * Canonical Supabase SSR pattern: write to `cookies()` from next/headers
 * (Next.js auto-merges into the outgoing response) AND to the explicit
 * response.cookies (belt and braces against any propagation quirk). Nothing
 * wraps or clones the response on purpose.
 *
 * Diagnostic logs use `console.log` directly with a fixed prefix
 * (`[CALLBACK]`) so they're greppable in the container logs.
 */

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const origin = publicOrigin(req);
  const code = searchParams.get("code");
  const rawNext = searchParams.get("next") ?? "/workspaces";
  const next =
    rawNext.startsWith("/") && !rawNext.startsWith("//")
      ? rawNext
      : "/workspaces";

  console.log(
    `[CALLBACK] hit code=${code ? "yes" : "no"} next=${next} supabase=${isSupabaseConfigured()}`,
  );

  if (!isSupabaseConfigured() || !code) {
    return NextResponse.redirect(`${origin}${next}`);
  }

  const response = NextResponse.redirect(`${origin}${next}`);
  const cookieStore = await cookies();
  const writeLog: string[] = [];

  const supabase = createServerClient(
    serverSupabaseUrl(),
    publicEnv().supabaseAnonKey,
    {
      cookieOptions: { name: authCookieName() },
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(
          cookiesToSet: Array<{
            name: string;
            value: string;
            options: CookieOptions;
          }>,
        ) {
          for (const { name, value, options } of cookiesToSet) {
            try {
              cookieStore.set(name, value, options);
            } catch (e) {
              writeLog.push(
                `cookieStore.set(${name}) threw: ${e instanceof Error ? e.message : "?"}`,
              );
            }
            try {
              response.cookies.set(name, value, options);
            } catch (e) {
              writeLog.push(
                `response.cookies.set(${name}) threw: ${e instanceof Error ? e.message : "?"}`,
              );
            }
            writeLog.push(`set ${name} len=${value.length}`);
          }
        },
      },
    },
  );

  const { data, error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    console.log(`[CALLBACK] exchange_failed: ${error.message}`);
    const params = new URLSearchParams({ error: error.message });
    return NextResponse.redirect(`${origin}/login?${params.toString()}`);
  }

  // Drain the event loop to give the async SIGNED_IN listener (which
  // calls our setAll) time to run before the response is serialised.
  await new Promise((resolve) => setImmediate(resolve));

  // After the drain, double-check we have a session readable from the
  // cookieStore. If we do but the response still has 0 cookies, write
  // the auth cookies manually from the session we just got back.
  if (writeLog.length === 0 && data.session) {
    console.log(
      "[CALLBACK] setAll never fired — falling back to manual cookie write",
    );
    const accessToken = data.session.access_token;
    const refreshToken = data.session.refresh_token;
    // Supabase SSR stores everything under one cookie named
    // sb-<project-ref>-auth-token, the ref being the first label of the
    // public gateway host (@/lib/public-env).
    const cookieName = authCookieName()!;
    const cookieValue = `base64-${Buffer.from(
      JSON.stringify({
        access_token: accessToken,
        token_type: "bearer",
        expires_in: data.session.expires_in,
        expires_at: data.session.expires_at,
        refresh_token: refreshToken,
        user: data.session.user,
      }),
    ).toString("base64url")}`;
    const opts = {
      path: "/",
      httpOnly: true,
      secure: true,
      sameSite: "lax" as const,
      maxAge: 60 * 60 * 24 * 7,
    };
    response.cookies.set(cookieName, cookieValue, opts);
    cookieStore.set(cookieName, cookieValue, opts);
    writeLog.push(`manual set ${cookieName} len=${cookieValue.length}`);
  }

  console.log(
    `[CALLBACK] ok next=${next} writes=${writeLog.length} ${writeLog.join(" | ")}`,
  );
  return response;
}
