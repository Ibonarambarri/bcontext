"use client";

/**
 * The list of customers: one table row per company, with how far each has
 * climbed folded into it.
 *
 * A table rather than a stack of cards because the question this screen
 * answers is comparative — which of these twenty is stuck, which is busiest —
 * and comparison is a column read downward. Nothing wraps: when the columns
 * outgrow the window the table scrolls sideways inside its own frame.
 *
 * The rows arrive already narrowed and already ranked: `/api/admin/organizations`
 * applies the search and the filters to every customer and sorts worst-first
 * before it cuts the page. A ranking recomputed here could only order the
 * fifty rows in hand against each other, which is not the same list.
 *
 * The furniture is the shared one in `components/admin/list-ui`, and the
 * table is HeroUI's, so this screen, Users and Errors are the same
 * controls rather than three drawings of them.
 */

import { useCallback, useMemo, useState } from "react";
import type { Route } from "next";
import { useRouter, useSearchParams } from "next/navigation";
import { Check, Copy } from "lucide-react";
import { Button, Meter, Table, Tooltip } from "@heroui/react";
import {
  ADMIN_ORG_STATES,
  ADMIN_ORG_STATE_LABELS,
  type AdminOrgSummary,
} from "@bcontext-dev/contract/admin-orgs";
import { cn } from "@bcontext-dev/contract/utils";
import { formatUsd, type AdminOrgSummaryWithSpend } from "./ai-spend";
import {
  ClearFilters,
  ListFilter,
  ListPager,
  ListSearch,
  NoRows,
  useListNav,
  type ListNav,
} from "@/components/admin/list-ui";

const DAY = 86_400_000;

function daysSince(iso: string): number {
  return Math.floor((Date.now() - new Date(iso).getTime()) / DAY);
}

function ago(iso: string | null): string {
  if (!iso) return "never";
  const d = daysSince(iso);
  if (d <= 0) return "today";
  if (d === 1) return "yesterday";
  if (d < 60) return `${d}d ago`;
  // Fixed locale: the browser's own would disagree with anything rendered on
  // the server elsewhere in the panel, and a date read two ways is worse than
  // an American one.
  return iso.slice(0, 10);
}

function int(n: number): string {
  return n.toLocaleString("en-US");
}

/**
 * Three days is the threshold for a stalled invitation because that is about
 * how long a person takes to get round to an email; below it, chasing is
 * noise.
 */
const STALE_INVITE_DAYS = 3;

/** A sign-up nobody ever answered, once the invitation has had time to be read. */
function isStalled(org: AdminOrgSummary): boolean {
  return (
    org.first_sign_in_at === null &&
    org.oldest_pending_invite_at !== null &&
    daysSince(org.oldest_pending_invite_at) >= STALE_INVITE_DAYS
  );
}

export function OrgsList({
  orgs,
  total,
  limit,
  offset,
  action,
}: {
  orgs: AdminOrgSummaryWithSpend[];
  /** Customers matching the filters across the whole platform, not the page. */
  total: number;
  limit: number;
  offset: number;
  /** Creating a company belongs on the row you search it from. */
  action?: React.ReactNode;
}) {
  const router = useRouter();
  const search = useSearchParams();
  const go = useListNav();
  const q = search.get("q") ?? "";
  const state = search.get("state") ?? "";
  const filtered = q !== "" || state !== "";

  // The busiest organization is the scale for every bar: a fixed maximum
  // would flatten twenty customers into one indistinguishable stub each. The
  // page is the only sample in hand, so the bars compare the rows on screen.
  const busiest = useMemo(
    () => orgs.reduce((max, org) => Math.max(max, org.mcp_calls), 1),
    [orgs],
  );

  const clear = useCallback(() => go({ q: "", state: "" }), [go]);

  return (
    <>
      <OrgFiltersBar
        q={q}
        state={state}
        go={go}
        clear={clear}
        filtered={filtered}
        action={action}
      />

      {orgs.length === 0 ? (
        <NoRows
          title={filtered ? "Nothing matches" : "No organizations yet"}
          description={
            filtered
              ? "No organization matches these filters."
              : "Create one for the company you just talked to."
          }
          onClear={filtered ? clear : undefined}
        />
      ) : (
        <>
          <Table className="mt-4">
            <Table.ScrollContainer>
              <Table.Content
                aria-label="Organizations"
                className="min-w-[1400px] whitespace-nowrap"
                onRowAction={(key) =>
                  router.push(`/admin/orgs/${key}` as Route)
                }
              >
                <Table.Header>
                  <Table.Column isRowHeader>Organization</Table.Column>
                  <Table.Column>Owner</Table.Column>
                  <Table.Column>Members</Table.Column>
                  <Table.Column>Workspaces</Table.Column>
                  <Table.Column>Accepted</Table.Column>
                  <Table.Column>Signed in</Table.Column>
                  <Table.Column>Agent</Table.Column>
                  <Table.Column>This month</Table.Column>
                  <Table.Column>Nodes</Table.Column>
                  {/* Measured, not estimated: the sum of what every model
                      call cost, from the usage ledger. Said in the header
                      because the dashboard's other money columns are
                      replays of assumptions and this one is not. */}
                  <Table.Column>
                    <span title="What this organization's AI calls cost, summed from the usage ledger: the last 30 days, and everything ever.">
                      AI spend · 30d / total
                    </span>
                  </Table.Column>
                  <Table.Column>Created</Table.Column>
                </Table.Header>
                <Table.Body>
                  {orgs.map((org) => (
                    <OrgRow
                      key={org.id}
                      org={org}
                      busiest={busiest}
                    />
                  ))}
                </Table.Body>
              </Table.Content>
            </Table.ScrollContainer>
          </Table>
          <ListPager total={total} limit={limit} offset={offset} go={go} />
        </>
      )}
    </>
  );
}

