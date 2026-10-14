"use client";

/**
 * The one screen of the panel that is numbers rather than rows.
 *
 * It reads top-down in the order an operator acts: who needs a message this
 * morning, then the figures that say how much the instance is used, then the
 * month-by-month table those figures are a slice of. Nothing here is a
 * different design system from the lists — same table primitives, same
 * quiet controls, same tokens — because the panel is dark and any component
 * that brings its own surface renders unreadable on it.
 */

import { useState } from "react";
import Link from "next/link";
import type { Route } from "next";
import { RefreshCw } from "lucide-react";
import { Alert, Button, Label, ListBox, Select, Table } from "@heroui/react";
import { KPI } from "@/components/ui/kpi";
import { LineChart } from "@/components/ui/charts";
import { cn } from "@bcontext-dev/contract/utils";
import type {
  DashboardMetrics,
  PeriodMetrics,
} from "@bcontext-dev/contract/admin-metrics";
import type { AdminOrgHealth } from "@bcontext-dev/contract/admin-orgs";

const mono: React.CSSProperties = {
  fontFamily: "var(--f-martian-mono), var(--font-mono), monospace",
};

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

/**
 * A customer stalls before it starts and drifts after it starts, and the two
 * look nothing alike — so they are named separately rather than folded into
 * one "unhealthy" flag an operator would then have to open to understand.
 *
 * Three days is the threshold for a stalled invitation because that is about
 * how long a person takes to get round to an email; below it, chasing is
 * noise. Fourteen for going quiet, because a week off is a holiday and two
 * is a habit that stopped.
 */
const STALE_INVITE_DAYS = 3;
const QUIET_DAYS = 14;

type Alarm = "stalled" | "quiet" | null;

function alarmFor(org: AdminOrgHealth): Alarm {
  if (org.first_sign_in_at === null) {
    // Nobody has ever been inside. Only worth raising once the invitation has
    // had time to be read — and only if one was actually sent.
    if (
      org.oldest_pending_invite_at &&
      daysSince(org.oldest_pending_invite_at) >= STALE_INVITE_DAYS
    ) {
      return "stalled";
    }
    return null;
  }
  // It started. The question is whether it is still going.
  if (
    org.last_activity_at &&
    daysSince(org.last_activity_at) >= QUIET_DAYS &&
    org.mcp_calls + org.writes === 0
  ) {
    return "quiet";
  }
  return null;
}

function alarmLine(org: AdminOrgHealth, alarm: Alarm): string | null {
  if (alarm === "stalled") {
    const d = org.oldest_pending_invite_at
      ? daysSince(org.oldest_pending_invite_at)
      : daysSince(org.created_at);
    return `Invited ${d} day${d === 1 ? "" : "s"} ago, never signed in.`;
  }
  if (alarm === "quiet") {
    return `Was busy, went quiet — nothing since ${ago(org.last_activity_at)}.`;
  }
  return null;
}

function usd(n: number | null | undefined): string {
  if (n == null) return "—";
  const neg = n < 0;
  const v = Math.abs(n).toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });
  return `${neg ? "−" : ""}$${v}`;
}

function int(n: number): string {
  return n.toLocaleString("en-US");
}

/**
 * When the API answered, to the minute and in UTC.
 *
 * Read off the ISO string rather than through the browser's locale: the
 * server renders this screen first, and a timestamp formatted two ways is a
 * hydration mismatch that shows up as the number flickering on load.
 */
function stamp(iso: string): string {
  return `${iso.slice(0, 16).replace("T", " ")} UTC`;
}

/** How far back the table looks. Three is a quarter, twelve is a year, and
 *  six is what the screen opens on. */
const MONTH_CHOICES = [3, 6, 12] as const;

/** The API's own default, so the first paint and the first reload agree. */
const DEFAULT_MONTHS = 6;

