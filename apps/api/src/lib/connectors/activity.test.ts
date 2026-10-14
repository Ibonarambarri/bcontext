import { describe, expect, it } from "vitest";
import { deriveActivity } from "./activity";

const now = new Date("2026-09-08T12:00:00Z");
const install = (id: string, connector: string, extra: Partial<{ status: string; config: Record<string, unknown> }> = {}) => ({
  id,
  connector_id: connector,
  status: extra.status ?? "active",
  last_sync_at: "2026-09-08T09:00:00Z",
  config: extra.config ?? {},
});

describe("deriveActivity", () => {
  it("is idle with nothing going on", () => {
    const [a] = deriveActivity([install("i1", "jira")], [], [], now);
    expect(a?.state).toBe("idle");
    expect(a?.running_jobs).toBe(0);
  });

  it("is fetching while a job runs or is queued and due", () => {
    expect(deriveActivity([install("i1", "jira")], [{ install_id: "i1", status: "running", next_attempt_at: null }], [], now)[0]?.state).toBe("fetching");
    expect(
      deriveActivity([install("i1", "jira")], [{ install_id: "i1", status: "queued", next_attempt_at: "2026-09-08T11:59:00Z" }], [], now)[0]?.state,
    ).toBe("fetching");
    expect(
      deriveActivity([install("i1", "jira")], [{ install_id: "i1", status: "queued", next_attempt_at: "2026-09-08T12:30:00Z" }], [], now)[0]?.state,
    ).toBe("idle");
  });

  it("is processing when NEXO just produced candidates or the job is extracting", () => {
    expect(
      deriveActivity([install("i1", "jira")], [], [{ source: "jira", created_at: "2026-09-08T11:59:30Z" }], now)[0]?.state,
    ).toBe("processing");
    expect(
      deriveActivity([install("i1", "jira")], [{ install_id: "i1", status: "running", next_attempt_at: null, payload: { phase: "extract" } }], [], now)[0]?.state,
    ).toBe("processing");
    expect(deriveActivity([install("i1", "jira")], [], [{ source: "jira", created_at: "2026-09-08T09:00:00Z" }], now)[0]?.candidates_today).toBe(1);
  });

  it("reports errors, next run and today's signals from the last run stats", () => {
    const [a] = deriveActivity(
      [
        install("i1", "jira", {
          status: "errored",
          config: { next_run_at: "2026-09-09T07:00:00Z", last_run_stats: { at: "2026-09-08T07:00:00Z", signals: 12 } },
        }),
      ],
      [],
      [],
      now,
    );
    expect(a?.state).toBe("error");
    expect(a?.next_run_at).toBe("2026-09-09T07:00:00Z");
    expect(a?.signals_today).toBe(12);
  });
});
