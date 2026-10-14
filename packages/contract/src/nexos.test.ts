import { describe, expect, it } from "vitest";
import {
  NEXO_TEMPLATES,
  NEXO_TEMPLATE_KEYS,
  CreateNexoBodySchema,
  NexoHeartbeatSchema,
  NexoInboxActionBodySchema,
  NexoQuestionnaireSchema,
  autonomyFromCanDo,
  hasNexoPromptSections,
  nexoLanguageName,
  nexoSlug,
  renderNexoPrompt,
} from "./nexos.js";

describe("nexoSlug", () => {
  it("is lowercase ascii, bounded and never empty", () => {
    expect(nexoSlug("Soporte Técnico")).toBe("soporte-tecnico");
    expect(nexoSlug("  RRHH & Personas!! ")).toBe("rrhh-personas");
    expect(nexoSlug("¿?")).toBe("nexo");
    expect(nexoSlug("a".repeat(100)).length).toBe(48);
    expect(nexoSlug(`${"a".repeat(47)} b`)).toBe("a".repeat(47));
  });
});

describe("templates", () => {
  it("covers every key with a valid questionnaire prefill", () => {
    expect(NEXO_TEMPLATES.map((t) => t.key)).toEqual([...NEXO_TEMPLATE_KEYS]);
    for (const t of NEXO_TEMPLATES.filter((t) => t.key !== "custom")) {
      expect(NexoQuestionnaireSchema.safeParse(t.questionnaire).success).toBe(true);
      expect(hasNexoPromptSections(renderNexoPrompt(t.questionnaire))).toBe(true);
    }
    expect(NEXO_TEMPLATES.find((t) => t.key === "support")!.suggested_integrations).toContain("slack");
  });
});

describe("helpers", () => {
  it("derives autonomy from what it may do alone", () => {
    expect(autonomyFromCanDo(["read"])).toBe("observe");
    expect(autonomyFromCanDo(["read", "draft_replies"])).toBe("draft");
    expect(autonomyFromCanDo(["reply", "draft_replies"])).toBe("act");
  });

  it("needs text to edit an inbox item", () => {
    expect(NexoInboxActionBodySchema.safeParse({ action: "edit" }).success).toBe(false);
    expect(NexoInboxActionBodySchema.safeParse({ action: "edit", text: "hola" }).success).toBe(true);
    expect(NexoInboxActionBodySchema.safeParse({ action: "approve" }).success).toBe(true);
  });

  it("detects missing or reordered sections", () => {
    expect(hasNexoPromptSections("## Identidad\n## Tono")).toBe(false);
  });
});

describe("nexoLanguageName", () => {
  it("maps codes to names and keeps names as written", () => {
    expect(nexoLanguageName("es")).toBe("español");
    expect(nexoLanguageName("EN")).toBe("English");
    expect(nexoLanguageName("pt-BR")).toBe("português");
    expect(nexoLanguageName("eu")).toBe("euskara");
    expect(nexoLanguageName("español")).toBe("español");
    expect(nexoLanguageName("English")).toBe("English");
    expect(nexoLanguageName("xx")).toBe("xx");
    expect(nexoLanguageName("  ")).toBe("español");
  });

  it("is what the deterministic prompt says", () => {
    const md = renderNexoPrompt({ name: "Soporte", mission: "Atender clientes.", language: "en" });
    expect(md).toContain("respondes en English.");
    expect(md).not.toContain("respondes en en.");
  });
});

describe("heartbeat timezone", () => {
  const base = { template: "custom", questionnaire: { name: "A", mission: "B" } };
  it("accepts partial overrides with a known IANA zone", () => {
    const body = CreateNexoBodySchema.parse({ ...base, heartbeat: { enabled: false, active_hours: { tz: "Europe/Madrid" } } });
    expect(body.heartbeat).toEqual({ enabled: false, active_hours: { tz: "Europe/Madrid" } });
  });

  it("refuses unknown zones and unknown keys", () => {
    expect(CreateNexoBodySchema.safeParse({ ...base, heartbeat: { active_hours: { tz: "Mars/Olympus" } } }).success).toBe(false);
    expect(CreateNexoBodySchema.safeParse({ ...base, heartbeat: { checklist_md: "x" } }).success).toBe(false);
    expect(NexoHeartbeatSchema.safeParse({
      enabled: true, every_minutes: 60, active_hours: { start: "09:00", end: "19:00", tz: "Nowhere/City" }, checklist_md: "",
    }).success).toBe(false);
  });
});
