import Link from "next/link";
import type { Route } from "next";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { Chip } from "@heroui/react";
import { apiJson, ApiError } from "@/web/api-client";
import {
  ERROR_LEVEL_LABELS,
  ERROR_SERVICE_LABELS,
  ERROR_STATUS_LABELS,
  type AdminErrorGroupDetail,
  type ErrorLevel,
  type ErrorService,
  type ErrorStatus,
} from "@bcontext-dev/contract/errors";
import { AdminPage } from "@/components/admin/admin-shell";
import { Empty, Section, Stat } from "@/components/admin/detail-ui";
import { ErrorEvents } from "./error-events";
import { TriageControls } from "./triage-controls";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Admin · Error — Bcontext",
};

const mono: React.CSSProperties = {
  fontFamily: "var(--f-martian-mono), var(--font-mono), monospace",
};

const NUMBER = new Intl.NumberFormat("en");

/** Fixed locale: the server and the browser must agree or hydration breaks. */
function day(iso: string): string {
  return iso.slice(0, 10);
}

function ago(iso: string | null): string {
  if (!iso) return "never";
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (d <= 0) return "today";
  if (d === 1) return "yesterday";
  if (d < 30) return `${d}d ago`;
  return day(iso);
}

/** The same two ladders the list draws, so a problem reads the same in both
 *  places — a status that changes colour on the way to its own page is a
 *  status an operator has to learn twice. */
const STATUS_COLOR: Record<ErrorStatus, "default" | "warning" | "success"> = {
  new: "warning",
  ack: "default",
  resolved: "success",
  ignored: "default",
};

const LEVEL_COLOR: Record<ErrorLevel, "default" | "warning" | "danger"> = {
  warning: "warning",
  error: "default",
  fatal: "danger",
};

/**
 * One problem: what it is, how long it has been happening, who it reached,
 * and what it actually looks like when it happens.
 *
 * The order is the order of the questions asked at three in the morning. The
 * headline names the exception and where it fires, because that is what gets
 * pasted into a message to whoever owns that code. The span comes next —
 * first seen, last seen, and the builds either end of it — because "this
 * started with the deploy an hour ago" and "this has been happening quietly
 * for three weeks" are two different incidents wearing the same message. Then
 * who it reached, which is the difference between an outage and a bug. The
 * occurrences are last and folded shut: they are the evidence, and evidence
 * is read after the summary, not through it.
 *
 * Triage sits at the top rather than the bottom. Marking a problem as seen is
 * the first thing done on arriving, not the last thing done on leaving.
 */
