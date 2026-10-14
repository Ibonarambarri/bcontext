import { describe, expect, it } from "vitest";
import { INTEGRATION_CATEGORIES } from "@bcontext-dev/contract/connectors/catalog";
import { INTEGRATION_CATALOG, catalogEntry, isInstallable, isNangoBacked, listCatalog } from "./catalog";
import { NANGO_ADAPTERS } from "./nango/adapters";

describe("integration catalog", () => {
  it("has unique keys and unique popularity ranks", () => {
    const keys = INTEGRATION_CATALOG.map((e) => e.key);
    expect(new Set(keys).size).toBe(keys.length);
    const ranks = INTEGRATION_CATALOG.map((e) => e.popularity);
    expect(new Set(ranks).size).toBe(ranks.length);
  });

  it("only uses categories the contract knows", () => {
    for (const entry of INTEGRATION_CATALOG) {
      expect(INTEGRATION_CATEGORIES).toContain(entry.category);
    }
  });

  it("lists most popular first and filters by category / query", () => {
    const all = listCatalog();
    expect(all[0]?.key).toBe("slack");
    expect(all[1]?.key).toBe("github");
    expect(listCatalog({ category: "support" }).every((e) => e.category === "support")).toBe(true);
    expect(listCatalog({ query: "jira" }).map((e) => e.key)).toEqual(["jira"]);
  });

  it("every live Nango entry has an adapter with the same id and provider", () => {
    const live = INTEGRATION_CATALOG.filter((e) => e.via === "nango" && e.status === "available");
    expect(live.length).toBeGreaterThanOrEqual(4);
    for (const entry of live) {
      const adapter = NANGO_ADAPTERS.find((a) => a.id === entry.key);
      expect(adapter, entry.key).toBeDefined();
      expect(adapter?.provider).toBe(entry.nango_provider);
    }
  });

  it("gates installs on availability", () => {
    expect(isInstallable("jira")).toBe(true);
    // Every catalog entry may be live at some point; only assert the gate
    // on a coming-soon entry while one exists.
    const comingSoon = INTEGRATION_CATALOG.find((e) => e.status === "coming_soon");
    if (comingSoon) expect(isInstallable(comingSoon.key)).toBe(false);
    expect(isInstallable("nope")).toBe(false);
    expect(isNangoBacked("jira")).toBe(true);
    expect(isNangoBacked("slack")).toBe(false);
    expect(catalogEntry("meeting-bot")?.via).toBe("native");
  });
});
