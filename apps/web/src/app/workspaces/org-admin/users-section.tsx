"use client";

import { useMemo, useState } from "react";
import { ChevronRight, Mail, UserPlus } from "lucide-react";
import {
  Button,
  Label,
  ListBox,
  SearchField,
  Select,
  Table,
  Tabs,
} from "@heroui/react";
import type {
  OrgAdminDetail,
  OrgAdminMember,
  OrgAgent,
  OrgAgentList,
} from "@bcontext-dev/contract/organizations";
import type { InviteRole } from "@bcontext-dev/contract/workspaces";
import { PersonAvatar } from "@/components/person-avatar";
import { NoRows } from "@/components/admin/list-ui";
import { UserDetail } from "./user-detail";
import {
  AgentRow,
  RoleChip,
  SectionHead,
  StatusChip,
  formatInt,
  relAgo,
  type SectionId,
} from "./panel-ui";

/**
 * Everyone who can reach this company's context — the people, and the agents
 * the people connected.
 *
 * Those used to be two tabs, and the split was the product's internal model
 * showing through rather than a question anybody has. "Who can read our data"
 * is one question, and its answer is a list of people each of whom may have
 * brought a machine along. An agent has an owner, that owner is answerable for
 * it, and it consumes on their behalf — so the agent belongs under the
 * person, not in a room of its own. The two lenses here are the same roster
 * read two ways: by the person, and by the thing they connected.
 *
 * Clicking anybody opens them in place. Everything an administrator does to
 * one person — their role, the projects they reach, what they consumed,
 * the agents they own — is one screen, because those are one decision
 * and a tab per verb makes the reader assemble it.
 */

const ROLES: InviteRole[] = ["owner", "admin", "editor", "viewer"];

/** Owners and admins reach every workspace by role; a list of them is noise. */
function reachesEverything(role: InviteRole): boolean {
  return role === "owner" || role === "admin";
}

/** Where somebody has got to, as the filter names it. */
type Status = "active" | "never-signed-in" | "invited";

function statusOf(member: OrgAdminMember): Status {
  if (!member.confirmed) return "invited";
  if (!member.last_sign_in_at) return "never-signed-in";
  return "active";
}

const STATUS_LABELS: Record<Status, string> = {
  active: "Active",
  "never-signed-in": "Never signed in",
  invited: "Invited",
};

/** How a person reads in a list: their name, or the address until they give one. */
function label(member: { name: string | null; email: string | null; user_id: string }): string {
  return member.name?.trim() || member.email || "Someone without an address";
}

