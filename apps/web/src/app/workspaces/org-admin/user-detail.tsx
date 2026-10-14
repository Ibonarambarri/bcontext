"use client";

import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, Loader2, ShieldAlert } from "lucide-react";
import {
  Alert,
  Button,
  Checkbox,
  Label,
  ListBox,
  Select,
} from "@heroui/react";
import type {
  OrgAdminMember,
  OrgAdminWorkspace,
  OrgMemberDetail,
  OrgMemberMeter,
} from "@bcontext-dev/contract/organizations";
import type { InviteRole } from "@bcontext-dev/contract/workspaces";
import { PersonAvatar } from "@/components/person-avatar";
import { ListSkeleton } from "@/components/skeletons";
import {
  AgentRow,
  Block,
  METER_HINTS,
  METER_LABELS,
  RoleChip,
  StatusChip,
  apiMessage,
  formatDay,
  formatInt,
  monthLabel,
  relAgo,
} from "./panel-ui";

/**
 * One person, and everything an administrator does to them.
 *
 * Role, reach, usage and the agents they connected are one screen because
 * they are one decision. An agent consumes on its owner's behalf, so usage
 * shown away from the list of things consuming it is a number with no cause;
 * and a role shown away from the projects it opens is a word whose
 * consequence you have to remember.
 *
 * The row that opened this screen is what draws the header, so the name and
 * the role are on the page before the read finishes; everything that needs the
 * member read (`GET /api/organizations/:org/members/:userId`) waits for it.
 */

const ROLES: InviteRole[] = ["owner", "admin", "editor", "viewer"];

const ROLE_MEANING: Record<InviteRole, string> = {
  owner: "Reaches every workspace, administers the organization, and cannot be the last one removed.",
  admin: "Reaches every workspace and administers the organization.",
  editor: "Reaches the workspaces you tick, and can write in them.",
  viewer: "Reaches the workspaces you tick, and can only read.",
};

function reachesEverything(role: InviteRole): boolean {
  return role === "owner" || role === "admin";
}

export function UserDetail({
  orgSlug,
  orgName,
  member,
  workspaces,
  onBack,
  onChanged,
}: {
  orgSlug: string;
  orgName: string;
  /** The roster row that was clicked — the header before the read lands. */
  member: OrgAdminMember;
  workspaces: OrgAdminWorkspace[];
  onBack: () => void;
  onChanged: () => void;
}) {
  const [detail, setDetail] = useState<OrgMemberDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const base = `/api/organizations/${encodeURIComponent(orgSlug)}/members/${encodeURIComponent(member.user_id)}`;

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch(base, { cache: "no-store" });
      if (!res.ok) {
        setError(await apiMessage(res, "Couldn't read this person."));
        return;
      }
      setDetail((await res.json()) as OrgMemberDetail);
    } catch {
      setError("Couldn't reach the server.");
    }
  }, [base]);

  useEffect(() => {
    void load();
  }, [load]);

  /** A write against the person, followed by a re-read of both this screen
   *  and the roster behind it — they show the same facts. */
  const write = useCallback(
    async (init: RequestInit, path: string, fallback: string): Promise<boolean> => {
      setPending(true);
      setError(null);
      try {
        const res = await fetch(path, init);
        if (!res.ok) {
          setError(await apiMessage(res, fallback));
          return false;
        }
        await load();
        onChanged();
        return true;
      } catch {
        setError("Couldn't reach the server.");
        return false;
      } finally {
        setPending(false);
      }
    },
    [load, onChanged],
  );

  const name = detail?.name ?? member.name ?? member.email ?? "This person";
  const role = detail?.role ?? member.role;

  return (
    <div>
      <Button size="sm" variant="ghost" onPress={onBack} className="mb-4 -ml-2">
        <ArrowLeft size={14} /> All users
      </Button>

      <header className="mb-7 flex flex-wrap items-center gap-3.5">
        <PersonAvatar
          user={{ id: member.user_id, email: detail?.email ?? member.email }}
          size={44}
          animate="always"
        />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[19px] font-semibold tracking-[-0.01em] text-foreground">
            {name}
            {member.is_you ? (
              <span className="ml-2 text-[14px] font-normal text-muted">(you)</span>
            ) : null}
          </h2>
          <p className="truncate text-[13px] text-muted">
            {detail?.email ?? member.email ?? "No address"} · joined{" "}
            {formatDay(detail?.joined_at ?? member.joined_at)} · last seen{" "}
            {relAgo(detail?.last_sign_in_at ?? member.last_sign_in_at)}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <RoleChip role={role} />
          <StatusChip
            confirmed={detail?.confirmed ?? member.confirmed}
            lastSignInAt={detail?.last_sign_in_at ?? member.last_sign_in_at}
          />
        </div>
      </header>

      {error ? (
        <Alert role="alert" status="danger" className="mb-5">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{error}</Alert.Description>
          </Alert.Content>
        </Alert>
      ) : null}

      {!detail ? (
        <ListSkeleton rows={5} label="Reading this person" />
      ) : (
        <>
          <AccessBlock
            detail={detail}
            workspaces={workspaces}
            orgName={orgName}
            pending={pending}
            onPatch={(body, fallback) =>
              write(
                {
                  method: "PATCH",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify(body),
                },
                base,
                fallback,
              )
            }
          />

          <UsageBlock detail={detail} />

          <AgentsBlock
            detail={detail}
            pending={pending}
            onRevoke={(agentId) =>
              write(
                { method: "DELETE" },
                `/api/organizations/${encodeURIComponent(orgSlug)}/agents/${encodeURIComponent(agentId)}`,
                "Couldn't disconnect this agent.",
              )
            }
          />

          <RemoveBlock
            detail={detail}
            orgName={orgName}
            pending={pending}
            onRemove={() =>
              write({ method: "DELETE" }, base, "Couldn't remove this person.").then(
                (ok) => {
                  if (ok) onBack();
                },
              )
            }
          />
        </>
      )}
    </div>
  );
}

