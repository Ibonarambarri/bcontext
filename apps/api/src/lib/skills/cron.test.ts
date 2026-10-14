import { describe, expect, it } from "vitest";
import { isValidCron, isValidTimezone, nextCronRun, parseCron } from "./cron";

describe("parseCron", () => {
  it("reads stars, numbers, lists, ranges and steps", () => {
    const spec = parseCron("0,30 9-17/4 * 1 1-5");
    expect([...spec.minutes]).toEqual([0, 30]);
    expect([...spec.hours]).toEqual([9, 13, 17]);
    expect(spec.anyDay).toBe(true);
    expect([...spec.months]).toEqual([1]);
    expect([...spec.weekdays]).toEqual([1, 2, 3, 4, 5]);
    expect(spec.anyWeekday).toBe(false);
  });

  it("treats 7 as Sunday", () => {
    expect(parseCron("0 0 * * 7").weekdays.has(0)).toBe(true);
  });

  it("rejects the wrong number of fields, out-of-range values and bad steps", () => {
    expect(isValidCron("0 9 * *")).toBe(false);
    expect(isValidCron("60 9 * * *")).toBe(false);
    expect(isValidCron("0 9 * * */0")).toBe(false);
    expect(isValidCron("0 9 * * mon")).toBe(false);
    expect(isValidCron("0 9 * * 1")).toBe(true);
  });
});

describe("nextCronRun", () => {
  const from = new Date("2026-09-08T12:34:00.000Z"); // Tuesday

  it("finds the next Monday 09:00 UTC", () => {
    expect(nextCronRun("0 9 * * 1", "UTC", from)?.toISOString()).toBe("2026-09-14T09:00:00.000Z");
  });

  it("is strictly after `from`", () => {
    const exact = new Date("2026-09-14T09:00:00.000Z");
    expect(nextCronRun("0 9 * * 1", "UTC", exact)?.toISOString()).toBe("2026-09-21T09:00:00.000Z");
  });

  it("evaluates the wall clock in the schedule's timezone", () => {
    // 09:00 Madrid in September is 07:00 UTC.
    expect(nextCronRun("0 9 * * 1", "Europe/Madrid", from)?.toISOString()).toBe("2026-09-14T07:00:00.000Z");
    // A half-hour zone: 09:00 IST is 03:30 UTC.
    expect(nextCronRun("0 9 * * 1", "Asia/Kolkata", from)?.toISOString()).toBe("2026-09-14T03:30:00.000Z");
  });

  it("walks a five-minute cadence from inside the hour", () => {
    expect(nextCronRun("*/5 * * * *", "UTC", from)?.toISOString()).toBe("2026-09-08T12:35:00.000Z");
  });

  it("returns null for a slot that never comes", () => {
    expect(nextCronRun("0 0 31 2 *", "UTC", from)).toBeNull();
  });

  it("falls back to UTC for an unknown timezone", () => {
    expect(isValidTimezone("Mars/Olympus")).toBe(false);
    expect(nextCronRun("0 9 * * 1", "Mars/Olympus", from)?.toISOString()).toBe("2026-09-14T09:00:00.000Z");
  });
});