export function AdminDashboard({
  initial,
  health,
  healthError,
}: {
  initial: DashboardMetrics;
  health: AdminOrgHealth[];
  healthError: string | null;
}) {
  const [data, setData] = useState<DashboardMetrics>(initial);
  const [months, setMonths] = useState<number>(DEFAULT_MONTHS);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function reload(m = months) {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/metrics?months=${m}`, {
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData((await res.json()) as DashboardMetrics);
      setMonths(m);
    } catch (e) {
      setError(e instanceof Error ? e.message : "reload failed");
    } finally {
      setLoading(false);
    }
  }

  const current = data.periods[0];

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <Select
          aria-label="Months to compare"
          variant="secondary"
          className="w-44"
          isDisabled={loading}
          selectedKey={String(months)}
          onSelectionChange={(key) => {
            if (key !== null) void reload(Number(key));
          }}
        >
          <Select.Trigger>
            <Select.Value />
            <Select.Indicator />
          </Select.Trigger>
          <Select.Popover>
            <ListBox>
              {MONTH_CHOICES.map((m) => (
                <ListBox.Item
                  key={m}
                  id={String(m)}
                  textValue={`Last ${m} months`}
                >
                  <Label>Last {m} months</Label>
                  <ListBox.ItemIndicator />
                </ListBox.Item>
              ))}
            </ListBox>
          </Select.Popover>
        </Select>

        <Button
          size="sm"
          variant="secondary"
          isDisabled={loading}
          onPress={() => void reload()}
        >
          <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
          Reload
        </Button>

        <span
          className="font-mono text-[11px] text-[var(--ink-mute)]"
          title="When the API computed these numbers."
        >
          updated {stamp(data.generatedAt)}
        </span>
      </div>

      {error ? (
        <Alert role="alert" status="danger" className="mt-3">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>
              Couldn&apos;t reload the metrics: {error}
            </Alert.Description>
          </Alert.Content>
        </Alert>
      ) : null}

      <WorthAMessageToday orgs={health} error={healthError} />

      <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Kpi
          label="Model calls · month"
          value={int(current?.aiQueries ?? 0)}
          sub={`cost ${usd(current ? current.aiCostUsd : 0)} · measured`}
        />
        <Kpi
          label="Organizations"
          value={healthError ? "—" : int(health.length)}
          sub="on this instance"
        />
      </div>

      <Section title="Month by month">
        <Table>
          <Table.ScrollContainer>
            <Table.Content
              aria-label="Month by month"
              className="min-w-[480px] whitespace-nowrap"
            >
              <Table.Header>
                <Table.Column isRowHeader>Month</Table.Column>
                <Table.Column>AI calls</Table.Column>
                <Table.Column>
                  <span title="The sum of what every model call cost, from the usage ledger — the gateway's own figure per call, or the per-model price table when it reports none.">
                    AI cost
                  </span>
                </Table.Column>
                <Table.Column>Meeting h</Table.Column>
              </Table.Header>
              <Table.Body>
                {data.periods.map((p, i) => {
                  // Every month but the current one is history: it is still
                  // read, so it is dimmed rather than dropped.
                  const past = i > 0 ? "text-[var(--ink-3)]" : "";
                  return (
                    <Table.Row key={p.period} id={p.period}>
                      <Table.Cell className={cn("tabular-nums", past)}>
                        {p.period}
                        {i === 0 ? " · current" : ""}
                      </Table.Cell>
                      <Table.Cell className={cn("tabular-nums", past)}>
                        {int(p.aiQueries)}
                      </Table.Cell>
                      <Table.Cell className={cn("tabular-nums", past)}>
                        {usd(p.aiCostUsd)}
                      </Table.Cell>
                      <Table.Cell className={cn("tabular-nums", past)}>
                        {int(p.meetingHours)}
                      </Table.Cell>
                    </Table.Row>
                  );
                })}
              </Table.Body>
            </Table.Content>
          </Table.ScrollContainer>
        </Table>
        <Caption>
          AI calls are counted and their cost summed per month from the usage
          ledger; meeting hours are counted.
        </Caption>
      </Section>

      <Section title="Usage over time">
        <UsageChart periods={data.periods} />
      </Section>
    </div>
  );
}

/**
 * One figure, with the sentence that stops it being misread underneath.
 *
 * The number leads because it is what the eye is here for; the qualifier is
 * dimmer because it is only ever read second, and never on its own.
 */
function Kpi({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub: string;
}) {
  return (
    <KPI className="min-w-0 rounded-md border border-[var(--line)] bg-[var(--paper-2)] p-3">
      <KPI.Header>
        <KPI.Title className="truncate" title={label}>
          {label}
        </KPI.Title>
      </KPI.Header>
      <KPI.Content>
        {/* The value is already formatted — a currency, a count, or two
            counts over a slash — so it is written into the component's own
            value slot rather than through KPI.Value, which formats a number
            it is given and cannot say "3 / 5". */}
        <span
          className="kpi__value truncate font-mono text-[19px]"
        >
          {value}
        </span>
      </KPI.Content>
      <KPI.Footer className="mt-1.5 text-[11px] leading-snug text-[var(--ink-3)]">
        {sub}
      </KPI.Footer>
    </KPI>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-8">
      <h2 className="mb-2 font-mono text-[10px] uppercase tracking-[0.06em] text-[var(--ink-mute)]">
        {title}
      </h2>
      {children}
    </section>
  );
}

/** What a block of numbers needs said about it, kept under the numbers so it
 *  never stands between the screen and the figures it qualifies. */
function Caption({ children }: { children: React.ReactNode }) {
  return (
    <p className="mt-2 max-w-2xl text-[11px] text-[var(--ink-3)]">{children}</p>
  );
}

/**
 * Two lines over the months, each with its own axis.
 *
 * The two series never share a scale. Calls run in the hundreds and meeting
 * hours in single digits, so one axis would flatten hours into the baseline
 * and say "nothing happened" about a month that had meetings in it. Two axes,
 * one labelled on each side, is the honest drawing.
 */
function UsageChart({ periods }: { periods: PeriodMetrics[] }) {
  // Periods arrive most-recent-first; time reads left to right.
  const data = [...periods].reverse().map((p) => ({
    period: p.period,
    calls: p.aiQueries,
    hours: p.meetingHours,
  }));
  if (data.length === 0) return null;

  return (
    <div className="rounded-md border border-[var(--line)] bg-[var(--paper-2)] px-4 py-3">
      <LineChart data={data} height={200}>
        <LineChart.Grid vertical={false} />
        {/* The point carries the whole period so the tooltip can say
            "2026-09"; only the tick is shortened to the month. */}
        <LineChart.XAxis
          dataKey="period"
          tickMargin={8}
          tickFormatter={(v: string) => v.slice(5)}
        />
        <LineChart.YAxis
          yAxisId="calls"
          width={44}
          tickFormatter={(v: number) => int(v)}
        />
        <LineChart.YAxis
          yAxisId="hours"
          orientation="right"
          width={32}
          tickFormatter={(v: number) => String(Math.round(v))}
        />
        <LineChart.Line
          yAxisId="calls"
          dataKey="calls"
          name="AI calls"
          type="monotone"
          stroke="var(--chart-4)"
          strokeWidth={2}
          dot={{ r: 2.5, strokeWidth: 0, fill: "var(--chart-4)" }}
          activeDot={{ r: 4 }}
        />
        <LineChart.Line
          yAxisId="hours"
          dataKey="hours"
          name="Meeting hours"
          type="monotone"
          stroke="var(--chart-2)"
          strokeWidth={2}
          strokeDasharray="5 5"
          dot={{ r: 2.5, strokeWidth: 0, fill: "var(--chart-2)" }}
          activeDot={{ r: 4 }}
        />
        <LineChart.Tooltip
          content={
            <LineChart.TooltipContent
              valueFormatter={(v) => Number(v).toLocaleString("en-US")}
            />
          }
        />
      </LineChart>
      <div className="mt-2 flex items-center gap-4 text-[11px] text-[var(--ink-3)]">
        <Legend color="var(--chart-4)">AI calls (left)</Legend>
        <Legend color="var(--chart-2)" dashed>
          Meeting hours (right)
        </Legend>
      </div>
    </div>
  );
}

/**
 * The key under the chart. Two lines of the same hue read as one series until
 * the swatch says which is which, so the swatch is drawn the way the line is
 * drawn: a bar in the line's colour, dashed when the line is dashed.
 */
function Legend({
  color,
  dashed,
  children,
}: {
  color: string;
  dashed?: boolean;
  children: React.ReactNode;
}) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        aria-hidden
        className={cn("h-0 w-4 border-t-2", dashed && "border-dashed")}
        style={{ borderColor: color }}
      />
      {children}
    </span>
  );
}

/**
 * Which organization needs a message today.
 *
 * It sits above the numbers because it is the only thing on this screen an
 * operator can act on this morning, and twenty organizations read one at a
 * time is not a sweep. Only the two moments that call for a message are
 * here — one that never got started and one that stopped; how far each has
 * climbed is the Organizations list.
 */
function WorthAMessageToday({
  orgs,
  error,
}: {
  orgs: AdminOrgHealth[];
  error: string | null;
}) {
  if (error) {
    return (
      <Alert role="alert" status="danger" className="mt-6">
        <Alert.Indicator />
        <Alert.Content>
          <Alert.Description>
            Customer health couldn&apos;t be loaded: {error}
          </Alert.Description>
        </Alert.Content>
      </Alert>
    );
  }

  const alarms = new Map(orgs.map((o) => [o.id, alarmFor(o)] as const));
  const stalled = orgs.filter((o) => alarms.get(o.id) === "stalled");
  const quiet = orgs.filter((o) => alarms.get(o.id) === "quiet");
  if (stalled.length + quiet.length === 0) return null;

  return (
    <section className="mt-8">
      <h2 className="text-[14px] font-medium text-[var(--ink)]">
        Worth a message today
      </h2>
      <p className="mb-3 mt-0.5 max-w-2xl text-[11.5px] text-[var(--ink-3)]">
        {stalled.length} never signed in · {quiet.length} went quiet — the two
        moments an operator has to act. Everyone else is on{" "}
        <Link
          href={"/admin/orgs" as Route}
          className="text-[var(--ink-2)] underline underline-offset-2"
        >
          Organizations
        </Link>
        .
      </p>
      <div className="rounded-md border border-[var(--line)]">
        {[...stalled, ...quiet].map((org) => {
          const alarm = alarms.get(org.id) ?? null;
          return (
            <Link
              key={org.id}
              href={`/admin/orgs/${org.id}` as Route}
              className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--line)] px-3 py-2.5 transition-colors last:border-b-0 hover:bg-[var(--paper-2)]"
            >
              <div className="flex min-w-0 items-center gap-2.5">
                <span
                  aria-hidden
                  className={cn(
                    "h-1.5 w-1.5 shrink-0 rounded-full",
                    alarm === "stalled"
                      ? "bg-[var(--danger,#dc2626)]"
                      : "bg-[var(--ink-mute)]",
                  )}
                />
                <span className="truncate text-[12.5px] text-[var(--ink)]">
                  {org.name}
                </span>
                <span
                  className="truncate text-[11px] text-[var(--ink-3)]"
                  style={mono}
                >
                  {org.owner_email ?? "no owner on record"}
                </span>
              </div>
              <span className="text-[11.5px] text-[var(--ink-2)]">
                {alarmLine(org, alarm)}
              </span>
            </Link>
          );
        })}
      </div>
    </section>
  );
}
