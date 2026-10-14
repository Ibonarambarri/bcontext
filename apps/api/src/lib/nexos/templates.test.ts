/**
 * Row defaults for a new specialist: the heartbeat follows the routine and
 * the request's overrides, escalations reach the creator.
 */
import { describe, expect, it } from "vitest";
import { NexoQuestionnaireSchema } from "@bcontext-dev/contract/nexos";
import { defaultsFor } from "./templates";

const q = (routine = "") => NexoQuestionnaireSchema.parse({ name: "Soporte", mission: "Atender clientes.", routine });
const USER = "7d3f1a52-1c2b-4d5e-8f90-123456789abc";

describe("defaultsFor", () => {
  it("keeps the heartbeat off without a routine, even with a template checklist", () => {
    const d = defaultsFor("support", q());
    expect(d.heartbeat.enabled).toBe(false);
    expect(d.heartbeat.checklist_md).toContain("Hilos de clientes");
  });

  it("turns it on with the routine as checklist, hourly 09:00–19:00 in the given tz", () => {
    const d = defaultsFor("custom", q("Revisar pendientes"), { heartbeat: { active_hours: { tz: "America/Bogota" } } });
    expect(d.heartbeat).toEqual({
      enabled: true,
      every_minutes: 60,
      active_hours: { start: "09:00", end: "19:00", tz: "America/Bogota" },
      checklist_md: "Revisar pendientes",
    });
    expect(defaultsFor("custom", q("x")).heartbeat.active_hours.tz).toBe("UTC");
  });

  it("lets an explicit override win", () => {
    const d = defaultsFor("custom", q("x"), { heartbeat: { enabled: false, every_minutes: 120, active_hours: { start: "08:00" } } });
    expect(d.heartbeat).toMatchObject({ enabled: false, every_minutes: 120, active_hours: { start: "08:00", end: "19:00" } });
  });

  it("notifies the creator in the inbox, or nobody without one", () => {
    expect(defaultsFor("custom", q(), { notifyUserId: USER }).escalation).toEqual({ notify_user_ids: [USER], via: ["inbox"] });
    expect(defaultsFor("custom", q(), { notifyUserId: null }).escalation).toEqual({ notify_user_ids: [], via: ["inbox"] });
  });
});