export default async function AdminErrorPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  let group: AdminErrorGroupDetail;
  try {
    group = await apiJson<AdminErrorGroupDetail>(
      `/api/admin/errors/${encodeURIComponent(id)}`,
    );
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) notFound();
    throw err;
  }

  const title = group.error_type ?? group.message.slice(0, 60);
  // Equal releases mean the problem has not survived a deploy yet, which is
  // the one fact about a build worth stating rather than repeating.
  const sameRelease =
    group.first_release !== null && group.first_release === group.last_release;

  return (
    <AdminPage title={title}>
      <Link
        href={"/admin/errors" as Route}
        className="mb-5 inline-flex items-center gap-1.5 text-[12px] text-[var(--ink-3)] transition-colors hover:text-[var(--ink)]"
      >
        <ArrowLeft size={12} /> All problems
      </Link>

      <header className="mb-6">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-[15px] font-medium text-[var(--ink)]" style={mono}>
            {group.error_type ?? "Error"}
          </h1>
          <Chip size="sm" variant="soft" color={LEVEL_COLOR[group.level]}>
            <Chip.Label>{ERROR_LEVEL_LABELS[group.level]}</Chip.Label>
          </Chip>
          <Chip size="sm" variant="soft" color={STATUS_COLOR[group.status]}>
            <Chip.Label>{ERROR_STATUS_LABELS[group.status]}</Chip.Label>
          </Chip>
        </div>

        {/* The message unwrapped and whole. It is the only place on either
            screen that shows all of it, which is why the table was allowed to
            truncate. */}
        <p
          className="mt-2 whitespace-pre-wrap break-words text-[12.5px] leading-relaxed text-[var(--ink-2)]"
          style={mono}
        >
          {group.message}
        </p>

        <div className="mt-2 text-[11px] text-[var(--ink-mute)]" style={mono}>
          {ERROR_SERVICE_LABELS[group.service as ErrorService] ?? group.service}{" "}
          · {group.operation} · {group.fingerprint}
        </div>
      </header>

      <div className="mb-7 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat
          label="First seen"
          value={ago(group.first_seen)}
          hint={day(group.first_seen)}
        />
        <Stat
          label="Last seen"
          value={ago(group.last_seen)}
          hint={day(group.last_seen)}
        />
        <Stat
          label="Events"
          value={NUMBER.format(group.event_count)}
          hint={group.event_count === 1 ? "once" : "occurrences"}
        />
        <Stat
          label="People"
          value={
            group.users_affected === 0 ? "—" : NUMBER.format(group.users_affected)
          }
          hint={
            group.users_affected === 0
              ? "nobody was waiting"
              : group.users_affected === 1
                ? "one person"
                : "distinct people"
          }
        />
      </div>

      <Section
        title="Build"
        hint={
          group.first_release === null && group.last_release === null
            ? "No build was reported with this — the reporter is not sending a release, so nobody can say when it started."
            : sameRelease
              ? "First and last seen on the same build: it has not survived a deploy yet."
              : "The builds either end of it. A problem that spans releases outlived at least one attempt to fix it."
        }
      >
        <div className="flex flex-wrap items-center gap-2 text-[11.5px] text-[var(--ink-2)]" style={mono}>
          <span>first {group.first_release ?? "—"}</span>
          <span className="text-[var(--ink-mute)]">→</span>
          <span>last {group.last_release ?? "—"}</span>
          {group.resolved_at ? (
            <span className="text-[var(--ink-mute)]">
              · resolved {day(group.resolved_at)}
              {group.resolved_release ? ` on ${group.resolved_release}` : ""}
            </span>
          ) : null}
        </div>
      </Section>

      <Section
        title="Triage"
        hint="Where this stands, and what is known about it. A resolved problem that fires again reopens itself — a fix that did not hold is exactly the thing a list of resolved problems must not hide."
      >
        <TriageControls id={group.id} status={group.status} note={group.note} />
      </Section>

      <Section
        title="People"
        hint={
          group.users.length === 0
            ? "Nobody signed in was on the other end of this — it is an agent, a job or a visitor."
            : "Who was on the other end of it. Named because the next move is usually a message to one of them."
        }
      >
        {group.users.length === 0 ? (
          <Empty>
            No account is attached to any of these events.
          </Empty>
        ) : (
          <div className="rounded-md border border-[var(--line)]">
            {group.users.map((user) => (
              <div
                key={user.id}
                className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--line)] px-3 py-2 last:border-b-0"
              >
                <Link
                  href={`/admin/users/${user.id}` as Route}
                  className="truncate text-[12.5px] text-[var(--ink)] transition-colors hover:text-[var(--ink-2)]"
                >
                  {user.email ?? user.id}
                </Link>
                <span
                  className="tabular-nums text-[10.5px] text-[var(--ink-mute)]"
                  style={mono}
                >
                  {NUMBER.format(user.count)}{" "}
                  {user.count === 1 ? "time" : "times"}
                </span>
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section
        title="Occurrences"
        hint="The most recent ones, not all of them: a group can have fifty thousand, and the question this section answers — what does it look like when it happens — is answered as well by the last twenty."
      >
        {group.events.length === 0 ? (
          <Empty>
            No occurrence has been kept. The group is still counted, but the
            events behind it have aged out.
          </Empty>
        ) : (
          <ErrorEvents events={group.events} />
        )}
      </Section>
    </AdminPage>
  );
}



