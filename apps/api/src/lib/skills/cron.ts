/**
 * Five-field cron, evaluated in a timezone, without a dependency.
 *
 * `minute hour day-of-month month day-of-week`, each field `*`, a number, a
 * range `a-b`, a step (`* / n` or `a-b/n`, written without the spaces), or a
 * comma list of those. Day of
 * week is 0–7 with 7 = Sunday, like Vixie cron; when both day fields are
 * restricted a date matches if *either* does, also like Vixie cron.
 *
 * `nextCronRun` walks hour by hour (DST shifts are hour-aligned everywhere
 * that matters) and only looks at minutes inside an hour whose date and hour
 * match — a bounded search, never a busy loop: a schedule that cannot fire
 * within a year (e.g. `0 0 31 2 *`) returns null instead of spinning.
 *
 * Skill schedules store `cron` + `timezone`; the worker turns the pair into
 * `next_run_at`, which is what the due scan compares against.
 */

export interface CronSpec {
  minutes: ReadonlySet<number>;
  hours: ReadonlySet<number>;
  days: ReadonlySet<number>;
  months: ReadonlySet<number>;
  weekdays: ReadonlySet<number>;
  /** An unrestricted (`*`) day-of-month / day-of-week field. */
  anyDay: boolean;
  anyWeekday: boolean;
}

const FIELD_RANGES = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
] as const;

class CronError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CronError";
  }
}

function parseField(raw: string, min: number, max: number): { values: Set<number>; any: boolean } {
  const values = new Set<number>();
  let any = false;
  for (const part of raw.split(",")) {
    const [rangeRaw, stepRaw] = part.split("/");
    const step = stepRaw === undefined ? 1 : Number(stepRaw);
    if (!Number.isInteger(step) || step < 1) throw new CronError(`invalid step in "${part}"`);
    let lo: number;
    let hi: number;
    if (rangeRaw === "*") {
      lo = min;
      hi = max;
      if (step === 1) any = true;
    } else if (/^\d+$/.test(rangeRaw ?? "")) {
      lo = Number(rangeRaw);
      hi = stepRaw === undefined ? lo : max;
    } else if (/^\d+-\d+$/.test(rangeRaw ?? "")) {
      const [a, b] = (rangeRaw as string).split("-").map(Number) as [number, number];
      lo = a;
      hi = b;
    } else {
      throw new CronError(`invalid field "${part}"`);
    }
    if (lo < min || hi > max || lo > hi) throw new CronError(`"${part}" out of range ${min}-${max}`);
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  return { values, any };
}

export function parseCron(expression: string): CronSpec {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) throw new CronError("cron needs five fields: minute hour day month weekday");
  const parsed = fields.map((f, i) => parseField(f, FIELD_RANGES[i]![0], FIELD_RANGES[i]![1]));
  const weekdays = new Set(parsed[4]!.values);
  if (weekdays.has(7)) weekdays.add(0);
  return {
    minutes: parsed[0]!.values,
    hours: parsed[1]!.values,
    days: parsed[2]!.values,
    months: parsed[3]!.values,
    weekdays,
    anyDay: parsed[2]!.any,
    anyWeekday: parsed[4]!.any,
  };
}

export function isValidCron(expression: string): boolean {
  try {
    parseCron(expression);
    return true;
  } catch {
    return false;
  }
}

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

interface LocalFields {
  minute: number;
  hour: number;
  day: number;
  month: number;
  weekday: number;
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      weekday: "short",
    });
    formatters.set(tz, f);
  }
  return f;
}

function localFields(date: Date, tz: string): LocalFields {
  const out: Partial<LocalFields> = {};
  for (const part of formatter(tz).formatToParts(date)) {
    switch (part.type) {
      case "minute": out.minute = Number(part.value); break;
      case "hour": out.hour = Number(part.value) % 24; break;
      case "day": out.day = Number(part.value); break;
      case "month": out.month = Number(part.value); break;
      case "weekday": out.weekday = WEEKDAYS[part.value] ?? 0; break;
    }
  }
  return out as LocalFields;
}

function dateMatches(spec: CronSpec, f: LocalFields): boolean {
  if (!spec.months.has(f.month)) return false;
  const dayOk = spec.days.has(f.day);
  const weekdayOk = spec.weekdays.has(f.weekday);
  if (spec.anyDay && spec.anyWeekday) return true;
  if (spec.anyDay) return weekdayOk;
  if (spec.anyWeekday) return dayOk;
  return dayOk || weekdayOk;
}

const HOUR = 3_600_000;
const MINUTE = 60_000;
/** How far ahead to look before giving up. */
const HORIZON_HOURS = 24 * 366;

/**
 * First instant strictly after `from` at which the expression fires in `tz`.
 * Null when there is none within a year.
 */
export function nextCronRun(expression: string, tz: string, from: Date): Date | null {
  const spec = parseCron(expression);
  const zone = isValidTimezone(tz) ? tz : "UTC";
  const minutes = [...spec.minutes].sort((a, b) => a - b);
  // Start at the top of `from`'s hour; the first pass filters minutes <= from.
  const fromMs = from.getTime();
  let hourStart = Math.floor(fromMs / HOUR) * HOUR;
  for (let i = 0; i < HORIZON_HOURS; i += 1, hourStart += HOUR) {
    const f = localFields(new Date(hourStart), zone);
    if (!spec.hours.has(f.hour) || !dateMatches(spec, f)) continue;
    // Some zones sit on a half-hour offset; the local minute at the top of the
    // UTC hour tells us how far the wall clock is from :00.
    const base = hourStart - f.minute * MINUTE;
    for (const m of minutes) {
      const candidate = base + m * MINUTE;
      if (candidate > fromMs) return new Date(candidate);
    }
  }
  return null;
}
