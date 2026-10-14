"use client";

import { useActionState } from "react";
import { Alert, Button, Chip } from "@heroui/react";
import { CopyLink } from "@/components/admin/copy-link";
import type { AdminInvite } from "@bcontext-dev/contract/admin-orgs";
import { sendInviteEmailAction, revokeInviteAction, type SendEmailState } from "../actions";

/**
 * One invitation: the link first, the email second.
 *
 * The order is the argument. Copying the link is what the hand-made
 * onboarding does — you are already in a conversation with this person. The
 * email is there for when you are not, and it is a separate button because
 * it is the only act on this page that cannot be undone.
 *
 * An invitation that has been accepted, or that has run out, stays on the
 * page as a record and loses its controls: a link that no longer works is
 * worth reading and dangerous to copy, and `expired` is computed by the API
 * so nobody has to compare a date by eye.
 */
export function InviteControls({
  invite,
  orgId,
}: {
  invite: AdminInvite;
  orgId: string;
}) {
  const [state, send, sending] = useActionState<SendEmailState, FormData>(
    sendInviteEmailAction,
    {},
  );

  const status = state.sent?.invite.email_status ?? invite.email_status;
  const sentAt = state.sent?.invite.email_sent_at ?? invite.email_sent_at;
  const error = state.error ?? state.sent?.error ?? invite.email_error;

  const accepted = Boolean(invite.accepted_at);
  const expired = !accepted && invite.expired === true;
  const open = !accepted && !expired;

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-subtle)] p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2.5">
          <span className="text-app-sm font-medium">{invite.email}</span>
          <Chip size="sm">{invite.role}</Chip>
          {accepted && (
            <Chip size="sm" color="success">
              accepted{invite.accepted_at ? ` ${invite.accepted_at.slice(0, 10)}` : ""}
            </Chip>
          )}
          {expired && (
            <Chip size="sm" color="warning">
              expired
            </Chip>
          )}
          {status === "sent" && (
            <Chip size="sm" color="success">
              emailed{sentAt ? ` ${sentAt.slice(0, 10)}` : ""}
            </Chip>
          )}
          {status === "error" && (
            <Chip size="sm" color="danger">
              email failed
            </Chip>
          )}
        </div>
        <span className="font-mono text-app-xs text-[var(--fg-subtle)]">
          {accepted
            ? `sent ${invite.created_at.slice(0, 10)}`
            : `expire${expired ? "d" : "s"} ${invite.expires_at.slice(0, 10)}`}
        </span>
      </div>

      {open && (
        <div className="mt-3">
          <CopyLink url={invite.url} />
        </div>
      )}

      {error && (
        <Alert role="alert" status="danger" className="mt-3">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{error}</Alert.Description>
          </Alert.Content>
        </Alert>
      )}

      {open && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <form action={send}>
            <input type="hidden" name="invite_id" value={invite.id} />
            <input type="hidden" name="org_id" value={orgId} />
            <Button type="submit" size="sm" variant="secondary" isPending={sending}>
              {sending
                ? "Sending…"
                : status === "sent"
                  ? "Send the email again"
                  : "Send invitation email"}
            </Button>
          </form>
          <form action={revokeInviteAction}>
            <input type="hidden" name="invite_id" value={invite.id} />
            <input type="hidden" name="org_id" value={orgId} />
            <Button type="submit" size="sm" variant="danger-soft">
              Revoke
            </Button>
          </form>
        </div>
      )}
    </div>
  );
}
