"use client";

import { useActionState, useState } from "react";
import {
  inviteSignInAction,
  inviteSignUpAction,
  type InviteAuthState,
} from "./actions";

type Mode = "signup" | "signin";

interface Props {
  token: string;
  invitedEmail: string;
  organizationName: string;
  role: string;
}

/**
 * The account half of an invitation, in the same paper as `/start`.
 *
 * Two modes rather than two pages, because the person clicking the link does
 * not know whether they already have an account here and should not have to.
 * The address is fixed: the invitation was issued to it, so the field shows it
 * and cannot be edited.
 */
export function InviteAuthForm({
  token,
  invitedEmail,
  organizationName,
  role,
}: Props) {
  const [mode, setMode] = useState<Mode>("signup");
  const action = mode === "signup" ? inviteSignUpAction : inviteSignInAction;
  const [state, formAction, pending] = useActionState<InviteAuthState, FormData>(
    action,
    {},
  );

  return (
    <>
      <p className="pa-sub">
        You&apos;ll join {organizationName} as {role}.
      </p>

      <form action={formAction} className="pa-form">
        <input type="hidden" name="token" value={token} />

        <div className="pa-field">
          <label className="pa-label" htmlFor="invite-email">
            Email
          </label>
          <input
            id="invite-email"
            className="pa-input"
            value={invitedEmail}
            readOnly
            disabled
          />
        </div>

        {mode === "signup" ? (
          <div className="pa-row-2">
            <div className="pa-field">
              <label className="pa-label" htmlFor="invite-first">
                First name
              </label>
              <input
                id="invite-first"
                name="first_name"
                className="pa-input"
                maxLength={60}
                autoComplete="given-name"
                placeholder="Ana"
                required
                disabled={pending}
              />
            </div>
            <div className="pa-field">
              <label className="pa-label" htmlFor="invite-last">
                Last name
              </label>
              <input
                id="invite-last"
                name="last_name"
                className="pa-input"
                maxLength={60}
                autoComplete="family-name"
                placeholder="Ruiz"
                disabled={pending}
              />
            </div>
          </div>
        ) : null}

        <div className="pa-field">
          <label className="pa-label" htmlFor="invite-password">
            {mode === "signup" ? "Choose a password" : "Password"}
          </label>
          <input
            id="invite-password"
            name="password"
            type="password"
            className="pa-input"
            minLength={6}
            autoComplete={mode === "signup" ? "new-password" : "current-password"}
            placeholder="••••••••"
            required
            disabled={pending}
          />
        </div>

        {mode === "signup" ? (
          <div className="pa-field">
            <label className="pa-label" htmlFor="invite-confirm">
              Confirm password
            </label>
            <input
              id="invite-confirm"
              name="confirm"
              type="password"
              className="pa-input"
              minLength={6}
              autoComplete="new-password"
              placeholder="••••••••"
              required
              disabled={pending}
            />
          </div>
        ) : null}

        {state.error ? (
          <p role="alert" className="pa-alert pa-alert-danger">
            {state.error}
          </p>
        ) : null}

        <button type="submit" className="pa-submit" disabled={pending}>
          {pending ? "Please wait…" : mode === "signup" ? "Create account" : "Sign in"}
        </button>

        <p className="pa-foot">
          {mode === "signup" ? "Already have an account? " : "New here? "}
          <button
            type="button"
            className="pa-link pa-link-button"
            onClick={() => setMode(mode === "signup" ? "signin" : "signup")}
          >
            {mode === "signup" ? "Sign in" : "Create an account"}
          </button>
        </p>
      </form>
    </>
  );
}
