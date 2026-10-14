import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { nexoPath, viewSlugFromPathname } from "@/lib/view-shell";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
const ws = { org: "acme", slug: "core" };

describe("Nexo's place in the app", () => {
  it("lives in Nexos, right below Dashboard", () => {
    const sidebar = read("../sidebar.tsx");
    const dashboard = sidebar.indexOf(
      "<SidebarPrimitive.MenuLabel>Dashboard</SidebarPrimitive.MenuLabel>",
    );
    const nexos = sidebar.indexOf("<SidebarPrimitive.MenuLabel>Nexos</SidebarPrimitive.MenuLabel>");
    const knowledge = sidebar.indexOf(
      "<SidebarPrimitive.GroupLabel>Knowledge</SidebarPrimitive.GroupLabel>",
    );
    expect(dashboard).toBeGreaterThan(-1);
    expect(dashboard).toBeLessThan(nexos);
    expect(nexos).toBeLessThan(knowledge);
  });

  it("is the general Nexo's chat, under Nexos rather than a `v/` view", () => {
    expect(nexoPath(ws)).toBe("/w/acme/core/nexos/general");
    expect(nexoPath(ws, "c-1")).toBe("/w/acme/core/nexos/general?c=c-1");
    // Without this the sidebar would keep the previous view lit and the header
    // would show its title while you are talking to a Nexo.
    expect(viewSlugFromPathname("/w/acme/core/nexos/general", ws)).toBe("nexos");
    expect(viewSlugFromPathname("/w/acme/core/nexos", ws)).toBe("nexos");
    // The old address redirects, keeping the conversation.
    const legacy = read("../../app/w/[org]/[ws]/nexo/page.tsx");
    expect(legacy).toContain("redirect(nexoPath(");
  });

  it("reuses one session hook for the general Nexo and every specialist", () => {
    expect(read("./nexo-provider.tsx")).toContain('chatUrl: "/api/nexo"');
    const scope = read("../nexos/nexo-scope.tsx");
    expect(scope).toContain("useNexoSession(");
    expect(scope).toContain("nexoChatUrls(");
    expect(scope).toContain("sendToWidget: null");
  });

  it("keeps the panel out of the shell's synchronous chunk", () => {
    const shell = read("../workspace-shell.tsx");
    expect(shell).toContain('dynamic(() => import("./nexo/nexo-launcher")');
    const launcher = read("./nexo-launcher.tsx");
    expect(launcher).toContain('dynamic(() => import("./nexo-panel")');
    // The provider is synchronous on purpose (it holds the session), so it
    // must not reach for the chat rendering stack.
    expect(read("./nexo-provider.tsx")).not.toContain("@/components/ui/chat");
    expect(read("./nexo-session.ts")).not.toContain("@/components/ui/chat");
  });

  it("makes the floating panels step aside instead of being covered", () => {
    // The window itself lives in one module; both sizes offset by Nexo's
    // width, and "full" means all of what is left.
    const panel = read("../floating-panel.tsx");
    expect(panel).toContain("right-[calc(var(--nexo-w,0px)+0.75rem)]");
    expect(panel).toContain("w-[min(calc(50%-18px),calc(100%-var(--nexo-w,0px)-1.5rem))]");
    expect(read("../workspace-shell.tsx")).toContain('"--nexo-w"');
    // The node panel and the conflict panel are that same window, not two
    // lookalikes: a HeroUI Drawer here would drift again.
    expect(read("../node-floating-panel.tsx")).toContain('from "./floating-panel"');
    const conflict = read("../conflicts/conflict-panel.tsx");
    expect(conflict).toContain('from "@/components/floating-panel"');
    expect(conflict).not.toContain("Drawer");
  });

  it("is built on the chat kit rather than around it", () => {
    const conversation = read("./nexo-conversation.tsx");
    // The kit owns stick-to-bottom, the empty state, the citations and the
    // wait — hand-rolling any of them is how the old chat drifted.
    expect(conversation).toContain("ChatConversation.ScrollAnchor");
    expect(conversation).toContain("PromptSuggestion");
    expect(conversation).toContain("ChatSources");
    expect(conversation).toContain("ChatLoader");
    expect(read("./nexo-history.tsx")).toContain("ChatListView");
  });

  it("takes its colour from the workspace accent, never a hardcoded hue", () => {
    const avatar = read("./nexo-avatar.tsx");
    expect(avatar).toContain("var(--accent)");
    expect(avatar).toContain("var(--accent-ink)");
    expect(avatar).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  it("wears the workspace gradient where the face is a logo", () => {
    // The launcher is 44px and reads as the product's mark, so it takes the
    // same two colours as the workspace tile in the top-left corner. The eyes
    // go white there, as they do on every one of the six presets — the flat
    // accent keeps `--accent-ink`, which is the theme-aware choice.
    const avatar = read("./nexo-avatar.tsx");
    expect(avatar).toContain("linearGradient");
    expect(avatar).toContain('gradient ? "white" : "var(--accent-ink)"');
    expect(read("./nexo-launcher.tsx")).toContain("gradientFor");
  });

  it("names Nexos in the sidebar with a team of faces, the general Nexo in front", () => {
    // The front face is the general Nexo's accent blob; two specialists peek
    // out behind it. Inline SVG: the sidebar is in the shell's first paint.
    const mark = read("../nexos/nexos-mark.tsx");
    expect(mark).toContain('fill="var(--accent)"');
    expect(mark.match(/<circle cx="[\d.]+" cy="13"/g)).toHaveLength(2);
    expect(mark).not.toContain("@blobatar");
    expect(read("../sidebar.tsx")).toContain("<NexosMark />");
  });

  it("left no trace of the flag-gated chat it replaces", () => {
    const shell = read("../workspace-shell.tsx");
    expect(shell).not.toContain("CHAT_UI_ENABLED");
    expect(shell).not.toContain("ChatPanel");
    // The selection floater now carries the node id, not just the text.
    expect(read("../editor.tsx")).toContain("bcontext:nexo-selection");
  });
});
