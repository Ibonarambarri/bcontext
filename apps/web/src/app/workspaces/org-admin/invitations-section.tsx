"use client";

import { useMemo, useState } from "react";
import { MailCheck, Send, UserPlus } from "lucide-react";
import {
  Alert,
  Button,
  Chip,
  Input,
  Label,
  ListBox,
  Select,
  TextField,
} from "@heroui/react";
import { CheckboxButtonGroup } from "@/components/ui/button-groups";
import { EmptyState } from "@/components/ui/empty-state";
import { cn } from "@bcontext-dev/contract/utils";
import type {
  CreateOrgInviteBody,
  OrgAdminDetail,
  OrgAdminInvite,
  OrgAdminWorkspace,
} from "@bcontext-dev/contract/organizations";
import type { InviteRole } from "@bcontext-dev/contract/workspaces";
import type { InviteEmailStatus } from "@bcontext-dev/contract/admin-orgs";
import { CopyLink } from "@/components/admin/copy-link";
import { Block, RoleChip, SectionHead, apiMessage, relAgo } from "./panel-ui";

/**
 * The people who have been asked in but are not in yet.
 *
 * They used to live at the bottom of the roster, under the members, which read
 * as "the roster, plus some stragglers". They are not that: a member is a fact
 * about the organization and an invitation is an open question about it, with
 * its own clock and its own two endings. Giving them a section of their own is
 * what lets this screen say the thing the old tab could not — that the link
 * has not been delivered, and by whom it is waiting to be.
 *
 * The product decision this screen is built around: **creating an invitation
 * sends nothing.** The link is the deliverable, and the administrator decides
 * how it travels — a chat message, a ticket, spoken over a desk. Email is one
 * more channel, chosen per invitation with a button, because it is the one act
 * here that cannot be taken back: once a stranger's inbox has the token, no
 * amount of clicking revoke un-sends it. Revoking kills the token; it does not
 * kill the email.
 *
 * Two kinds of access sit in the form and it has to keep them apart: owners
 * and admins reach every workspace because of who they are, so there is
 * nothing to tick for them and the form says so in a sentence. A disabled list
 * of checkboxes would have implied the ticks mean something for those roles.
 */

const ROLES: InviteRole[] = ["owner", "admin", "editor", "viewer"];

/**
 * What came back from the one irreversible button, said plainly: "skipped" on
 * its own reads like a bug the reader should report, when it means the
 * deployment has no mail sender and the link is theirs to pass on by hand.
 */
const EMAIL_STATUS_LABEL: Record<InviteEmailStatus, string> = {
  sent: "Emailed",
  skipped: "Not emailed — no mail sender is configured",
  error: "Email failed",
};

/** Owners and admins already reach every workspace, so a list is noise. */
function reachesEverything(role: InviteRole): boolean {
  return role === "owner" || role === "admin";
}

/** Under two days left is a different sentence from "invited this morning". */
const EXPIRING_SOON_MS = 2 * 86_400_000;

export function InvitationsSection({
  detail,
  onChanged,
}: {
  detail: OrgAdminDetail;
  onChanged: () => void;
}) {
  return (
    <div>
      <SectionHead
        title="Invitations"
        hint={`People asked into ${detail.name} who have not accepted yet. Creating one sends nothing — you get a link to pass on, and emailing it is a separate step.`}
      />

      <InviteForm detail={detail} onChanged={onChanged} />

      <Block
        title="Waiting to accept"
        hint="Each one expires on its own clock. Revoking kills the link; it does not recall an email already sent."
      >
        {detail.invites.length === 0 ? (
          <EmptyState size="sm">
            <EmptyState.Header>
              <EmptyState.Media variant="icon">
                <MailCheck size={18} />
              </EmptyState.Media>
              <EmptyState.Title>Nobody is waiting</EmptyState.Title>
              <EmptyState.Description className="max-w-[420px]">
                Everyone who has been invited is already a member. Invite
                somebody above when that changes.
              </EmptyState.Description>
            </EmptyState.Header>
          </EmptyState>
        ) : (
          <div className="space-y-3">
            {detail.invites.map((invite) => (
              <InviteCard
                key={invite.id}
                orgSlug={detail.slug}
                invite={invite}
                workspaces={detail.workspaces}
                onChanged={onChanged}
              />
            ))}
          </div>
        )}
      </Block>
    </div>
  );
}

/* ─── Ask somebody in ─────────────────────────────────────────────────── */

