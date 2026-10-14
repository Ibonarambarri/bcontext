/**
 * The sign-in form (accounts are created at `/start`, together with the
 * organization they belong to). Rendered inside `(auth)/layout.tsx`; posts
 * to the Server Action next door and carries a same-site `next` through as
 * a hidden field so a deep link survives the round trip.
 */
"use client";

import Link from "next/link";
import type { Route } from "next";
import { useActionState } from "react";
import { signInAction, type AuthState } from "./actions";

export function AuthForm({ next }: { next?: string }) {
  const [state, formAction, pending] = useActionState<AuthState, FormData>(
    signInAction,
    {},
  );

  return (
    <div>
      {/* The highlighted word rides the Plex serif italic, as on the landing. */}
      <h1 className="pa-title">
        Welcome <em>back.</em>
      </h1>
      <p className="pa-sub">Sign in to your workspaces.</p>

      <form action={formAction} className="pa-form">
        {next ? <input type="hidden" name="next" value={next} /> : null}

        <div className="pa-field">
          <label className="pa-label" htmlFor="email">
            Email
          </label>
          <input
            id="email"
            className="pa-input"
            name="email"
            type="email"
            required
            autoComplete="email"
            placeholder="you@company.com"
          />
        </div>

        <div className="pa-field">
          <div className="pa-label-row">
            <label className="pa-label" htmlFor="password">
              Password
            </label>
            <Link href={"/forgot" as Route} className="pa-link">
              Forgot password?
            </Link>
          </div>
          <input
            id="password"
            className="pa-input"
            name="password"
            type="password"
            required
            minLength={6}
            autoComplete="current-password"
            placeholder="••••••••"
          />
        </div>

        {state.error && (
          <p role="alert" className="pa-alert pa-alert-danger">
            {state.error}
          </p>
        )}
        {state.message && (
          <p role="status" className="pa-alert">
            {state.message}
          </p>
        )}

        <button type="submit" className="pa-submit" disabled={pending}>
          {pending ? "Please wait…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
