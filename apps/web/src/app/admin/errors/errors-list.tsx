"use client";

/**
 * Every problem the platform is having, one table row each.
 *
 * A row is a group and not an occurrence. The collector folds events onto a
 * fingerprint precisely so this screen can be read: the same null dereference
 * firing four thousand times is one thing to fix, and a list that showed it
 * four thousand times would hide the eleven other things next to it. The
 * counts — how often, how many people — are what turns that fold back into a
 * sense of scale.
 *
 * The rows arrive already narrowed and already ordered: `/api/admin/errors`
 * applies the search, the service, the status and the level to every group it
 * holds before it cuts the page, and orders by what was seen most recently.
 * A predicate re-applied here could only hide rows the API already chose to
 * send, and a sort could only order fifty rows against each other rather than
 * against the platform.
 *
 * Nothing wraps: a message that folds onto a second line stops being
 * comparable with the one above it, and a stack trace pasted into a cell
 * would take the table with it — so the columns keep their line, long text
 * truncates, and the table scrolls sideways inside its own frame. The whole
 * message is one click away on the detail page, which is where reading rather
 * than scanning happens.
 *
 * The furniture is the shared one in `components/admin/list-ui`; the table is
 * HeroUI's, which is where the row's own affordances come from — hover, focus,
 * and a row that answers the keyboard as well as the pointer.
 */

import { useCallback, useMemo } from "react";
import type { Route } from "next";
import { useRouter, useSearchParams } from "next/navigation";
import { Chip, Table } from "@heroui/react";
import {
  ADMIN_ERROR_DEFAULT_STATUSES,
  ERROR_LEVELS,
  ERROR_LEVEL_LABELS,
  ERROR_SERVICE_LABELS,
  ERROR_STATUSES,
  ERROR_STATUS_LABELS,
  type AdminErrorPage,
  type ErrorLevel,
  type ErrorService,
  type ErrorStatus,
} from "@bcontext-dev/contract/errors";
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

/**
 * Where triage has got to. Colour marks what still wants somebody, and the
 * steady state is quiet — the same rule the accounts list follows, where
 * being in is the colourless one because most rows are it.
 *
 * That matters more here than there: the default narrowing is what is still
 * open, so `new` is what nearly every row is. Painting it red would make a
 * column of alarm that says nothing and leave nothing louder for the row that
 * genuinely is. `ack` is somebody already holding it, so it goes quiet too.
 *
 * Danger is spent on one thing only, and it is not a status: `fatal` on the
 * level, which is the process dying. One meaning per colour.
 */
const STATUS_COLOR: Record<ErrorStatus, "default" | "warning" | "success"> = {
  new: "warning",
  ack: "default",
  resolved: "success",
  ignored: "default",
};

/** How bad, and only the two ends of it are coloured: `error` is what nearly
 *  every row is, and a column of red says nothing. `fatal` took the process
 *  with it, which is a different phone call. */
const LEVEL_COLOR: Record<ErrorLevel, "default" | "warning" | "danger"> = {
  warning: "warning",
  error: "default",
  fatal: "danger",
};

/** A service the vocabulary knows reads as its name; anything else is shown
 *  verbatim rather than hidden, the way the plan column does it. */
function serviceLabel(service: string): string {
  return ERROR_SERVICE_LABELS[service as ErrorService] ?? service;
}

