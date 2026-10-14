"use client";

/**
 * Everybody with an account, one table row each.
 *
 * The rows arrive already narrowed and already ordered: `/api/admin/users`
 * applies the search, the organization, the role and the state to every
 * account it reaches before it cuts the page. A predicate re-applied here
 * could only hide rows the API already chose to send, and a sort could only
 * order fifty rows against each other rather than against the platform.
 *
 * Nothing wraps: an address that folds onto a second line stops being
 * comparable with the one above it, so the columns keep their line and the
 * table scrolls sideways inside its own frame.
 *
 * The furniture is the shared one in `components/admin/list-ui`; the table
 * is HeroUI's, which is where the row's own affordances come from — hover,
 * focus, and a row that answers the keyboard as well as the pointer.
 */

import { useCallback, useMemo } from "react";
import Link from "next/link";
import type { Route } from "next";
import { useRouter, useSearchParams } from "next/navigation";
import { Chip, Table } from "@heroui/react";
import {
  ADMIN_USER_STATES,
  type AdminUserPage,
  type AdminUserRow,
  type AdminUserState,
} from "@bcontext-dev/contract/admin-orgs";
import type { InviteRole } from "@bcontext-dev/contract/workspaces";
import {
  ClearFilters,
  ListFilter,
  ListPager,
  ListSearch,
  NoRows,
  useListNav,
  type ListNav,
} from "@/components/admin/list-ui";

function ago(iso: string | null): string {
  if (!iso) return "never";
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (d <= 0) return "today";
  if (d === 1) return "yesterday";
  if (d < 30) return `${d}d ago`;
  return iso.slice(0, 10);
}

function int(n: number): string {
  return n.toLocaleString("en-US");
}

/** Where a person has stopped, in the order they get through signing up: two
 *  ways the handover fails and then the one where it did not. */
const STATE_LABELS: Record<AdminUserState, string> = {
  invited: "Invited, no password",
  "never-signed-in": "Never signed in",
  active: "Active",
};

/** What the row says about a person, in the two words an operator acts on. */
const STATE_SHORT: Record<AdminUserState, string> = {
  invited: "invited, no password",
  "never-signed-in": "never signed in",
  active: "active",
};

/** The two states that are somebody stuck get the colour; being in is the
 *  quiet one, because most rows are it. */
const STATE_COLOR: Record<AdminUserState, "default" | "warning"> = {
  invited: "warning",
  "never-signed-in": "warning",
  active: "default",
};

/**
 * Which of the three this person is. The API selects on the same three facts,
 * so this is the row's label and not a second opinion about it.
 */
function accountState(user: AdminUserRow): AdminUserState {
  if (!user.confirmed) return "invited";
  if (!user.last_sign_in_at) return "never-signed-in";
  return "active";
}

/** Seniority, so the role filter lists owners before viewers. */
const ROLE_ORDER: readonly InviteRole[] = ["owner", "admin", "editor", "viewer"];