/* ─── Access ──────────────────────────────────────────────────────────── */

/**
 * What they are to the company, and what that opens.
 *
 * Two kinds of access sit here and the screen has to keep them apart: an
 * owner or admin reaches every workspace because of who they are, and no
 * per-project tick can take that away — only a change of role can. Editors and
 * viewers reach exactly what somebody ticked. Drawing inherited access as an
 * editable checkbox would promise a revocation the API cannot perform.
 */
function AccessBlock({
  detail,
  workspaces,
  orgName,
  pending,
  onPatch,
}: {
  detail: OrgMemberDetail;
  workspaces: OrgAdminWorkspace[];
  orgName: string;
  pending: boolean;
  onPatch: (body: { role?: InviteRole; workspaces?: string[] }, fallback: string) => Promise<boolean>;
}) {
  const granted = detail.workspaces.filter((w) => !w.via_org_role).map((w) => w.id);
  const everything = reachesEverything(detail.role);

  return (
    <Block
      title="Access"
      hint={`What they are to ${orgName}, and the projects it opens.`}
    >
      <div className="rounded-[10px] border border-border bg-surface/60 p-4">
        <div className="flex flex-wrap items-center gap-3">
          <Select
            aria-label="Organization role"
            className="w-48"
            isDisabled={pending || detail.is_you}
            selectedKey={detail.role}
            onSelectionChange={(key) =>
              void onPatch({ role: String(key) as InviteRole }, "Couldn't change the role.")
            }
          >
            <Select.Trigger>
              <Select.Value />
              <Select.Indicator />
            </Select.Trigger>
            <Select.Popover>
              <ListBox>
                {ROLES.map((r) => (
                  <ListBox.Item key={r} id={r} textValue={r}>
                    <Label className="capitalize">{r}</Label>
                    <ListBox.ItemIndicator />
                  </ListBox.Item>
                ))}
              </ListBox>
            </Select.Popover>
          </Select>
          <p className="min-w-0 flex-1 text-[12.5px] text-muted">
            {ROLE_MEANING[detail.role]}
          </p>
        </div>

        {/* The API refuses to demote the last owner and refuses to let anybody
            strip their own role. Only the second is knowable here, so only the
            second is disabled; the first arrives as a message. */}
        {detail.is_you ? (
          <p className="mt-2 text-[12px] text-muted">
            You can&apos;t change your own role. Ask another owner.
          </p>
        ) : detail.is_last_owner ? (
          <p className="mt-2 flex items-start gap-1.5 text-[12px] text-warning">
            <ShieldAlert size={13} className="mt-0.5 shrink-0" />
            The only owner. Make somebody else an owner before changing this, or
            the organization is left with nobody who can administer it.
          </p>
        ) : null}
      </div>

      <div className="mt-3">
        {everything ? null : workspaces.length === 0 ? (
          <p className="text-[12.5px] text-muted">
            This organization has no workspaces yet.
          </p>
        ) : (
          <>
            <p className="mb-2 text-[12.5px] text-muted">
              The projects they reach. Unticking one takes the access away.
            </p>
            <div className="flex flex-wrap gap-x-5 gap-y-2">
              {workspaces.map((ws) => (
                <Checkbox
                  key={ws.id}
                  isSelected={granted.includes(ws.id)}
                  isDisabled={pending}
                  // The API reconciles against the complete list, so the whole
                  // set travels every time rather than the one box that moved.
                  onChange={(on) =>
                    void onPatch(
                      {
                        workspaces: on
                          ? [...granted, ws.id]
                          : granted.filter((id) => id !== ws.id),
                      },
                      "Couldn't change workspace access.",
                    )
                  }
                >
                  <Checkbox.Indicator />
                  <Label>{ws.name}</Label>
                </Checkbox>
              ))}
            </div>
          </>
        )}
      </div>
    </Block>
  );
}

/* ─── Usage ───────────────────────────────────────────────────────────── */

/**
 * What this person — and every agent they connected — consumed this month,
 * beside the organization's total. Read-only: a self-hosted instance has no
 * ceilings, only numbers an administrator reads to see who is busy.
 */