export function UsersSection({
  detail,
  agents,
  onChanged,
  onGo,
}: {
  detail: OrgAdminDetail;
  agents: OrgAgentList | null;
  onChanged: () => void;
  onGo: (section: SectionId) => void;
}) {
  const [lens, setLens] = useState<"people" | "agents">("people");
  const [q, setQ] = useState("");
  const [role, setRole] = useState<string>("");
  const [status, setStatus] = useState<string>("");
  const [openUserId, setOpenUserId] = useState<string | null>(null);

  // How many machines each person is answerable for. Counted from the agent
  // roster rather than asked for per row: the panel already holds it.
  const agentsByOwner = useMemo(() => {
    const out = new Map<string, OrgAgent[]>();
    for (const agent of agents?.agents ?? []) {
      const owner = agent.connected_by_user_id;
      if (!owner) continue;
      const list = out.get(owner) ?? [];
      list.push(agent);
      out.set(owner, list);
    }
    return out;
  }, [agents]);

  const people = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return detail.members
      .filter((m) => {
        if (role && m.role !== role) return false;
        if (status && statusOf(m) !== status) return false;
        if (!needle) return true;
        return (
          (m.name ?? "").toLowerCase().includes(needle) ||
          (m.email ?? "").toLowerCase().includes(needle)
        );
      })
      // Seniority first, then alphabetically: an administrator scanning a
      // roster is usually looking for who can change things.
      .toSorted((a, b) => {
        const seniority = ROLES.indexOf(a.role) - ROLES.indexOf(b.role);
        return seniority !== 0 ? seniority : label(a).localeCompare(label(b));
      });
  }, [detail.members, q, role, status]);

  const filtered = q.trim() !== "" || role !== "" || status !== "";

  const open = openUserId
    ? detail.members.find((m) => m.user_id === openUserId) ?? null
    : null;

  if (open) {
    return (
      <UserDetail
        orgSlug={detail.slug}
        orgName={detail.name}
        member={open}
        workspaces={detail.workspaces}
        onBack={() => setOpenUserId(null)}
        onChanged={onChanged}
      />
    );
  }

  return (
    <div>
      <SectionHead
        title="Users"
        hint={`Everyone who can reach ${detail.name}'s context — the people, and the agents they connected. An agent acts on its owner's behalf, so it lives under them.`}
        action={
          <Button size="sm" onPress={() => onGo("invitations")}>
            <UserPlus size={14} /> Invite someone
          </Button>
        }
      />

      <Tabs
        className="mb-5"
        selectedKey={lens}
        onSelectionChange={(key) => setLens(key as "people" | "agents")}
      >
        <Tabs.ListContainer>
          <Tabs.List aria-label="How to read the roster">
            <Tabs.Tab id="people">
              People
              <Tabs.Indicator />
            </Tabs.Tab>
            <Tabs.Tab id="agents">
              Agents
              <Tabs.Indicator />
            </Tabs.Tab>
          </Tabs.List>
        </Tabs.ListContainer>
      </Tabs>

      {lens === "people" ? (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <SearchField
              aria-label="Search people"
              value={q}
              onChange={setQ}
              variant="secondary"
              className="min-w-56 flex-1"
            >
              <SearchField.Group>
                <SearchField.SearchIcon />
                <SearchField.Input placeholder="Name or email" />
                <SearchField.ClearButton />
              </SearchField.Group>
            </SearchField>
            <Picker
              label="Role"
              value={role}
              onChange={setRole}
              items={[
                { id: "", label: "Any role" },
                ...ROLES.map((r) => ({ id: r, label: r[0]!.toUpperCase() + r.slice(1) })),
              ]}
            />
            <Picker
              label="Status"
              value={status}
              onChange={setStatus}
              items={[
                { id: "", label: "Any status" },
                { id: "active", label: STATUS_LABELS.active },
                { id: "never-signed-in", label: STATUS_LABELS["never-signed-in"] },
                { id: "invited", label: STATUS_LABELS.invited },
              ]}
            />
          </div>

          {people.length === 0 ? (
            <NoRows
              title={filtered ? "Nobody matches" : "Nobody has joined yet"}
              description={
                filtered
                  ? "No one in this organization matches these filters."
                  : "People arrive by invitation. Create one and pass on the link."
              }
              onClear={
                filtered
                  ? () => {
                      setQ("");
                      setRole("");
                      setStatus("");
                    }
                  : undefined
              }
            />
          ) : (
            <Table>
              <Table.ScrollContainer>
                <Table.Content
                  aria-label="People in this organization"
                  className="min-w-[720px]"
                  onRowAction={(key) => setOpenUserId(String(key))}
                >
                  <Table.Header>
                    <Table.Column isRowHeader>Person</Table.Column>
                    <Table.Column>Role</Table.Column>
                    <Table.Column>Reaches</Table.Column>
                    <Table.Column>Agents</Table.Column>
                    <Table.Column>Last seen</Table.Column>
                    <Table.Column>Status</Table.Column>
                    <Table.Column> </Table.Column>
                  </Table.Header>
                  <Table.Body>
                    {people.map((member) => {
                      const owned = agentsByOwner.get(member.user_id)?.length ?? 0;
                      return (
                        <Table.Row
                          key={member.user_id}
                          id={member.user_id}
                          className="avatar-wake cursor-pointer"
                        >
                          <Table.Cell>
                            <span className="flex items-center gap-2.5">
                              <PersonAvatar
                                user={{ id: member.user_id, email: member.email }}
                                size={28}
                                animate="hover"
                              />
                              <span className="flex min-w-0 flex-col">
                                <span className="truncate text-[13px] text-foreground">
                                  {label(member)}
                                  {member.is_you ? (
                                    <span className="ml-1.5 text-muted">(you)</span>
                                  ) : null}
                                </span>
                                {member.name && member.email ? (
                                  <span className="truncate text-[11.5px] text-muted">
                                    {member.email}
                                  </span>
                                ) : null}
                              </span>
                            </span>
                          </Table.Cell>
                          <Table.Cell>
                            <RoleChip role={member.role} />
                          </Table.Cell>
                          <Table.Cell className="text-[12.5px] text-muted">
                            {reachesEverything(member.role)
                              ? "Every workspace"
                              : member.workspaces.length === 0
                                ? "Nothing yet"
                                : `${member.workspaces.length} of ${detail.workspaces.length}`}
                          </Table.Cell>
                          <Table.Cell className="text-[12.5px] tabular-nums text-muted">
                            {owned === 0 ? "—" : formatInt(owned)}
                          </Table.Cell>
                          <Table.Cell className="text-[12.5px] text-muted">
                            {relAgo(member.last_sign_in_at)}
                          </Table.Cell>
                          <Table.Cell>
                            <StatusChip
                              confirmed={member.confirmed}
                              lastSignInAt={member.last_sign_in_at}
                            />
                          </Table.Cell>
                          <Table.Cell>
                            <ChevronRight size={14} className="text-muted" />
                          </Table.Cell>
                        </Table.Row>
                      );
                    })}
                  </Table.Body>
                </Table.Content>
              </Table.ScrollContainer>
            </Table>
          )}

          {detail.invites.length > 0 ? (
            <button
              type="button"
              onClick={() => onGo("invitations")}
              className="mt-4 flex w-full items-center gap-2.5 rounded-[10px] border border-border bg-surface/60 px-4 py-3 text-left hover:border-[var(--line-strong)]"
            >
              <Mail size={15} className="shrink-0 text-muted" />
              <span className="flex-1 text-[13px] text-foreground">
                {detail.invites.length === 1
                  ? "One invitation is still outstanding"
                  : `${detail.invites.length} invitations are still outstanding`}
              </span>
              <ChevronRight size={14} className="text-muted" />
            </button>
          ) : null}
        </>
      ) : (
        <AgentsLens
          agents={agents}
          members={detail.members}
          onOpenOwner={setOpenUserId}
        />
      )}
    </div>
  );
}