export function UsersList({ page }: { page: AdminUserPage }) {
  const router = useRouter();
  const search = useSearchParams();
  const go = useListNav();
  const q = search.get("q") ?? "";
  const org = search.get("organization") ?? "";
  const role = search.get("role") ?? "";
  const state = search.get("state") ?? "";
  const filtered = q !== "" || org !== "" || role !== "" || state !== "";

  // The companies on this page, named. The API offers no index of
  // organizations that costs less than the organizations screen itself, so
  // the picker offers what the rows in hand can name — and when one is
  // chosen every row belongs to it, so the choice always names itself back.
  const orgs = useMemo(() => {
    const seen = new Map<string, string>();
    for (const user of page.items) {
      for (const o of user.orgs) seen.set(o.id, o.name);
    }
    return [...seen].sort((a, b) => a[1].localeCompare(b[1]));
  }, [page.items]);

  const clear = useCallback(
    () => go({ q: "", organization: "", role: "", state: "" }),
    [go],
  );

  return (
    <div>
      <UserFiltersBar
        q={q}
        org={org}
        role={role}
        state={state}
        orgs={orgs}
        go={go}
        clear={clear}
        filtered={filtered}
        page={page}
      />

      {page.items.length === 0 ? (
        <NoRows
          title={filtered ? "Nothing matches" : "No accounts yet"}
          description={
            filtered
              ? "No user matches these filters."
              : "An account is born when somebody accepts an invitation."
          }
          onClear={filtered ? clear : undefined}
        />
      ) : (
        <>
          <Table className="mt-4">
            <Table.ScrollContainer>
              <Table.Content
                aria-label="Accounts"
                className="min-w-[900px] whitespace-nowrap"
                // The row is the link. React Aria gives it the pointer and
                // the keyboard at once, which the hand-rolled onClick never
                // did.
                onRowAction={(key) =>
                  router.push(`/admin/users/${key}` as Route)
                }
              >
                <Table.Header>
                  <Table.Column isRowHeader>Email</Table.Column>
                  <Table.Column>Organizations</Table.Column>
                  <Table.Column>Status</Table.Column>
                  <Table.Column>Joined</Table.Column>
                  <Table.Column>Last seen</Table.Column>
                </Table.Header>
                <Table.Body>
                  {page.items.map((user) => {
                    const state = accountState(user);
                    return (
                      <Table.Row
                        key={user.id}
                        id={user.id}
                        className="cursor-pointer"
                      >
                        <Table.Cell className="max-w-[280px] truncate font-mono text-[var(--ink)]">
                          {user.email ?? user.id}
                        </Table.Cell>

                        <Table.Cell>
                          {user.orgs.length === 0 ? (
                            <span className="text-[var(--ink-mute)]">
                              none — nothing to sign in to
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1.5">
                              {user.orgs.map((o) => (
                                <Link
                                  key={o.id}
                                  href={`/admin/orgs/${o.id}` as Route}
                                  onClick={(e) => e.stopPropagation()}
                                >
                                  <Chip size="sm" variant="secondary">
                                    {o.name} · {o.role}
                                  </Chip>
                                </Link>
                              ))}
                            </span>
                          )}
                        </Table.Cell>

                        <Table.Cell>
                          <Chip
                            size="sm"
                            variant="soft"
                            color={STATE_COLOR[state]}
                          >
                            {STATE_SHORT[state]}
                          </Chip>
                        </Table.Cell>

                        <Table.Cell className="tabular-nums text-[var(--ink-3)]">
                          {user.created_at.slice(0, 10)}
                        </Table.Cell>
                        <Table.Cell className="tabular-nums text-[var(--ink-3)]">
                          {ago(user.last_sign_in_at)}
                        </Table.Cell>
                      </Table.Row>
                    );
                  })}
                </Table.Body>
              </Table.Content>
            </Table.ScrollContainer>
          </Table>
          <ListPager
            total={page.total}
            limit={page.limit}
            offset={page.offset}
            go={go}
          />
        </>
      )}
    </div>
  );
}

/**
 * Search and the three narrowings, permanently above the table — the same bar
 * as the organizations screen, so the control is learned once.
 *
 * Nothing collapses: a filter you have to remember to open is a filter nobody
 * uses, and one hidden inside a drawer can silently be hiding rows. Every
 * control shows its own state, so "on" is legible without a badge counting
 * for it, and Clear appears the moment anything is set.
 */
function UserFiltersBar({
  q,
  org,
  role,
  state,
  orgs,
  go,
  clear,
  filtered,
  page,
}: {
  q: string;
  org: string;
  role: string;
  state: string;
  orgs: Array<readonly [string, string]>;
  go: ListNav;
  clear: () => void;
  filtered: boolean;
  page: AdminUserPage;
}) {
  const onSearch = useCallback((value: string) => go({ q: value }), [go]);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <ListSearch
        value={q}
        onSearch={onSearch}
        label="Search accounts by email"
        placeholder="Search by email"
      />

      <ListFilter
        label="Organization"
        value={org}
        onChange={(value) => go({ organization: value })}
        items={[
          { id: "", label: "All organizations" },
          ...orgs.map(([id, name]) => ({ id, label: name })),
        ]}
      />
      <ListFilter
        label="Role"
        value={role}
        onChange={(value) => go({ role: value })}
        items={[
          { id: "", label: "All roles" },
          ...ROLE_ORDER.map((id) => ({ id, label: id })),
        ]}
      />
      <ListFilter
        label="State"
        value={state}
        onChange={(value) => go({ state: value })}
        items={[
          { id: "", label: "All states" },
          ...ADMIN_USER_STATES.map((id) => ({ id, label: STATE_LABELS[id] })),
        ]}
      />

      {filtered ? <ClearFilters onPress={clear} /> : null}

      {/* Accounts live in the auth server, which cannot be searched, so the
          API walks it and stops. Said beside the filters, because they are
          the sentence it qualifies — and said nowhere while the walk still
          reaches everybody. */}
      {page.capped ? (
        <span
          className="font-mono text-[11px] text-[var(--ink-mute)]"
          title={`The API stops after ${int(page.cap)} accounts.`}
        >
          among the first {int(page.scanned)} accounts — there are more
        </span>
      ) : null}
    </div>
  );
}