function InviteForm({
  detail,
  onChanged,
}: {
  detail: OrgAdminDetail;
  onChanged: () => void;
}) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<InviteRole>("editor");
  const [picked, setPicked] = useState<string[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<OrgAdminInvite | null>(null);

  const scoped = !reachesEverything(role);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const trimmed = email.trim();
    if (!trimmed.includes("@")) {
      setError("Enter a valid email address.");
      return;
    }
    setPending(true);
    setError(null);
    try {
      // The ticked workspaces are left out entirely for owners and admins:
      // the API ignores them for those roles, and sending them anyway would
      // record a choice that never applied.
      const body: CreateOrgInviteBody = scoped
        ? { email: trimmed, role, workspaces: picked }
        : { email: trimmed, role };
      const res = await fetch(
        `/api/organizations/${encodeURIComponent(detail.slug)}/invites`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      if (!res.ok) {
        setError(await apiMessage(res, "Couldn't create the invitation."));
        return;
      }
      const json = (await res.json()) as { invite: OrgAdminInvite };
      // The fresh link is held here as well as in the list below, because the
      // list is a re-read and the one thing that must not be missed is the
      // link that has just come into existence.
      setCreated(json.invite);
      setEmail("");
      setPicked([]);
      onChanged();
    } catch {
      setError("Couldn't reach the server.");
    } finally {
      setPending(false);
    }
  }

  return (
    <Block
      title="Invite someone"
      hint="An address, what they are to the company, and — for the roles that need it — which projects they land in."
    >
      <form
        onSubmit={submit}
        className="rounded-[10px] border border-border bg-surface/60 p-4"
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_180px]">
          <TextField
            value={email}
            onChange={setEmail}
            type="email"
            autoComplete="off"
            isDisabled={pending}
            fullWidth
          >
            <Label>Email address</Label>
            <Input placeholder="colleague@company.com" />
          </TextField>

          <Select
            value={role}
            onChange={(key) => {
              if (key != null) setRole(String(key) as InviteRole);
            }}
          >
            <Label>Organization role</Label>
            <Select.Trigger>
              <Select.Value />
              <Select.Indicator />
            </Select.Trigger>
            <Select.Popover>
              <ListBox>
                {ROLES.map((r) => (
                  <ListBox.Item key={r} id={r} textValue={r}>
                    <span className="capitalize">{r}</span>
                    <ListBox.ItemIndicator />
                  </ListBox.Item>
                ))}
              </ListBox>
            </Select.Popover>
          </Select>
        </div>

        <div className="mt-4">
          {scoped ? (
            <>
              <div className="text-[13px] font-medium text-foreground">
                Workspaces they join
              </div>
              <p className="mt-0.5 text-[12px] text-muted">
                {role === "editor" ? "Editors" : "Viewers"} reach exactly what
                is ticked here, and nothing else.
              </p>
              <WorkspacePicker
                workspaces={detail.workspaces}
                selected={picked}
                onChange={setPicked}
                disabled={pending}
              />
            </>
          ) : (
            <p className="text-[12.5px] leading-[1.5] text-muted">
              {role === "owner" ? "Owners" : "Admins"} reach every workspace in{" "}
              {detail.name} because of the role itself, so there is nothing to
              pick. Only a change of role changes that.
            </p>
          )}
        </div>

        {error ? (
          <Alert role="alert" status="danger" className="mt-4">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Description>{error}</Alert.Description>
            </Alert.Content>
          </Alert>
        ) : null}

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button type="submit" isPending={pending} isDisabled={pending}>
            <UserPlus size={14} />
            {pending ? "Creating…" : "Create invitation"}
          </Button>
          <span className="text-[12px] text-muted">
            No email goes out. You get a link.
          </span>
        </div>

        {created ? (
          <div className="mt-4 space-y-2 rounded-[10px] border border-border bg-[var(--paper)] p-3">
            <div className="text-[13px] text-foreground">
              Invitation for{" "}
              <span className="font-medium">{created.email}</span> — nothing has
              been sent yet.
            </div>
            <CopyLink url={created.url} />
          </div>
        ) : null}
      </form>
    </Block>
  );
}

/* ─── One open question ───────────────────────────────────────────────── */

