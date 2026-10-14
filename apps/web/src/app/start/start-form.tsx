"use client";

/**
 * The two forms of `/start`, in the auth pages' paper language.
 *
 * `SignupForm` takes the account and the organization's name together, so a
 * person who needs no email confirmation lands in their first workspace in
 * one submit. When the instance does send a confirmation, the organization
 * is created after the link: the name typed here is kept in this browser
 * (`localStorage`, a convenience only) and `OrganizationForm` offers it back.
 */
import { useActionState, useEffect, useState } from "react";
import { MIN_PASSWORD_LENGTH, MAX_NAME_LENGTH } from "@bcontext-dev/contract/me";
import { ORG_NAME_MAX } from "@bcontext-dev/contract/organizations";
import {
  createOrganizationAction,
  signupAction,
  type OrganizationState,
  type SignupState,
} from "./actions";

/** Where the organization's name waits while the person confirms their email. */
const PENDING_ORG_KEY = "bcontext.start.organization";

function remember(name: string) {
  try {
    localStorage.setItem(PENDING_ORG_KEY, name);
  } catch {
    /* storage unavailable: the person types the name again */
  }
}

function recall(): string {
  try {
    return localStorage.getItem(PENDING_ORG_KEY) ?? "";
  } catch {
    return "";
  }
}

function forget() {
  try {
    localStorage.removeItem(PENDING_ORG_KEY);
  } catch {
    /* nothing to clean */
  }
}

export function SignupForm({ prefillEmail }: { prefillEmail?: string }) {
  const [state, action, pending] = useActionState<SignupState, FormData>(signupAction, {});

  useEffect(() => {
    if (state.sent) remember(state.sent.organization);
  }, [state.sent]);

  if (state.sent) return <CheckInbox email={state.sent.email} />;

  return (
    <div>
      <div className="pa-kicker">Start</div>
      <h1 className="pa-title">
        Create your <em>organization.</em>
      </h1>
      <p className="pa-sub">Your account and your organization, in one step.</p>

      <form action={action} className="pa-form">
        <div className="pa-row-2">
          <div className="pa-field">
            <label className="pa-label" htmlFor="first_name">
              First name
            </label>
            <input
              id="first_name"
              name="first_name"
              className="pa-input"
              autoComplete="given-name"
              maxLength={MAX_NAME_LENGTH}
              placeholder="Ana"
              required
              disabled={pending}
            />
          </div>
          <div className="pa-field">
            <label className="pa-label" htmlFor="last_name">
              Last name
              <span className="pa-optional"> optional</span>
            </label>
            <input
              id="last_name"
              name="last_name"
              className="pa-input"
              autoComplete="family-name"
              maxLength={MAX_NAME_LENGTH}
              placeholder="Ruiz"
              disabled={pending}
            />
          </div>
        </div>

        <div className="pa-field">
          <label className="pa-label" htmlFor="email">
            Email
          </label>
          <input
            id="email"
            name="email"
            type="email"
            className="pa-input"
            autoComplete="email"
            inputMode="email"
            placeholder="you@company.com"
            defaultValue={prefillEmail}
            required
            disabled={pending}
          />
        </div>

        <div className="pa-row-2">
          <div className="pa-field">
            <label className="pa-label" htmlFor="password">
              Password
            </label>
            <input
              id="password"
              name="password"
              type="password"
              className="pa-input"
              autoComplete="new-password"
              minLength={MIN_PASSWORD_LENGTH}
              placeholder="••••••••"
              required
              disabled={pending}
            />
          </div>
          <div className="pa-field">
            <label className="pa-label" htmlFor="confirm">
              Confirm password
            </label>
            <input
              id="confirm"
              name="confirm"
              type="password"
              className="pa-input"
              autoComplete="new-password"
              minLength={MIN_PASSWORD_LENGTH}
              placeholder="••••••••"
              required
              disabled={pending}
            />
          </div>
        </div>

        <OrganizationNameField pending={pending} />

        {state.error ? (
          <p role="alert" className="pa-alert pa-alert-danger">
            {state.error}
          </p>
        ) : null}

        <button type="submit" className="pa-submit" disabled={pending}>
          {pending ? "Creating…" : "Create account and organization"}
        </button>

        <p className="pa-foot">
          Already have an account?{" "}
          <a className="pa-link" href="/login">
            Sign in
          </a>
        </p>
      </form>
    </div>
  );
}

export function OrganizationForm({ initialError }: { initialError?: string }) {
  const [state, action, pending] = useActionState<OrganizationState, FormData>(
    createOrganizationAction,
    { error: initialError },
  );
  const [name, setName] = useState("");

  // Read after mount: the server render has no storage, and a value that
  // differs between the two renders is a hydration mismatch.
  useEffect(() => {
    setName(recall());
  }, []);

  return (
    <div>
      <div className="pa-kicker">One last thing</div>
      <h1 className="pa-title">
        Name your <em>organization.</em>
      </h1>
      <p className="pa-sub">
        You&apos;ll be its owner, with a first workspace ready inside it.
      </p>

      <form action={action} onSubmit={forget} className="pa-form">
        <OrganizationNameField pending={pending} value={name} onChange={setName} />

        {state.error ? (
          <p role="alert" className="pa-alert pa-alert-danger">
            {state.error}
          </p>
        ) : null}

        <button type="submit" className="pa-submit" disabled={pending}>
          {pending ? "Creating…" : "Create organization"}
        </button>
      </form>
    </div>
  );
}

function OrganizationNameField({
  pending,
  value,
  onChange,
}: {
  pending: boolean;
  value?: string;
  onChange?: (value: string) => void;
}) {
  return (
    <div className="pa-field">
      <label className="pa-label" htmlFor="organization_name">
        Organization name
      </label>
      <input
        id="organization_name"
        name="organization_name"
        className="pa-input"
        autoComplete="organization"
        maxLength={ORG_NAME_MAX}
        placeholder="Acme"
        required
        disabled={pending}
        {...(onChange ? { value, onChange: (e) => onChange(e.target.value) } : {})}
      />
    </div>
  );
}

function CheckInbox({ email }: { email: string }) {
  return (
    <div>
      <div className="pa-kicker">Account created</div>
      <h1 className="pa-title">
        Now confirm your <em>email.</em>
      </h1>
      <p className="pa-sub">
        We sent a link to <strong>{email}</strong>. Open it and you&apos;ll
        create your organization right after.
      </p>
      <p className="pa-alert">Nothing in your inbox? Look in your spam folder.</p>
      <a className="pa-alt-link" href="/login">
        Go to sign in
      </a>
    </div>
  );
}
