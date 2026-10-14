import { describe, expect, test } from "vitest";
import {
  ERROR_BATCH_MAX,
  ERROR_LEVELS,
  ERROR_MESSAGE_MAX,
  ERROR_SERVICES,
  ErrorReportBatchSchema,
  ErrorReportSchema,
} from "./errors.js";

const MINIMAL = { service: "api", operation: "rest:POST /api/nodes", message: "boom" };

describe("ErrorReportSchema", () => {
  // The whole value of this pipeline is that instrumenting a new place costs
  // one line. A schema that demands nine fields is one people work around.
  test("three fields are enough, and level defaults to error", () => {
    const parsed = ErrorReportSchema.parse(MINIMAL);
    expect(parsed.level).toBe("error");
    expect(parsed.operation).toBe("rest:POST /api/nodes");
  });

  test("accepts every service and every level", () => {
    for (const service of ERROR_SERVICES) {
      expect(() => ErrorReportSchema.parse({ ...MINIMAL, service })).not.toThrow();
    }
    for (const level of ERROR_LEVELS) {
      expect(() => ErrorReportSchema.parse({ ...MINIMAL, level })).not.toThrow();
    }
  });

  test("rejects a service nobody defined", () => {
    expect(() => ErrorReportSchema.parse({ ...MINIMAL, service: "cli" })).toThrow();
  });

  test("rejects an empty operation — an error with no site is unactionable", () => {
    expect(() => ErrorReportSchema.parse({ ...MINIMAL, operation: "  " })).toThrow();
  });

  test("refuses a message past the column's ceiling", () => {
    const long = { ...MINIMAL, message: "x".repeat(ERROR_MESSAGE_MAX + 1) };
    expect(() => ErrorReportSchema.parse(long)).toThrow();
  });

  test("ids must be ids: a token id is free text, a user id is a uuid", () => {
    expect(() => ErrorReportSchema.parse({ ...MINIMAL, user_id: "nope" })).toThrow();
    expect(() =>
      ErrorReportSchema.parse({ ...MINIMAL, token_id: "tok_abc", user_id: crypto.randomUUID() }),
    ).not.toThrow();
  });

  test("occurred_at has to carry its offset", () => {
    expect(() => ErrorReportSchema.parse({ ...MINIMAL, occurred_at: "2026-09-07" })).toThrow();
    expect(() =>
      ErrorReportSchema.parse({ ...MINIMAL, occurred_at: "2026-09-07T10:00:00.000Z" }),
    ).not.toThrow();
  });
});

describe("ErrorReportBatchSchema", () => {
  test("takes a batch up to the cap and refuses one past it", () => {
    const at = Array.from({ length: ERROR_BATCH_MAX }, () => MINIMAL);
    expect(() => ErrorReportBatchSchema.parse({ events: at })).not.toThrow();
    expect(() => ErrorReportBatchSchema.parse({ events: [...at, MINIMAL] })).toThrow();
    expect(() => ErrorReportBatchSchema.parse({ events: [] })).toThrow();
  });
});
