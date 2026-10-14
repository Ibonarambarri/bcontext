import { describe, expect, it } from "vitest";
import { titleHint } from "./title-hint";

describe("titleHint", () => {
  it("flags code prefixes and numbering", () => {
    for (const t of [
      "F01 — Worker propio con pg-boss",
      "NEXO-03 — Meetings → decisiones",
      "AI-GW-00: Auditar gateway",
      "P4-05 · Grabar demo",
      "UIX-NEXO — Rediseño de IA",
      "1. Escribir el contrato",
      "Fase 2: subtareas",
      "Step 3 - deploy",
    ]) {
      expect(titleHint(t), t).toMatch(/names, not codes/);
    }
  });

  it("flags dash separators", () => {
    expect(titleHint("Integraciones vía Nango — catálogo único")).toMatch(/dash separators/);
  });

  it("accepts plain names, including ones with acronyms, colons and hyphens inside words", () => {
    for (const t of [
      "Worker propio con pg-boss",
      "Realtime propio: fuera Supabase Realtime, vuelve la presencia",
      "NEXO: construir la inteligencia de la memoria viva",
      "El bot de Slack necesita su propio principal",
      "GitHub end-to-end en un repositorio de prueba",
      "Backups de supabase-db, rotación de secretos y baja de Supabase cloud",
      "API v2",
    ]) {
      expect(titleHint(t), t).toBeNull();
    }
  });
});
