import { redirect } from "next/navigation";
import type { Route } from "next";
import { isSupabaseConfigured } from "@bcontext-dev/contract/env";
import { ApiError, apiJson, apiJsonOrNull } from "@/web/api-client";
import { getSession } from "@/web/session";
import { AuthShell } from "@/components/auth/AuthShell";
import type { InviteAccepted, InvitePreview } from "@bcontext-dev/contract/workspaces";
import { InviteAuthForm } from "./invite-auth-form";
import { SignOutButton } from "./sign-out-button";

export const metadata = {
  title: "Invitation · Bcontext",
  robots: { index: false },
};

interface Props {
  params: Promise<{ token: string }>;
}

/**
 * `/invite/[token]` — being invited is one of the three ways into the
 * product, and it wears the same paper shell as `/start` and the auth pages.
 *
 * Server Component: previews the invite through the API, checks the Supabase
 * session, and either shows the inline auth form, refuses a mismatched
 * account, or accepts the invite on the person's behalf and redirects.
 */

export default async function InvitePage({ params }: Props) {
  const { token } = await params;

  if (!isSupabaseConfigured()) {
    return (
      <Message
        kicker="Invitation"
        lead="Invitations aren't"
        accent="available here."
        body="This deployment has no accounts behind it."
      />
    );
  }

  const found = await apiJsonOrNull<{ invite: InvitePreview }>(
    `/api/invites/${encodeURIComponent(token)}`,
  );
  const invite = found?.invite ?? null;
  if (!invite) {
    return (
      <Message
        kicker="Invitation"
        lead="This link no longer"
        accent="works."
        body="Ask whoever invited you for a new one."
        link
      />
    );
  }

  const { data: auth } = await (await getSession()).auth.getUser();

  // Not signed in — sign in or create the account inline. The invite token is
  // the access ticket, and the email is locked to the invitee.
  if (!auth.user) {
    return (
      <AuthShell>
        <div>
          <div className="pa-kicker">Invitation</div>
          <h1 className="pa-title">
            Join <em>{invite.organization_name}.</em>
          </h1>
          <InviteAuthForm
            token={token}
            invitedEmail={invite.email}
            organizationName={invite.organization_name}
            role={invite.role}
          />
        </div>
      </AuthShell>
    );
  }

  const wrongEmail =
    auth.user.email &&
    auth.user.email.toLowerCase() !== invite.email.toLowerCase();

  if (wrongEmail) {
    return (
      <AuthShell>
        <div>
          <div className="pa-kicker">Invitation</div>
          <h1 className="pa-title">
            Signed in as <em>someone else.</em>
          </h1>
          <p className="pa-sub">
            This invitation is for <strong>{invite.email}</strong>. You&apos;re
            signed in as <strong>{auth.user.email}</strong>.
          </p>
          <SignOutButton />
        </div>
      </AuthShell>
    );
  }

  // Authenticated and the email matches: accept and go straight in. Clicking a
  // link in an email should end inside the workspace, not on a confirm button.
  let accepted: InviteAccepted | null = null;
  let failure = "";
  try {
    accepted = await apiJson<InviteAccepted>(
      `/api/invites/${encodeURIComponent(token)}/accept`,
      { method: "POST" },
    );
  } catch (err) {
    if (!(err instanceof ApiError)) throw err;
    failure = err.message;
  }
  // Outside the try: Next implements `redirect` by throwing.
  if (accepted) {
    redirect(`/workspaces?ws=${accepted.workspaceSlug ?? accepted.orgSlug}` as Route);
  }

  return (
    <Message
      kicker="Invitation"
      lead="We couldn't get you"
      accent="in."
      body={failure}
      link
    />
  );
}

/**
 * One shape for every dead end this page has. They all say what happened and
 * offer the one way onward, which is the hub.
 */
function Message({
  kicker,
  lead,
  accent,
  body,
  link,
}: {
  kicker: string;
  lead: string;
  accent: string;
  body: string;
  link?: boolean;
}) {
  return (
    <AuthShell>
      <div>
        <div className="pa-kicker">{kicker}</div>
        <h1 className="pa-title">
          {lead} <em>{accent}</em>
        </h1>
        {body ? <p className="pa-sub">{body}</p> : null}
        {link ? (
          <a className="pa-alt-link" href="/workspaces">
            Go to your workspaces
          </a>
        ) : null}
      </div>
    </AuthShell>
  );
}