function UsageBlock({ detail }: { detail: OrgMemberDetail }) {
  return (
    <Block
      title="Usage"
      hint={`What this person and their agents consumed in ${monthLabel(detail.period)}.`}
    >
      <div className="space-y-3">
        {detail.meters.map((meter) => (
          <div
            key={meter.kind}
            className="flex items-center justify-between gap-4 rounded-[10px] border border-border bg-surface/60 px-4 py-3.5"
          >
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-medium text-foreground">
                {METER_LABELS[meter.kind] ?? meter.kind}
              </div>
              <div className="mt-0.5 text-[12px] text-muted">
                {METER_HINTS[meter.kind]}
              </div>
            </div>
            <div className="shrink-0 text-right text-[12.5px] tabular-nums text-muted">
              <span className="font-medium text-foreground">{formatInt(meter.used)}</span>
              {" "}
              {usageShare(meter)}
            </div>
          </div>
        ))}
      </div>
    </Block>
  );
}

/* ─── Agents ──────────────────────────────────────────────────────────── */

/**
 * What this person connected, and what it can read.
 *
 * An agent never reaches further than the person who owns it: it is granted
 * out of what they can already reach, so a viewer's agent is a viewer. That is
 * the sentence to keep in mind when reading the scopes below — the way to
 * narrow an agent is to narrow its owner, and the way to end one is here.
 */
function AgentsBlock({
  detail,
  pending,
  onRevoke,
}: {
  detail: OrgMemberDetail;
  pending: boolean;
  onRevoke: (agentId: string) => Promise<boolean>;
}) {
  const [confirming, setConfirming] = useState<string | null>(null);

  return (
    <Block
      title="Agents"
      hint="Everything non-human this person connected. It reads with their access, so it can never reach further than they do."
    >
      {detail.agents.length === 0 ? (
        <p className="text-[12.5px] text-muted">
          They haven&apos;t connected anything yet.
        </p>
      ) : (
        <div className="divide-y divide-[var(--line)] rounded-[10px] border border-border bg-surface/60">
          {detail.agents.map((agent) => (
            <AgentRow
              key={agent.id}
              agent={agent}
              action={
                confirming === agent.id ? (
                  <span className="flex items-center gap-2">
                    <Button
                      size="sm"
                      variant="danger"
                      isDisabled={pending}
                      onPress={() =>
                        void onRevoke(agent.id).then(() => setConfirming(null))
                      }
                    >
                      {pending ? "Disconnecting…" : "Confirm"}
                    </Button>
                    <Button size="sm" variant="ghost" onPress={() => setConfirming(null)}>
                      Cancel
                    </Button>
                  </span>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    isDisabled={pending}
                    onPress={() => setConfirming(agent.id)}
                  >
                    Disconnect
                  </Button>
                )
              }
            />
          ))}
        </div>
      )}
      {confirming ? (
        <p className="mt-2 text-[12px] text-muted">
          Disconnecting revokes the agent&apos;s identity and every token it
          holds. It cannot be undone — the agent has to be connected again.
        </p>
      ) : null}
    </Block>
  );
}

/* ─── Removal ─────────────────────────────────────────────────────────── */

function RemoveBlock({
  detail,
  orgName,
  pending,
  onRemove,
}: {
  detail: OrgMemberDetail;
  orgName: string;
  pending: boolean;
  onRemove: () => void;
}) {
  const [confirming, setConfirming] = useState(false);

  if (detail.is_you) {
    return (
      <Block
        title="Leaving"
        hint={`You can't remove yourself from ${orgName} — another owner has to, and there isn't one yet.`}
      >
        <span className="sr-only">No action available.</span>
      </Block>
    );
  }

  return (
    <Block
      title="Remove from the organization"
      hint={`Out of ${orgName} and out of every workspace it holds. Their agents stay connected until you disconnect them above.`}
    >
      {confirming ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="danger" isDisabled={pending} onPress={onRemove}>
            {pending ? "Removing…" : `Remove ${detail.name ?? detail.email ?? "them"}`}
          </Button>
          <Button size="sm" variant="ghost" onPress={() => setConfirming(false)}>
            Cancel
          </Button>
        </div>
      ) : (
        <Button
          size="sm"
          variant="outline"
          isDisabled={pending || detail.is_last_owner}
          onPress={() => setConfirming(true)}
        >
          Remove from {orgName}
        </Button>
      )}
      {detail.is_last_owner ? (
        <p className="mt-2 text-[12px] text-muted">
          The only owner cannot be removed — the organization would have nobody
          who can administer it.
        </p>
      ) : null}
    </Block>
  );
}

/**
 * This person's part of the organization's total, said once: "all of it" for
 * somebody who is the only one consuming, a percentage otherwise.
 */
function usageShare(meter: OrgMemberMeter): string {
  if (meter.org_used === 0) return "";
  if (meter.org_used === meter.used) return "· all of the organization's";
  const pct = Math.round((meter.used / meter.org_used) * 100);
  return `· ${pct}% of ${formatInt(meter.org_used)}`;
}