function InviteCard({
  orgSlug,
  invite,
  workspaces,
  onChanged,
}: {
  orgSlug: string;
  invite: OrgAdminInvite;
  workspaces: OrgAdminWorkspace[];
  onChanged: () => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const base = `/api/organizations/${encodeURIComponent(orgSlug)}/invites/${encodeURIComponent(invite.id)}`;

  const named = useMemo(
    () =>
      invite.workspace_ids
        .map((id) => workspaces.find((w) => w.id === id)?.name)
        .filter((name): name is string => Boolean(name))
        .join(", "),
    [invite.workspace_ids, workspaces],
  );

  // An invitation that is nearly out of time is a different object from a
  // fresh one — it is about to need re-issuing — so it says so rather than
  // leaving the reader to subtract two dates in their head.
  const expiresAt = Date.parse(invite.expires_at);
  const remaining = Number.isFinite(expiresAt) ? expiresAt - Date.now() : null;
  const expired = remaining != null && remaining <= 0;
  const expiringSoon =
    remaining != null && remaining > 0 && remaining < EXPIRING_SOON_MS;

  async function call(path: string, method: string, fallback: string) {
    setPending(true);
    setError(null);
    try {
      const res = await fetch(path, { method });
      if (!res.ok) {
        setError(await apiMessage(res, fallback));
        return;
      }
      onChanged();
    } catch {
      setError("Couldn't reach the server.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div
      className={cn(
        "space-y-3 rounded-[10px] border bg-surface/60 px-4 py-3.5",
        expired ? "border-danger/40" : "border-border",
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-[14px] font-medium text-foreground">
              {invite.email}
            </span>
            <RoleChip role={invite.role} />
            {expired ? (
              <Chip size="sm" variant="soft" color="danger">
                <Chip.Label>Expired</Chip.Label>
              </Chip>
            ) : expiringSoon ? (
              <Chip size="sm" variant="soft" color="warning">
                <Chip.Label>Expires soon</Chip.Label>
              </Chip>
            ) : null}
          </div>
          <p className="mt-1 text-[12.5px] text-muted">
            Invited {relAgo(invite.created_at)} ·{" "}
            {expired
              ? `expired ${relAgo(invite.expires_at)}`
              : `expires ${relAgo(invite.expires_at)}`}
            {!reachesEverything(invite.role) &&
              (named
                ? ` · joins ${named}`
                : " · no workspaces picked, so they land with nothing to read")}
            {reachesEverything(invite.role)
              ? " · reaches every workspace on arrival"
              : ""}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {/* Emailing is the one act here that cannot be taken back, so it
              stays a deliberate second step rather than a side effect of
              creating the invitation. */}
          <Button
            size="sm"
            variant="outline"
            isDisabled={pending || expired}
            onPress={() =>
              void call(`${base}/email`, "POST", "Couldn't email it.")
            }
          >
            <Send size={13} />
            Email it
          </Button>
          <Button
            size="sm"
            variant="ghost"
            isDisabled={pending}
            onPress={() => void call(base, "DELETE", "Couldn't revoke it.")}
          >
            Revoke
          </Button>
        </div>
      </div>

      {/* The link is the deliverable, so it is the one address this product
          still prints on screen. */}
      <CopyLink url={invite.url} />

      {invite.email_status ? (
        <p
          className={cn(
            "text-[12px]",
            invite.email_status === "error" ? "text-danger" : "text-muted",
          )}
        >
          {EMAIL_STATUS_LABEL[invite.email_status]}
          {invite.email_sent_at ? ` ${relAgo(invite.email_sent_at)}` : ""}
          {invite.email_error ? ` — ${invite.email_error}` : ""}
        </p>
      ) : null}

      {error ? (
        <p role="alert" className="text-[12.5px] text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/* ─── Which projects ──────────────────────────────────────────────────── */

function WorkspacePicker({
  workspaces,
  selected,
  onChange,
  disabled,
}: {
  workspaces: OrgAdminWorkspace[];
  selected: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
}) {
  if (workspaces.length === 0) {
    return (
      <p className="mt-2 text-[12.5px] text-muted">
        This organization has no workspaces yet, so there is nothing to join.
        They can be added to one once it exists.
      </p>
    );
  }
  return (
    <CheckboxButtonGroup
      aria-label="Workspaces they join"
      value={selected}
      onChange={onChange}
      isDisabled={disabled}
      className="mt-2.5 gap-1.5"
    >
      {workspaces.map((w) => (
        <CheckboxButtonGroup.Item
          key={w.id}
          value={w.id}
          className="rounded-[8px] px-3 py-2"
        >
          <CheckboxButtonGroup.Indicator />
          <CheckboxButtonGroup.ItemContent>
            <span className="text-[12.5px]">{w.name}</span>
          </CheckboxButtonGroup.ItemContent>
        </CheckboxButtonGroup.Item>
      ))}
    </CheckboxButtonGroup>
  );
}
