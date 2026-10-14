"use client";

import { AlertTriangle, ArrowRight } from "lucide-react";
import { Button } from "@heroui/react";
import type {
  OrgAdminDetail,
  OrgAgentList,
} from "@bcontext-dev/contract/organizations";
import {
  Block,
  Figure,
  SectionHead,
  formatInt,
  type SectionId,
} from "./panel-ui";

/**
 * The first screen of the panel, and the only one that is not about a single
 * subject.
 *
 * An administrator opens this dialog for one of two reasons: to do a piece of
 * work they have already decided on — add somebody, look at a workspace — or
 * because something feels wrong and they do not yet know what. The rail
 * serves the first reason perfectly well. This screen exists for the second,
 * so it is built to answer one question — is anything here asking for a
 * decision — and then to hand the reader to the section that acts on it.
 * Nothing on this screen writes anything, on purpose: a page that both raises
 * an alarm and resolves it invites the reflex fix, and every one of these
 * findings deserves the context of the section it belongs to.
 *
 * The order is frame, then finding. The figures lead because four numbers
 * on one line are read in a glance and they give everything below them a
 * denominator — "one owner" means a different thing in a company of two and
 * a company of forty. "Needs attention" comes second because it is the
 * reason the screen exists, and each item is a sentence with a way out
 * rather than a badge: a warning nobody can act on is a complaint.
 *
 * Nothing here is fetched: it is all derived from the payloads the
 * dialog opened with, because an overview that disagreed with the section it
 * points at would be worse than no overview at all.
 */
