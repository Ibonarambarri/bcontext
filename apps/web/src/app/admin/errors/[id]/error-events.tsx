"use client";

/**
 * The last occurrences of one problem, each folded shut until it is asked for.
 *
 * Twenty stack traces laid out flat is a page nobody scrolls to the bottom
 * of, and they are nearly the same trace twenty times over — the value is in
 * comparing their headers (when, which build, which request) and then opening
 * the one that looks different. So the header is the row and the trace is
 * behind it, with the most recent one already open because that is the one
 * being asked about nine times out of ten.
 *
 * The trace scrolls inside its own box. A stack is a hundred lines of
 * whatever width the frames happen to be, and letting it size the page turns
 * every other section into something you have to scroll past sideways.
 */

import { useState } from "react";
import { Button, Chip, Disclosure } from "@heroui/react";
import type { AdminErrorEvent } from "@bcontext-dev/contract/errors";

const mono: React.CSSProperties = {
  fontFamily: "var(--f-martian-mono), var(--font-mono), monospace",
};

/** Fixed locale: the server and the browser must agree or hydration breaks.
 *  Seconds are kept — two events a minute apart and two a second apart are
 *  different stories about the same trace. */
function stamp(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)}`;
}

export function ErrorEvents({ events }: { events: AdminErrorEvent[] }) {
  return (
    <div className="flex flex-col gap-2">
      {events.map((event, i) => (
        <EventRow key={event.id} event={event} defaultOpen={i === 0} />
      ))}
    </div>
  );
}

function EventRow({
  event,
  defaultOpen,
}: {
  event: AdminErrorEvent;
  defaultOpen: boolean;
}) {
  const [isExpanded, setIsExpanded] = useState(defaultOpen);

  return (
    <Disclosure isExpanded={isExpanded} onExpandedChange={setIsExpanded}>
      <Disclosure.Heading>
        {/* The documented trigger is a Button carrying `slot="trigger"`: it
            is what wires the press, the keyboard and the expanded state,
            which a bare element with a click handler never does. */}
        <Button
          slot="trigger"
          variant="ghost"
          className="w-full justify-between gap-3 border border-[var(--line)] px-3 py-2 text-left"
        >
          <span className="flex min-w-0 items-center gap-2">
            <span
              className="shrink-0 text-[11px] tabular-nums text-[var(--ink-2)]"
              style={mono}
            >
              {stamp(event.received_at)}
            </span>
            <span
              className="truncate text-[11px] text-[var(--ink-3)]"
              style={mono}
            >
              {event.operation}
            </span>
          </span>
          <span className="flex shrink-0 items-center gap-2">
            {event.status_code !== null ? (
              <span
                className="text-[11px] tabular-nums text-[var(--ink-3)]"
                style={mono}
              >
                {event.status_code}
              </span>
            ) : null}
            {event.release ? (
              <Chip size="sm" variant="secondary">
                <Chip.Label>{event.release}</Chip.Label>
              </Chip>
            ) : null}
            <Disclosure.Indicator />
          </span>
        </Button>
      </Disclosure.Heading>

      <Disclosure.Content>
        <Disclosure.Body className="mt-1 rounded-md border border-[var(--line)] p-3">
          {/* The message of this occurrence, not the group's: they differ in
              their variable parts, and the variable part is usually the id
              that explains which record it choked on. */}
          <p
            className="text-[12px] leading-relaxed text-[var(--ink)]"
            style={mono}
          >
            {event.message}
          </p>

          {/* The four fields that turn this row into a query somewhere else:
              two ids for the log line and the trace across processes, and the
              build and the box it happened on — which is how "one replica is
              sick" is ever noticed. */}
          <Facts
            title="Cross-reference"
            items={[
              ["request_id", event.request_id],
              ["correlation_id", event.correlation_id],
              ["release", event.release],
              ["instance", event.instance],
            ]}
          />

          <Facts
            title="Request"
            items={[
              [
                "path",
                event.path ? `${event.method ?? ""} ${event.path}`.trim() : null,
              ],
              ["url", event.url],
              [
                "duration",
                event.duration_ms === null ? null : `${event.duration_ms}ms`,
              ],
              ["user agent", event.user_agent],
            ]}
          />

          <Facts
            title="Who"
            items={[
              ["actor", event.actor_type],
              ["user", event.user_id],
              ["organization", event.organization_id],
              ["workspace", event.workspace_id],
              ["token", event.token_id],
            ]}
          />

          <Facts
            title="Job"
            items={[
              ["job", event.job_name],
              ["job_id", event.job_id],
              ["attempt", event.attempt === null ? null : String(event.attempt)],
            ]}
          />

          {event.occurred_at &&
          event.occurred_at.slice(0, 19) !== event.received_at.slice(0, 19) ? (
            // The gap between happening and arriving is itself a symptom — a
            // queue backing up, a browser reporting on its next load — so it
            // is only said when there is one.
            <p className="mt-3 text-[10.5px] text-[var(--ink-mute)]" style={mono}>
              happened {stamp(event.occurred_at)} · arrived{" "}
              {stamp(event.received_at)}
            </p>
          ) : null}

          <Block title="Stack" text={event.stack} />
          <Block title="Cause" text={event.cause} />
          <Block
            title="Context"
            text={
              event.context && Object.keys(event.context).length > 0
                ? JSON.stringify(event.context, null, 2)
                : null
            }
          />
        </Disclosure.Body>
      </Disclosure.Content>
    </Disclosure>
  );
}

/**
 * A handful of labelled ids. Whatever is missing is left out rather than
 * drawn as a dash: a browser error has no job and a cron has no request, and
 * a grid of empty rows is a page that looks like it failed to load.
 */
function Facts({
  title,
  items,
}: {
  title: string;
  items: Array<readonly [string, string | null]>;
}) {
  const present = items.filter(([, value]) => value);
  if (present.length === 0) return null;

  return (
    <div className="mt-3">
      <div className="text-[10px] uppercase tracking-[0.06em] text-[var(--ink-mute)]">
        {title}
      </div>
      <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
        {present.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-[11px] text-[var(--ink-mute)]">{label}</dt>
            {/* Selectable and unwrapped: these are copied into a log search,
                and a line break inserted for looks copies out with it. */}
            <dd
              className="overflow-x-auto whitespace-nowrap text-[11px] text-[var(--ink-2)]"
              style={mono}
            >
              {value}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/** Text that came out of a machine: fixed width, its own scroll in both
 *  directions, and absent entirely when the reporter sent nothing. */
function Block({ title, text }: { title: string; text: string | null }) {
  if (!text) return null;

  return (
    <div className="mt-3">
      <div className="text-[10px] uppercase tracking-[0.06em] text-[var(--ink-mute)]">
        {title}
      </div>
      <pre
        className="scroll mt-1 max-h-80 overflow-auto rounded-md bg-[var(--paper-3)] p-2.5 text-[11px] leading-[1.6] text-[var(--ink-2)]"
        style={mono}
      >
        {text}
      </pre>
    </div>
  );
}
