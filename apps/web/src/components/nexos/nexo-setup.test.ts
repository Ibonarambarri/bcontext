/**
 * A Nexo's page after the Setup tab gathered Integrations, Tools and
 * Settings: the tab map (and the old links that must still land), the one
 * way a setting switch is built, and the way back from an OAuth hop.
 */
import { readdirSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { nexoDetailPath, NEXO_TABS } from "@/lib/view-shell";
import { resolveNexoTab } from "@/lib/nexos/tabs";
import { rememberConnectReturn, takeConnectReturn } from "@/lib/nexos/connect-return";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
const ws = { org: "acme", slug: "core" };

describe("a Nexo's tabs", () => {
  it("are Chat, Inbox, Activity and Setup", () => {
    expect([...NEXO_TABS]).toEqual(["chat", "inbox", "activity", "setup"]);
  });

  it("send the retired tabs to their Setup section, and anything unknown to the chat", () => {
    expect(resolveNexoTab("integrations", null)).toEqual({ tab: "setup", section: "sources" });
    expect(resolveNexoTab("tools", null)).toEqual({ tab: "setup", section: "abilities" });
    expect(resolveNexoTab("settings", null)).toEqual({ tab: "setup", section: "behaviour" });
    expect(resolveNexoTab("setup", "budget")).toEqual({ tab: "setup", section: "budget" });
    expect(resolveNexoTab("inbox", "budget")).toEqual({ tab: "inbox", section: null });
    expect(resolveNexoTab("nope", null)).toEqual({ tab: "chat", section: null });
    expect(resolveNexoTab("toString", null)).toEqual({ tab: "chat", section: null });
  });

  it("build links to a Setup section", () => {
    expect(nexoDetailPath(ws, "general", { tab: "setup", section: "sources" })).toBe(
      "/w/acme/core/nexos/general?tab=setup&section=sources",
    );
    expect(nexoDetailPath(ws, "n1")).toBe("/w/acme/core/nexos/n1");
  });
});

describe("setting switches", () => {
  it("are built one way: the row's words inside the switch's label", () => {
    // The bug this guards: a title and a hint beside a <Switch>, outside its
    // label, read as the control and did nothing when pressed — and a
    // routine switch that only changed a draft behind a Save button.
    const dir = new URL("./", import.meta.url);
    const withSwitch = readdirSync(dir).filter((f) => f.endsWith(".tsx") && read(`./${f}`).includes("<Switch"));
    expect(withSwitch).toEqual(["nexo-fields.tsx"]);
    const fields = read("./nexo-fields.tsx");
    const content = fields.slice(fields.indexOf("<Switch.Content"), fields.indexOf("</Switch.Content>"));
    expect(content).toContain("{title}");
    expect(content).toContain("<Switch.Control");
  });

  it("save on change in Setup — no per-section Save buttons", () => {
    const setup = read("./nexo-setup-tab.tsx");
    expect(setup).not.toContain("SaveButton");
    expect(setup).not.toMatch(/useState<NexoHeartbeat>/);
  });
});

describe("the bubble on a Nexo's page", () => {
  it("is not there: the page has the chat, and the bubble sat on its controls", () => {
    expect(read("../nexo/nexo-launcher.tsx")).toContain("if (/\\/nexos\\/[^/]+/.test(pathname)) return null;");
    // Toasts sit above the bubble whenever it is on the page.
    expect(read("../toast.tsx")).toContain("[body:has([data-nexo-launcher])_&]:bottom-[68px]");
  });
});

describe("coming back from an OAuth hop", () => {
  const store = new Map<string, string>();
  const g = globalThis as { window?: unknown };
  g.window = {
    sessionStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
  };
  afterEach(() => store.clear());

  it("returns once to the Nexo that started it", () => {
    rememberConnectReturn("/w/acme/core/nexos/n1?tab=setup&section=sources&connect=slack");
    expect(takeConnectReturn()).toBe("/w/acme/core/nexos/n1?tab=setup&section=sources&connect=slack");
    expect(takeConnectReturn()).toBeNull();
  });

  it("forgets a hop abandoned long ago, and never leaves the app", () => {
    rememberConnectReturn("/w/acme/core/nexos/n1");
    expect(takeConnectReturn(Date.now() + 60 * 60 * 1000)).toBeNull();
    rememberConnectReturn("https://evil.example/");
    expect(takeConnectReturn()).toBeNull();
  });
});