export function ErrorsList({ page }: { page: AdminErrorPage }) {
  const router = useRouter();
  const search = useSearchParams();
  const go = useListNav();
  const q = search.get("q") ?? "";
  const service = search.get("service") ?? "";
  const status = search.get("status") ?? "";
  const level = search.get("level") ?? "";
  const filtered = q !== "" || service !== "" || status !== "" || level !== "";

  const clear = useCallback(
    () => go({ q: "", service: "", status: "", level: "" }),
    [go],
  );

  return (
    <div>
      <ErrorFiltersBar
        q={q}
        service={service}
        status={status}
        level={level}
        go={go}
        clear={clear}
        filtered={filtered}
        page={page}
      />

      {page.items.length === 0 ? (
        <NoRows
          title={filtered ? "Nothing matches" : "Nothing is broken"}
          description={
            filtered
              ? "No problem matches these filters."
              : // The default narrowing is what is still open, so an empty
                // table is good news rather than an unreported one — but only
                // once it is said that the resolved ones are still in here.
                "Nothing open right now. Resolved and ignored problems are still here, under Status."
          }
          onClear={filtered ? clear : undefined}
        />
      ) : (
        <>
          <Table className="mt-4">
            <Table.ScrollContainer>
              <Table.Content
                aria-label="Problems"
                className="min-w-[980px] whitespace-nowrap"
                // The row is the link. React Aria gives it the pointer and
                // the keyboard at once, which the hand-rolled onClick never
                // did.
                onRowAction={(key) =>
                  router.push(`/admin/errors/${key}` as Route)
                }
              >
                <Table.Header>
                  <Table.Column isRowHeader>Problem</Table.Column>
                  <Table.Column>Where</Table.Column>
                  <Table.Column>Status</Table.Column>
                  <Table.Column>Events</Table.Column>
                  <Table.Column>People</Table.Column>
                  <Table.Column>Last seen</Table.Column>
                </Table.Header>
                <Table.Body>
                  {page.items.map((group) => (
                    <Table.Row
                      key={group.id}
                      id={group.id}
                      className="cursor-pointer"
                    >
                      {/* The exception's own name reads first and the message
                          under it: the name is what an operator recognises
                          across a week, the message is how this one differed.
                          Both are monospaced because both are code that got
                          out. */}
                      <Table.Cell className="max-w-[420px]">
                        <div className="flex items-center gap-1.5">
                          <span className="truncate font-mono text-[12px] text-[var(--ink)]">
                            {group.error_type ?? "Error"}
                          </span>
                          <Chip
                            size="sm"
                            variant="soft"
                            color={LEVEL_COLOR[group.level]}
                          >
                            <Chip.Label>
                              {ERROR_LEVEL_LABELS[group.level]}
                            </Chip.Label>
                          </Chip>
                        </div>
                        <div
                          className="truncate font-mono text-[10.5px] text-[var(--ink-3)]"
                          title={group.message}
                        >
                          {group.message}
                        </div>
                      </Table.Cell>

                      {/* The service is one of five answers and never told
                          anybody anything on its own; the operation is what a
                          fix is scoped to. So the operation is the line you
                          read and the service is the label beside it. */}
                      <Table.Cell className="max-w-[300px]">
                        <div className="truncate font-mono text-[12px] text-[var(--ink-2)]">
                          {group.operation}
                        </div>
                        <div className="truncate text-[10.5px] text-[var(--ink-mute)]">
                          {serviceLabel(group.service)}
                        </div>
                      </Table.Cell>

                      <Table.Cell>
                        <Chip
                          size="sm"
                          variant="soft"
                          color={STATUS_COLOR[group.status]}
                        >
                          <Chip.Label>
                            {ERROR_STATUS_LABELS[group.status]}
                          </Chip.Label>
                        </Chip>
                      </Table.Cell>

                      <Table.Cell className="tabular-nums text-[var(--ink-2)]">
                        {int(group.event_count)}
                      </Table.Cell>

                      {/* Nobody is not zero: an error in a worker job nobody
                          was waiting for is a different urgency from one that
                          reached eleven customers, and a dash says which. */}
                      <Table.Cell
                        className={
                          group.users_affected === 0
                            ? "tabular-nums text-[var(--ink-mute)]"
                            : "tabular-nums text-[var(--ink-2)]"
                        }
                      >
                        {group.users_affected === 0
                          ? "—"
                          : int(group.users_affected)}
                      </Table.Cell>

                      <Table.Cell className="tabular-nums text-[var(--ink-3)]">
                        {/* The relative reading is what the eye compares; the
                            timestamp itself is one hover away, because "3d
                            ago" stops being an answer the moment two problems
                            need lining up against a deploy. */}
                        <span title={group.last_seen}>
                          {ago(group.last_seen)}
                        </span>
                      </Table.Cell>
                    </Table.Row>
                  ))}
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
 * as the organizations and users screens, so the control is learned
 * once.
 *
 * Nothing collapses: a filter you have to remember to open is a filter nobody
 * uses, and one hidden inside a drawer can silently be hiding rows. Every
 * control shows its own state, so "on" is legible without a badge counting
 * for it, and Clear appears the moment anything is set.
 *
 * The service and status options carry the counts the API computed over the
 * whole set rather than the page, so turning a page never moves them — and
 * the services offered are the ones that have actually reported, because a
 * filter that can only ever return nothing is a trap.
 */
function ErrorFiltersBar({
  q,
  service,
  status,
  level,
  go,
  clear,
  filtered,
  page,
}: {
  q: string;
  service: string;
  status: string;
  level: string;
  go: ListNav;
  clear: () => void;
  filtered: boolean;
  page: AdminErrorPage;
}) {
  const onSearch = useCallback((value: string) => go({ q: value }), [go]);
  const statusCounts = useMemo(
    () => new Map(page.facets.statuses.map((s) => [s.id, s.count])),
    [page.facets.statuses],
  );
  // What the empty option is actually showing: an option that carries a
  // number next to every value except the default one reads as if the
  // default had none.
  const openCount = useMemo(
    () =>
      ADMIN_ERROR_DEFAULT_STATUSES.reduce(
        (sum, s) => sum + (statusCounts.get(s) ?? 0),
        0,
      ),
    [statusCounts],
  );

  return (
    <div className="flex flex-wrap items-center gap-2">
      <ListSearch
        value={q}
        onSearch={onSearch}
        label="Search problems by message, type or operation"
        placeholder="Search by message or operation"
      />

      <ListFilter
        label="Service"
        value={service}
        onChange={(value) => go({ service: value })}
        items={[
          { id: "", label: "All services" },
          ...page.facets.services.map((s) => ({
            id: s.id,
            label: `${serviceLabel(s.id)} (${int(s.count)})`,
          })),
        ]}
      />
      {/* The empty option is not "everything": with no status asked for, the
          API answers with what is still open, so it says "Open" rather than
          "All statuses" — the second would be a lie about what is on screen,
          and an operator would read the resolved ones as deleted.

          Two words, because this control is `w-44` like every other filter in
          the panel and a longer label wraps onto a second line, leaving one
          control taller than its three neighbours and the whole bar ragged.
          The four values are spelled out in the list underneath, which is
          where the explanation belongs. */}
      <ListFilter
        label="Status"
        value={status}
        onChange={(value) => go({ status: value })}
        items={[
          { id: "", label: `Open (${int(openCount)})` },
          ...ERROR_STATUSES.map((s) => ({
            id: s,
            label: `${ERROR_STATUS_LABELS[s]} (${int(statusCounts.get(s) ?? 0)})`,
          })),
        ]}
      />
      <ListFilter
        label="Level"
        value={level}
        onChange={(value) => go({ level: value })}
        items={[
          { id: "", label: "All levels" },
          ...ERROR_LEVELS.map((l) => ({ id: l, label: ERROR_LEVEL_LABELS[l] })),
        ]}
      />

      {filtered ? <ClearFilters onPress={clear} /> : null}

    </div>
  );
}
