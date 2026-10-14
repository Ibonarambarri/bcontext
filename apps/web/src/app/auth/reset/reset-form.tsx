/** The new-password form; `email` is display only, the session says who is resetting. */
"use client";

import { useActionState } from "react";
import { resetPasswordAction, type ResetPasswordState } from "./actions";

export function ResetForm({ email }: { email: string }) {
  const [state, formAction, pending] = useActionState<
    ResetPasswordState,
    FormData
  >(resetPasswordAction, {});

  return (
    <div>
      <p className="pa-kicker">account recovery</p>

      <h1 className="pa-title">
        Pick a new <em>password.</em>
      </h1>
      <p className="pa-sub">
        Set a new password for <strong>{email}</strong>.
      </p>

      <form action={formAction} className="pa-form">
        <div className="pa-field">
          <label className="pa-label" htmlFor="password">
            New password
          </label>
          <input
            id="password"
            className="pa-input"
            name="password"
            type="password"
            required
            minLength={6}
            autoComplete="new-password"
            placeholder="••••••••"
          />
          <p className="pa-help">At least 6 characters</p>
        </div>

        <div className="pa-field">
          <label className="pa-label" htmlFor="confirm">
            Confirm password
          </label>
          <input
            id="confirm"
            className="pa-input"
            name="confirm"
            type="password"
            required
            minLength={6}
            autoComplete="new-password"
            placeholder="••••••••"
          />
        </div>

        {state.error && (
          <p role="alert" className="pa-alert pa-alert-danger">
            {state.error}
          </p>
        )}

        <button type="submit" className="pa-submit" disabled={pending}>
          {pending ? "Saving…" : "Save new password"}
        </button>
      </form>
    </div>
  );
}
