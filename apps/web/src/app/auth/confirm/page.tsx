"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getSupabaseBrowser } from "@/lib/supabase/browser";
import { AuthShell } from "@/components/auth/AuthShell";

/**
 * Client-side bridge for Supabase Auth's implicit flow.
 *
 * Supabase's admin `inviteUserByEmail` (and the email "Invite user" /
 * "Magic Link" templates) use the implicit grant: the verify endpoint
 * redirects to `redirect_to#access_token=...&refresh_token=...` with the
 * tokens in the URL **fragment**. Fragments are never sent to the
 * server, so our /auth/callback route handler can't pick them up — it
 * just sees `code=null` and forwards the user without ever setting a
 * session cookie.
 *
 * This page reads the fragment, calls `setSession` on the browser
 * Supabase client (which writes the session cookies via document.cookie
 * on this app's origin), and then redirects to `?next` (usually
 * /auth/reset?next=/workspaces).
 *
 * Falls back to handling `?code=` PKCE flow too, just in case the
 * project config ever switches.
 */
export default function ConfirmPage() {
  const router = useRouter();
  const [status, setStatus] = useState<
    "loading" | "no_token" | "session_failed" | "ok"
  >("loading");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    const supabase = getSupabaseBrowser();
    const url = new URL(window.location.href);
    const search = url.searchParams;
    const rawNext = search.get("next") ?? "/workspaces";
    const next =
      rawNext.startsWith("/") && !rawNext.startsWith("//")
        ? rawNext
        : "/workspaces";

    const hash = window.location.hash.startsWith("#")
      ? window.location.hash.substring(1)
      : window.location.hash;
    const hashParams = new URLSearchParams(hash);
    const accessToken = hashParams.get("access_token");
    const refreshToken = hashParams.get("refresh_token");
    const code = search.get("code");

    async function run() {
      // Implicit grant — tokens in the fragment.
      if (accessToken && refreshToken) {
        const { error } = await supabase.auth.setSession({
          access_token: accessToken,
          refresh_token: refreshToken,
        });
        if (error) {
          console.error("[CONFIRM] setSession failed", error);
          setStatus("session_failed");
          setErrorMsg(error.message);
          return;
        }
        // Strip the fragment so refreshes don't replay it, then navigate.
        window.history.replaceState(null, "", url.pathname + url.search);
        setStatus("ok");
        router.replace(next as Parameters<typeof router.replace>[0]);
        return;
      }

      // PKCE — server-style code exchange via the browser SDK.
      if (code) {
        const { error } = await supabase.auth.exchangeCodeForSession(code);
        if (error) {
          console.error("[CONFIRM] exchangeCodeForSession failed", error);
          setStatus("session_failed");
          setErrorMsg(error.message);
          return;
        }
        setStatus("ok");
        router.replace(next as Parameters<typeof router.replace>[0]);
        return;
      }

      setStatus("no_token");
    }

    void run();
  }, [router]);

  return (
    <AuthShell>
      <div>
          {(status === "loading" || status === "ok") && (
            <>
              <div className="pa-kicker">Confirming</div>
              <h1 className="pa-title">
                Signing you <span className="dim">in…</span>
              </h1>
              <p className="pa-sub">One moment.</p>
            </>
          )}
          {status === "no_token" && (
            <>
              <h1 className="pa-title">
                This link is <em>incomplete.</em>
              </h1>
              <p className="pa-sub">
                Open the most recent email we sent you, or ask for a new link.
              </p>
              <a href="/workspaces" className="pa-alt-link">
                Back to the app
              </a>
            </>
          )}
          {status === "session_failed" && (
            <>
              <h1 className="pa-title">
                We couldn&apos;t sign you <em>in.</em>
              </h1>
              <p className="pa-sub">{errorMsg ?? "The link may have expired."}</p>
              <a href="/workspaces" className="pa-alt-link">
                Back to the app
              </a>
            </>
          )}
      </div>
    </AuthShell>
  );
}
