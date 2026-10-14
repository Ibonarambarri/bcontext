import Link from "next/link";
import type { Route } from "next";
import { notFound } from "next/navigation";
import { ArrowLeft, Bot } from "lucide-react";
import { Alert, Chip, Meter, Separator, Table } from "@heroui/react";
import { apiJson, ApiError } from "@/web/api-client";
import type { AdminOrgWorkspace } from "@bcontext-dev/contract/admin-orgs";
import {
  formatUsd,
  type AdminOrgAiSpend,
  type AdminOrgDetailWithSpend,
} from "../ai-spend";
import type {
  OrgAgent,
  OrgAgentList,
  OrgUsage,
} from "@bcontext-dev/contract/organizations";
import { AdminPage } from "@/components/admin/admin-shell";
import { Empty, Section, Stat } from "@/components/admin/detail-ui";
import { InviteControls } from "./invite-controls";
import { InviteForm } from "./invite-form";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Admin · Organization — Bcontext",
};

const mono: React.CSSProperties = {
  fontFamily: "var(--f-martian-mono), var(--font-mono), monospace",
};

const NUMBER = new Intl.NumberFormat("en");

/** Fixed locale: the server and the browser must agree or hydration breaks. */
function day(iso: string): string {
  return iso.slice(0, 10);
}

function daysSince(iso: string): number {
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
}

/** `YYYY-MM` as a person says it, without pulling in a date library. */
function monthLabel(period: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(period);
  if (!match) return period;
  return new Intl.DateTimeFormat("en", {
    month: "long",
    year: "numeric",
  }).format(new Date(Number(match[1]), Number(match[2]) - 1, 1));
}

function ago(iso: string | null): string {
  if (!iso) return "never";
  const d = daysSince(iso);
  if (d <= 0) return "today";
  if (d === 1) return "yesterday";
  if (d < 30) return `${d}d ago`;
  return day(iso);
}

/**
 * A read whose failure is survivable, carried rather than thrown.
 *
 * A 404 is kept apart from a real failure in the wording alone, because the
 * per-organization counters ship on their own schedule and "not available
 * yet" is a different sentence from "broken".
 */
async function readOptional<T>(
  path: string,
): Promise<{ data: T | null; error: string | null }> {
  try {
    return { data: await apiJson<T>(path), error: null };
  } catch (err) {
    return {
      data: null,
      error:
        err instanceof ApiError && err.status === 404
          ? "not available yet"
          : err instanceof Error
            ? err.message
            : "unavailable",
    };
  }
}

/**
 * One organization's page: what it has built, what reads it, how much moved
 * this month, who is in, and everything ever sent to it.
 *
 * Agents and usage sit straight under the workspaces because they answer
 * what is happening inside them, and neither means anything before you know
 * the workspaces exist; the people are above the invitations because an
 * owner who never signed in is the way onboarding fails silently, and the
 * invitations are last because they are the record of what was already
 * tried.
 *
 * Everything below the detail is a read that is allowed to fail on its own.
 * One unavailable counter costs its section, never the page.
 */