/**
 * Search and the state narrowing, permanently above the table.
 *
 * Nothing collapses: a filter you have to remember to open is a filter nobody
 * uses, and one hidden inside a drawer can silently be hiding rows. Every
 * control shows its own state, so "on" is legible without a badge counting
 * for it, and Clear appears the moment anything is set.
 */
function OrgFiltersBar({
  q,
  state,
  go,
  clear,
  filtered,
  action,
}: {
  q: string;
  state: string;
  go: ListNav;
  clear: () => void;
  filtered: boolean;
  /** The one thing this screen creates, closing the row it filters with. */
  action?: React.ReactNode;
}) {
  const onSearch = useCallback((value: string) => go({ q: value }), [go]);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <ListSearch
        value={q}
        onSearch={onSearch}
        label="Search organizations"
        placeholder="Search by name, slug or owner email"
      />

      <ListFilter
        label="State"
        value={state}
        onChange={(value) => go({ state: value })}
        items={[
          { id: "", label: "All states" },
          { id: "needs-attention", label: "Needs attention" },
          ...ADMIN_ORG_STATES.map((id) => ({
            id,
            label: ADMIN_ORG_STATE_LABELS[id],
          })),
        ]}
      />

      {filtered ? <ClearFilters onPress={clear} /> : null}

      {action ? <div className="ml-auto shrink-0">{action}</div> : null}
    </div>
  );
}

function OrgRow({
  org,
  busiest,
}: {
  org: AdminOrgSummaryWithSpend;
  busiest: number;
}) {
  const moving = org.mcp_calls + org.writes > 0;
  // The list read carries the open invitations in full, links included, so
  // the row that is still waiting can hand one over without a second request.
  const openInvite = org.pending_invites.find(
    (invite) => !invite.accepted_at && !invite.expired,
  );

  return (
    <Table.Row id={org.id} className="cursor-pointer">
      <Table.Cell>
        <div className="max-w-[240px]">
          <div className="truncate text-[13px] text-[var(--ink)]">
            {org.name}
          </div>
          <div className="truncate font-mono text-[10.5px] text-[var(--ink-mute)]">
            /w/{org.slug}
          </div>
        </div>
      </Table.Cell>

      <Table.Cell
        className={cn(
          "max-w-[220px] truncate font-mono",
          org.owner_emails.length === 0 && "text-[var(--ink-mute)]",
        )}
      >
        {org.owner_emails.length > 0 ? org.owner_emails.join(", ") : "none yet"}
      </Table.Cell>

      <Table.Cell className="tabular-nums">{int(org.member_count)}</Table.Cell>
      <Table.Cell className="tabular-nums">
        {int(org.workspace_count)}
      </Table.Cell>

      <Table.Cell>
        <span className="inline-flex items-center gap-1.5">
          <Rung
            done={org.member_count > 0}
            label={
              org.member_count > 0
                ? int(org.member_count)
                : org.pending_invite_count > 0
                  ? `${org.pending_invite_count} pending`
                  : "nobody invited"
            }
          />
          {openInvite ? <CopyInvite url={openInvite.url} /> : null}
        </span>
      </Table.Cell>

      <Table.Cell>
        <Rung
          done={org.first_sign_in_at !== null}
          alarm={isStalled(org)}
          label={
            org.first_sign_in_at === null
              ? "never"
              : ago(org.last_sign_in_at ?? org.first_sign_in_at)
          }
        />
      </Table.Cell>

      <Table.Cell>
        <Rung
          done={org.first_agent_connected_at !== null}
          label={
            org.first_agent_connected_at === null
              ? "none"
              : `${org.agent_count} · ${ago(org.first_agent_connected_at)}`
          }
        />
      </Table.Cell>

      <Table.Cell>
        <span className="inline-flex items-center gap-2">
          <span
            className={cn("tabular-nums", !moving && "text-[var(--ink-mute)]")}
          >
            {moving ? `${int(org.mcp_calls)} · ${int(org.writes)}` : "nothing"}
          </span>
          {/* One bar, scaled to the busiest customer: what the eye reads
              here is the ranking, not the value. */}
          <Meter
            size="sm"
            aria-label="MCP calls against the busiest customer"
            value={org.mcp_calls}
            maxValue={busiest}
            className="w-[72px]"
          >
            <Meter.Track>
              <Meter.Fill />
            </Meter.Track>
          </Meter>
        </span>
      </Table.Cell>

      <Table.Cell className="tabular-nums">{int(org.node_count)}</Table.Cell>

      <Table.Cell>
        <AiSpendCell spend={org.ai_spend} />
      </Table.Cell>

      <Table.Cell className="tabular-nums text-[var(--ink-3)]">
        {org.created_at.slice(0, 10)}
      </Table.Cell>
    </Table.Row>
  );
}

