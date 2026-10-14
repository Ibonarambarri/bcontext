/**
 * The "send me a reset link" form. The action answers the same sentence
 * whatever the address, so the form never learns whether an account exists.
 */
"use client";

import Link from "next/link";
import { useActionState } from "react";
import { forgotPasswordAction, type AuthState } from "../actions";

export function ForgotForm() {
  const [state, formAction, pending] = useActionState<AuthState, FormData>(
    forgotPasswordAction,
    {},
  );

  return (
    <div>
      <p className="pa-kicker">account recovery</p>

      <h1 className="pa-title">
        Reset your <em>password.</em>
      </h1>
      <p className="pa-sub">
        Enter the email you signed up with and we&apos;ll send you a link to
        pick a new password.
      </p>

      <form action={formAction} className="pa-form">
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
          {pending ? "Sending…" : "Send reset link"}
        </button>

        <p className="pa-foot">
          Remembered it?{" "}
          <Link href="/login" className="pa-link">
            Sign in
          </Link>
        </p>
      </form>
    </div>
  );
}