export function OverviewSection({
  detail,
  agents,
  onGo,
}: {
  detail: OrgAdminDetail;
  agents: OrgAgentList | null;
  onGo: (section: SectionId) => void;
}): React.JSX.Element {
  const pendingInvites = detail.invites.length;
  const items = attentionItems(detail);

  return (
    <div>
      <SectionHead
        title="Overview"
        hint="What this organization is made of, and anything that is waiting on a decision from you."
      />

      <Block title="At a glance">
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
          <Figure
            value={formatInt(detail.members.length)}
            label={detail.members.length === 1 ? "Person" : "People"}
          />
          <Figure
            value={formatInt(detail.workspaces.length)}
            label={detail.workspaces.length === 1 ? "Workspace" : "Workspaces"}
          />
          {/* The agent roster loads separately and is allowed to fail; a
              figure of zero would read as "nothing is connected", which is a
              different and much calmer statement than "we could not ask". */}
          {agents ? (
            <Figure
              value={formatInt(agents.agents.length)}
              label={agents.agents.length === 1 ? "Agent" : "Agents"}
            />
          ) : null}
          {/* A permanent zero is not news. The count appears the day there is
              somebody waiting on it and disappears again when there is not. */}
          {pendingInvites > 0 ? (
            <Figure
              value={formatInt(pendingInvites)}
              label={
                pendingInvites === 1
                  ? "Pending invitation"
                  : "Pending invitations"
              }
              tone="muted"
            />
          ) : null}
        </div>
      </Block>

      <Block
        title="Needs attention"
        hint="Things about this organization that somebody has to decide, rather than things that merely happened."
      >
        {items.length === 0 ? (
          <p className="text-[12.5px] leading-[1.5] text-muted">
            Nothing is waiting on you. Everyone who was invited has arrived,
            and every workspace has somebody in it.
          </p>
        ) : (
          <ul className="space-y-2">
            {items.map((item) => (
              <li
                key={item.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-[10px] border border-border bg-surface/60 px-4 py-3"
              >
                <div className="flex min-w-0 items-start gap-2.5">
                  <AlertTriangle
                    size={14}
                    aria-hidden
                    className={
                      item.tone === "danger"
                        ? "mt-[3px] shrink-0 text-danger"
                        : "mt-[3px] shrink-0 text-muted"
                    }
                  />
                  <p className="min-w-0 text-[12.5px] leading-[1.5] text-foreground">
                    {item.text}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  className="shrink-0"
                  onPress={() => onGo(item.go)}
                >
                  {item.cta}
                  <ArrowRight size={13} aria-hidden />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Block>

    </div>
  );
}

/** One thing worth a decision, and the section that makes it. */
interface Attention {
  id: string;
  /** Red for something already broken, plain for something on its way. */
  tone: "danger" | "warning";
  text: string;
  cta: string;
  go: SectionId;
}

/**
 * What the payloads say, read as questions rather than as facts.
 *
 * The rules are ordered by what it costs to ignore them, not by which section
 * they belong to: an organization with one owner is one resignation from having nobody who can
 * administer it, and a workspace nobody was let into is only a wasted seat.
 */
function attentionItems(detail: OrgAdminDetail): Attention[] {
  const items: Attention[] = [];

  // One owner is a single point of failure with a person's name on it: lose
  // that account and the company has nobody who can administer it, and nobody
  // inside the company can appoint a replacement.
  const owners = detail.members.filter((m) => m.role === "owner");
  if (owners.length === 1) {
    items.push({
      id: "single-owner",
      tone: "warning",
      text: "One person is the only owner of this organization. If that account is lost, nobody here can administer the company or appoint a replacement.",
      cta: "Users",
      go: "users",
    });
  }

  // An invitation that has run out is a person who thinks they were invited.
  const expired = detail.invites.filter(
    (invite) => new Date(invite.expires_at).getTime() < Date.now(),
  ).length;
  if (expired > 0) {
    items.push({
      id: "expired-invites",
      tone: "warning",
      text:
        expired === 1
          ? "One invitation has expired, so its link no longer works."
          : `${formatInt(expired)} invitations have expired, so their links no longer work.`,
      cta: "Invitations",
      go: "invitations",
    });
  }

  // Delivery failed: the link exists, the person was never told about it.
  const undelivered = detail.invites.filter(
    (invite) => invite.email_status === "error",
  ).length;
  if (undelivered > 0) {
    items.push({
      id: "undelivered-invites",
      tone: "warning",
      text:
        undelivered === 1
          ? "One invitation email couldn't be delivered — the link is waiting, but nobody has been told about it."
          : `${formatInt(undelivered)} invitation emails couldn't be delivered — the links are waiting, but nobody has been told about them.`,
      cta: "Invitations",
      go: "invitations",
    });
  }

  // An account that exists and has never been used is the handover that did
  // not happen. It is counted apart from a pending invitation on purpose: the
  // seat is already taken, so nobody is chasing it.
  const neverSignedIn = detail.members.filter(
    (m) => m.last_sign_in_at === null,
  ).length;
  if (neverSignedIn > 0) {
    items.push({
      id: "never-signed-in",
      tone: "warning",
      text:
        neverSignedIn === 1
          ? "One person has an account here and has never signed in."
          : `${formatInt(neverSignedIn)} people have an account here and have never signed in.`,
      cta: "Users",
      go: "users",
    });
  }

  // A workspace only owners and admins can reach: everybody who is in it is
  // in it by seniority, and nobody was ever granted access. Raised only when
  // somebody could have been — in a company that is all administrators this
  // is the normal state, not a finding.
  const hasNonAdmins = detail.members.some(
    (m) => m.role !== "owner" && m.role !== "admin",
  );
  if (hasNonAdmins) {
    const granted = new Set(
      detail.members.flatMap((m) =>
        m.workspaces.filter((w) => !w.via_org_role).map((w) => w.id),
      ),
    );
    const unreached = detail.workspaces.filter((ws) => !granted.has(ws.id));
    if (unreached.length > 0) {
      const first = unreached[0]?.name ?? "";
      items.push({
        id: "admin-only-workspaces",
        tone: "warning",
        text:
          unreached.length === 1
            ? `Only owners and admins can reach ${first}. Nobody else has been given access to it.`
            : `Only owners and admins can reach ${first} and ${formatInt(unreached.length - 1)} other ${unreached.length === 2 ? "workspace" : "workspaces"}. Nobody else has been given access to them.`,
        cta: "Workspaces",
        go: "workspaces",
      });
    }
  }

  return items;
}