export default async function AdminOrgPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  let org: AdminOrgDetailWithSpend;
  try {
    org = await apiJson<AdminOrgDetailWithSpend>(
      `/api/admin/organizations/${encodeURIComponent(id)}`,
    );
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) notFound();
    throw err;
  }

  /**
   * The two secondary reads go together: they are independent of each other
   * and of the detail, so waiting for them in turn would only make the page
   * slower without making it any more correct.
   */
  const [agents, usage] = await Promise.all([
    readOptional<OrgAgentList>(
      `/api/organizations/${encodeURIComponent(org.slug)}/agents`,
    ),
    readOptional<OrgUsage>(
      `/api/organizations/${encodeURIComponent(org.slug)}/usage`,
    ),
  ]);

  const invites = [...org.invites].sort((a, b) =>
    a.created_at < b.created_at ? 1 : -1,
  );
  const neverSignedIn = org.members.filter(
    (m) => m.last_sign_in_at === null,
  ).length;

  return (
    <AdminPage title={org.name}>
      <Link
        href={"/admin/orgs" as Route}
        className="mb-5 inline-flex items-center gap-1.5 text-[12px] text-[var(--ink-3)] transition-colors hover:text-[var(--ink)]"
      >
        <ArrowLeft size={12} /> All organizations
      </Link>

      <div className="mono mb-4 text-[11px] text-[var(--ink-mute)]" style={mono}>
        /{org.slug}
      </div>

      <Section
        title="Workspaces"
        hint="Where the context actually lives. An organization with no workspace has nothing to read."
      >
        {org.workspaces.length === 0 ? (
          <Empty>
            No workspace yet — the first one is created by an owner, inside the
            app.
          </Empty>
        ) : (
          <Table>
            <Table.ScrollContainer>
              <Table.Content
                aria-label="Workspaces"
                className="min-w-[520px] whitespace-nowrap"
              >
                <Table.Header>
                  <Table.Column isRowHeader>Workspace</Table.Column>
                  <Table.Column>Nodes</Table.Column>
                  <Table.Column>Members</Table.Column>
                  <Table.Column>Last activity</Table.Column>
                </Table.Header>
                <Table.Body>
                  {org.workspaces.map((ws: AdminOrgWorkspace) => (
                    <Table.Row key={ws.id} id={ws.id}>
                      <Table.Cell>
                        <div className="truncate text-[12.5px] text-[var(--ink)]">
                          {ws.name}
                        </div>
                        <div className="truncate font-mono text-[10.5px] text-[var(--ink-mute)]">
                          {ws.slug} · created {day(ws.created_at)}
                        </div>
                      </Table.Cell>
                      <Table.Cell className="tabular-nums">
                        {NUMBER.format(ws.node_count)}
                      </Table.Cell>
                      <Table.Cell className="tabular-nums">
                        {NUMBER.format(ws.member_count)}
                      </Table.Cell>
                      <Table.Cell
                        className={
                          ws.last_activity_at
                            ? "tabular-nums"
                            : "tabular-nums text-[var(--ink-mute)]"
                        }
                      >
                        {ago(ws.last_activity_at)}
                      </Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table.Content>
            </Table.ScrollContainer>
          </Table>
        )}
      </Section>

      <Section
        title="Agents"
        hint={
          agents.error
            ? `The roster is ${agents.error}.`
            : agents.data && agents.data.agents.length > 0
              ? "Everything non-human that can read this customer's context, what it reaches, and when it was last used."
              : "An agent connecting is the moment the product starts being used. Until then this customer has an account and nothing else."
        }
      >
        <AgentRoster agents={agents.data?.agents ?? null} error={agents.error} />
      </Section>

      <Section
        title="Usage"
        hint={
          usage.error
            ? `The counters are ${usage.error}.`
            : usage.data
              ? `What this organization consumed in ${monthLabel(usage.data.period)}. Measured, never priced.`
              : undefined
        }
      >
        <UsagePanel usage={usage.data} error={usage.error} />
      </Section>

      <Section
        title="AI spend"
        hint={
          org.ai_spend
            ? "What every model call cost, summed from the usage ledger: the gateway's own figure per call, or the per-model price table when it reports none. This is the number to check against the gateway's invoice."
            : "The usage ledger could not be read, so nothing here is a figure."
        }
      >
        <AiSpendPanel spend={org.ai_spend ?? null} />
      </Section>

      <Section
        title="People"
        hint={
          neverSignedIn > 0
            ? `${neverSignedIn} of ${org.members.length} accepted and never signed in — that is where this account is stuck.`
            : "Everyone who accepted has signed in at least once."
        }
      >
        {org.members.length === 0 ? (
          <Empty>
            Nobody has accepted yet. The organization exists and the invitation
            below is still open.
          </Empty>
        ) : (
          <div className="rounded-md border border-[var(--line)]">
            {org.members.map((m) => {
              // Whether they ever signed in rides on the member itself rather
              // than being joined in from the accounts list, which arrives one
              // page at a time and would silently mark everybody past the
              // first fifty as unknown.
              const signedIn = m.last_sign_in_at;
              return (
                <div
                  key={m.user_id}
                  className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--line)] px-3 py-2.5 last:border-b-0"
                >
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <span className="truncate text-[12.5px] text-[var(--ink)]">
                      {m.email ?? m.user_id}
                    </span>
                    <Chip size="sm" variant="secondary" className="text-[10px]">
                      <Chip.Label>{m.role}</Chip.Label>
                    </Chip>
                    {!signedIn && (
                      <Chip size="sm" color="warning" className="text-[10px]">
                        <Chip.Label>never signed in</Chip.Label>
                      </Chip>
                    )}
                  </div>
                  <div
                    className="text-[10.5px] text-[var(--ink-mute)]"
                    style={mono}
                  >
                    {m.joined_at ? `joined ${day(m.joined_at)}` : "joined —"}
                    {signedIn ? ` · last seen ${ago(signedIn)}` : " · no sign-in"}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Section>

      <Section
        title="Invitations"
        hint="Everything ever sent, accepted ones included: an invitation that vanishes on acceptance leaves no record of what was sent to whom. A link lives 14 days; revoking kills it immediately."
      >
        {invites.length === 0 ? (
          <Empty>Nothing has been sent.</Empty>
        ) : (
          <div className="flex flex-col gap-3">
            {invites.map((invite) => (
              <InviteControls key={invite.id} invite={invite} orgId={org.id} />
            ))}
          </div>
        )}

        <Separator className="my-5" />

        <h3 className="text-[12.5px] font-medium text-[var(--ink)]">
          Invite someone else
        </h3>
        <div className="mt-3">
          <InviteForm orgId={org.id} />
        </div>
      </Section>
    </AdminPage>
  );
}



/**
 * What has connected here, what it reaches, and when it was last used.
 *
 * Reach is the loudest thing on a row: an agent that sees three workspaces is
 * not the same risk as one that sees a single project, and a bar drawn
 * against the widest reach in this organization says so before a word is
 * read. Scaling against the widest reach present rather than a fixed maximum
 * is what keeps a company whose agents all sit in one workspace legible.
 */
function AgentRoster({
  agents,
  error,
}: {
  agents: OrgAgent[] | null;
  error: string | null;
}) {
  if (error) {
    return (
      <Alert role="alert" status="danger">
        <Alert.Indicator />
        <Alert.Content>
          <Alert.Description>
            Couldn&apos;t load this organization&apos;s agents: {error}
          </Alert.Description>
        </Alert.Content>
      </Alert>
    );
  }

  if (!agents || agents.length === 0) {
    return (
      <Empty>
        Nothing connected yet — this customer has an account and no agent. It
        is the first thing worth a message.
      </Empty>
    );
  }

  const widestReach = agents.reduce(
    (max, a) => Math.max(max, a.workspaces.length),
    1,
  );

  return (
    <div className="rounded-md border border-[var(--line)]">
      {agents.map((agent) => {
        const reach = agent.workspaces.length;
        return (
          <div
            key={agent.id}
            className="border-b border-[var(--line)] px-3 py-3 last:border-b-0"
          >
            <div className="flex items-start gap-3">
              <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-[var(--paper-3)] text-[var(--ink-2)]">
                <Bot size={13} />
              </div>

              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="truncate text-[13px] text-[var(--ink)]">
                    {agent.name}
                  </span>
                  {agent.provider && (
                    <Chip size="sm" variant="secondary" className="text-[10px]">
                      <Chip.Label>{agent.provider}</Chip.Label>
                    </Chip>
                  )}
                </div>
                <div
                  className="mt-0.5 text-[10.5px] text-[var(--ink-mute)]"
                  style={mono}
                >
                  {agent.connected_by_email
                    ? `connected by ${agent.connected_by_email}`
                    : "connected by someone no longer on the roster"}
                  {" · connected "}
                  {ago(agent.created_at)}
                  {" · "}
                  {/* A dash would read as "we didn't look"; the truth is that
                      it has sat here since it was connected, never called. */}
                  {agent.last_used_at
                    ? `last used ${ago(agent.last_used_at)}`
                    : "never used"}
                </div>
              </div>

              <div className="w-[92px] shrink-0 pt-0.5">
                <div
                  className="text-right text-[10.5px] text-[var(--ink-3)]"
                  style={mono}
                >
                  <b className="text-[12px] font-medium text-[var(--ink)]">
                    {reach}
                  </b>{" "}
                  {reach === 1 ? "workspace" : "workspaces"}
                </div>
                <Meter
                  className="mt-1"
                  size="sm"
                  aria-label="Workspaces reached, against the widest reach here"
                  value={reach}
                  maxValue={widestReach}
                >
                  <Meter.Track>
                    <Meter.Fill />
                  </Meter.Track>
                </Meter>
              </div>
            </div>

            {reach === 0 ? (
              <p className="mt-2 pl-10 text-[11.5px] text-[var(--ink-3)]">
                Reaches no workspace — it can sign in and read nothing.
              </p>
            ) : (
              <div className="mt-2 flex flex-wrap gap-1.5 pl-10">
                {agent.workspaces.map((ws) => (
                  <Chip key={ws.id} size="sm" variant="secondary">
                    {ws.name} ·{" "}
                    {ws.scopes.length > 0 ? ws.scopes.join(" ") : "no scopes"}
                  </Chip>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * This organization's month, measured: counts only, no currency.
 *
 * The split between people and agents leads, because every other counter says
 * how much context there is and only that one says who is producing it —
 * which is the difference between a customer using the product and a customer
 * filling in a wiki.
 */
function UsagePanel({
  usage,
  error,
}: {
  usage: OrgUsage | null;
  error: string | null;
}) {
  if (!usage) {
    // A route that has not shipped is not a broken one: the counters arrive on
    // their own schedule, and zeroes would read as a customer nobody uses.
    return error && error !== "not available yet" ? (
      <Alert role="alert" status="danger">
        <Alert.Indicator />
        <Alert.Content>
          <Alert.Description>
            Couldn&apos;t load usage: {error}
          </Alert.Description>
        </Alert.Content>
      </Alert>
    ) : (
      <Empty>Usage isn&apos;t available yet for this organization.</Empty>
    );
  }

  const writes = usage.writes_by_people + usage.writes_by_agents;
  const agentShare = writes === 0 ? 0 : Math.round((usage.writes_by_agents / writes) * 100);

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat
          label="Nodes"
          value={NUMBER.format(usage.nodes_total)}
          hint="in total"
        />
        <Stat
          label="Created"
          value={NUMBER.format(usage.nodes_created)}
          hint="this month"
        />
        <Stat
          label="Edited"
          value={NUMBER.format(usage.nodes_edited)}
          hint="this month"
        />
        <Stat
          label="Meeting minutes"
          value={NUMBER.format(usage.meeting_minutes)}
          hint="this month"
        />
      </div>

      <div className="rounded-md border border-[var(--line)] p-3">
        <div className="mono text-[10.5px] uppercase tracking-[0.06em] text-[var(--ink-mute)]">
          Writes this month · who made them
        </div>
        {writes === 0 ? (
          <p className="mt-2 text-[12px] text-[var(--ink-3)]">
            Nothing has been written this month.
          </p>
        ) : (
          <>
            <div className="mt-2 text-[13px] text-[var(--ink-2)]">
              Agents wrote{" "}
              <b className="text-[var(--ink)]" style={mono}>
                {agentShare}%
              </b>{" "}
              of the {NUMBER.format(writes)}{" "}
              {writes === 1 ? "write" : "writes"} in this organization.
            </div>
            <div className="mt-2.5 flex h-2 w-full overflow-hidden rounded-full bg-[var(--paper-3)]">
              <div
                className="h-full bg-[var(--ink)]"
                style={{ width: `${100 - agentShare}%` }}
              />
              <div
                className="h-full bg-[var(--ink-mute)]"
                style={{ width: `${agentShare}%` }}
              />
            </div>
            <div
              className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-[var(--ink-3)]"
              style={mono}
            >
              <span className="inline-flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full bg-[var(--ink)]" />
                people{" "}
                <b className="font-medium text-[var(--ink)]">
                  {NUMBER.format(usage.writes_by_people)}
                </b>
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full bg-[var(--ink-mute)]" />
                agents{" "}
                <b className="font-medium text-[var(--ink)]">
                  {NUMBER.format(usage.writes_by_agents)}
                </b>
              </span>
            </div>
          </>
        )}
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="rounded-md border border-[var(--line)] p-3">
          <div className="mono text-[10.5px] uppercase tracking-[0.06em] text-[var(--ink-mute)]">
            AI queries · this month
          </div>
          <div className="mt-1.5 text-[22px] leading-none text-[var(--ink)]" style={mono}>
            {NUMBER.format(usage.ai_queries)}
          </div>
        </div>

        <div className="rounded-md border border-[var(--line)] p-3">
          <div className="mono text-[10.5px] uppercase tracking-[0.06em] text-[var(--ink-mute)]">
            MCP calls · this month
          </div>
          <div className="mt-1.5 text-[22px] leading-none text-[var(--ink)]" style={mono}>
            {NUMBER.format(usage.mcp_calls.total)}
          </div>
          {/* The only measure of how much context is READ, so the busiest
              tools are named: `ping` is noise, a search is a retrieval. */}
          <div className="mt-1.5 text-[10.5px] text-[var(--ink-3)]" style={mono}>
            {usage.mcp_calls.by_tool.length === 0
              ? "nothing has read this context this month"
              : usage.mcp_calls.by_tool
                  .slice(0, 3)
                  .map((t) => `${t.tool} ${NUMBER.format(t.calls)}`)
                  .join(" · ")}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * The four figures of the money question: the last 30 days, everything
 * ever, how many calls that was, and how many of them were priced at $0
 * despite consuming tokens. The last one is the accounting's own alarm — a
 * model missing from the price table — and reads as danger when it is not
 * zero, because it means the other three are too low.
 */
function AiSpendPanel({ spend }: { spend: AdminOrgAiSpend | null }) {
  if (!spend) {
    return <Empty>The usage ledger is unavailable.</Empty>;
  }
  if (spend.total_events === 0) {
    return <Empty>No model call has been made in this organization.</Empty>;
  }
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <Stat
        label="Last 30 days"
        value={formatUsd(spend.last_30d_usd)}
        hint={`${NUMBER.format(spend.last_30d_events)} ${spend.last_30d_events === 1 ? "call" : "calls"}`}
      />
      <Stat
        label="All time"
        value={formatUsd(spend.total_usd)}
        hint={`${NUMBER.format(spend.total_events)} ${spend.total_events === 1 ? "call" : "calls"}`}
      />
      <Stat
        label="Per call · 30d"
        value={
          spend.last_30d_events > 0
            ? formatUsd(spend.last_30d_usd / spend.last_30d_events)
            : "—"
        }
        hint="average, all surfaces"
      />
      <div
        className={
          spend.unpriced_events > 0
            ? "rounded-md border border-[var(--danger,#dc2626)] px-3 py-2.5"
            : "rounded-md border border-[var(--line)] px-3 py-2.5"
        }
      >
        <div className="mono text-[10.5px] uppercase tracking-[0.06em] text-[var(--ink-mute)]">
          Unpriced calls
        </div>
        <div
          className={
            spend.unpriced_events > 0
              ? "mt-1 text-[22px] leading-none text-[var(--danger,#dc2626)]"
              : "mt-1 text-[22px] leading-none text-[var(--ink)]"
          }
          style={mono}
        >
          {NUMBER.format(spend.unpriced_events)}
        </div>
        <div className="mt-1 text-[10.5px] text-[var(--ink-3)]">
          {spend.unpriced_events > 0
            ? "consumed tokens, recorded at $0: a model the price table does not know"
            : "every call that consumed tokens was priced"}
        </div>
      </div>
    </div>
  );
}