/**
 * The money column: what the last 30 days cost, then everything ever, with
 * the number of calls under it so a figure can be checked against the
 * gateway's own log. Three states an operator has to tell apart at a
 * glance: nothing spent (a quiet zero), spent (the figures), and a ledger
 * that could not be read (a dash — never a zero that looks like a fact).
 * Calls recorded at $0 despite consuming tokens are a model the price table
 * does not know, so they are flagged in red: it is the one way the total
 * itself can be wrong.
 */
function AiSpendCell({
  spend,
}: {
  spend: AdminOrgSummaryWithSpend["ai_spend"];
}) {
  if (spend === undefined || spend === null) {
    return (
      <span
        className="text-[var(--ink-mute)]"
        title="The usage ledger could not be read."
      >
        —
      </span>
    );
  }
  if (spend.total_events === 0) {
    return <span className="text-[var(--ink-mute)]">nothing</span>;
  }
  return (
    <span className="inline-flex flex-col leading-tight">
      <span className="tabular-nums">
        {formatUsd(spend.last_30d_usd)}
        <span className="text-[var(--ink-mute)]"> / </span>
        {formatUsd(spend.total_usd)}
      </span>
      <span className="font-mono text-[10.5px] text-[var(--ink-mute)]">
        {int(spend.last_30d_events)} / {int(spend.total_events)} calls
        {spend.unpriced_events > 0 ? (
          <span
            className="text-[var(--danger,#dc2626)]"
            title="Calls that consumed tokens and were recorded at $0: a model missing from the price table."
          >
            {" "}
            · {int(spend.unpriced_events)} unpriced
          </span>
        ) : null}
      </span>
    </span>
  );
}

/**
 * One rung of the ladder: whether it was reached, and the one figure that
 * says when. A filled dot for done and a hollow one for not is the whole
 * signal — an operator scans the column, not the words.
 */
function Rung({
  done,
  label,
  alarm,
}: {
  done: boolean;
  label: string;
  alarm?: boolean;
}) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        aria-hidden
        className={cn(
          "h-1.5 w-1.5 shrink-0 rounded-full",
          done
            ? "bg-[var(--ink)]"
            : alarm
              ? "bg-[var(--danger,#dc2626)]"
              : "border border-[var(--line-strong)]",
        )}
      />
      <span className={done ? "" : "text-[var(--ink-mute)]"}>{label}</span>
    </span>
  );
}

/**
 * The invitation link, on the row that is still waiting for it.
 *
 * The link is the entire product of creating an organization and it is needed
 * long after the panel that minted it was dismissed — the operator sends it by
 * hand, sometimes a day later. A row cannot hold the URL in full, so the
 * button carries it in its tooltip; the organization's own page still shows
 * every invitation as text for the browsers where the clipboard is refused.
 */
function CopyInvite({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <Tooltip>
      <Tooltip.Trigger>
        <Button
          size="sm"
          variant="ghost"
          aria-label="Copy invite link"
          onPress={() => {
            void navigator.clipboard
              .writeText(url)
              .then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              })
              .catch(() => setCopied(false));
          }}
        >
          {copied ? <Check size={11} /> : <Copy size={11} />}
          {copied ? "copied" : "invite"}
        </Button>
      </Tooltip.Trigger>
      <Tooltip.Content className="max-w-[420px] break-all">
        {url}
      </Tooltip.Content>
    </Tooltip>
  );
}