/**
 * The same roster read from the machine's side: every agent, under the person
 * answerable for it. Grouped rather than flat, because "four agents" is a
 * different fact from "four agents, all Ana's".
 */
function AgentsLens({
  agents,
  members,
  onOpenOwner,
}: {
  agents: OrgAgentList | null;
  members: OrgAdminMember[];
  onOpenOwner: (userId: string) => void;
}) {
  const groups = useMemo(() => {
    const byOwner = new Map<string | null, OrgAgent[]>();
    for (const agent of agents?.agents ?? []) {
      const key = agent.connected_by_user_id ?? null;
      const list = byOwner.get(key) ?? [];
      list.push(agent);
      byOwner.set(key, list);
    }
    return [...byOwner.entries()].map(([userId, list]) => {
      const member = userId ? members.find((m) => m.user_id === userId) : undefined;
      return {
        userId,
        name:
          member ? label(member) : list[0]?.connected_by_name ?? list[0]?.connected_by_email ?? null,
        email: member?.email ?? list[0]?.connected_by_email ?? null,
        agents: list.toSorted((a, b) => a.name.localeCompare(b.name)),
      };
    });
  }, [agents, members]);

  if (agents === null) {
    return (
      <p className="text-[13px] text-muted">
        The agent roster couldn&apos;t be read just now.
      </p>
    );
  }

  if (groups.length === 0) {
    return (
      <NoRows
        title="Nothing non-human reads this organization yet"
        description="Agents appear here the moment somebody connects one to a workspace."
      />
    );
  }

  return (
    <div className="space-y-4">
      {groups.map((group) => (
        <div
          key={group.userId ?? "unattributed"}
          className="rounded-[10px] border border-border bg-surface/60"
        >
          <div className="flex items-center gap-2.5 border-b border-border px-4 py-3">
            <PersonAvatar
              user={{ id: group.userId, email: group.email }}
              size={26}
            />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] font-medium text-foreground">
                {group.name ?? "Somebody no longer on the roster"}
              </div>
              <div className="text-[11.5px] text-muted">
                {group.agents.length === 1
                  ? "one agent"
                  : `${group.agents.length} agents`}
              </div>
            </div>
            {group.userId ? (
              <Button size="sm" variant="ghost" onPress={() => onOpenOwner(group.userId!)}>
                Open <ChevronRight size={13} />
              </Button>
            ) : null}
          </div>
          <div className="divide-y divide-[var(--line)]">
            {group.agents.map((agent) => (
              <AgentRow key={agent.id} agent={agent} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * A narrowing that reads as its own value. Local rather than the URL-driven
 * one in `components/admin/list-ui`: this list lives inside a dialog, and a
 * filter that rewrote the hub's address behind it would survive the dialog
 * closing.
 */
function Picker({
  label: name,
  value,
  onChange,
  items,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  items: Array<{ id: string; label: string }>;
}) {
  const ALL = "__all__";
  return (
    <Select
      aria-label={name}
      variant="secondary"
      className="w-40 shrink-0"
      selectedKey={value === "" ? ALL : value}
      onSelectionChange={(key) => onChange(key === ALL || key === null ? "" : String(key))}
    >
      <Select.Trigger>
        <Select.Value />
        <Select.Indicator />
      </Select.Trigger>
      <Select.Popover>
        <ListBox>
          {items.map((item) => (
            <ListBox.Item key={item.id || ALL} id={item.id || ALL} textValue={item.label}>
              <Label>{item.label}</Label>
              <ListBox.ItemIndicator />
            </ListBox.Item>
          ))}
        </ListBox>
      </Select.Popover>
    </Select>
  );
}
