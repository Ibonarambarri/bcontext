import { describe, expect, it } from "vitest";
import {
  canUseOwnApp,
  filterCatalog,
  formatScopes,
  installOAuthApp,
  NATIVE_CATALOG,
  needsOwnApp,
  oauthCallbackUrl,
  uniqueScopes,
} from "./catalog";
import type { IntegrationCatalogEntry } from "./types";

const soon: IntegrationCatalogEntry = {
  key: "jira",
  name: "Jira",
  category: "project-management",
  popularity: 6,
  via: "nango",
  auth: "basic",
  logo_url: null,
  description: "Issues and sprints.",
  status: "coming_soon",
};

const longTail: IntegrationCatalogEntry = {
  key: "linkhut",
  name: "LinkHut",
  category: "other",
  popularity: 400,
  via: "nango",
  auth: "api_key",
  logo_url: null,
  description: "Bookmarks.",
  status: "available",
};

describe("filterCatalog", () => {
  const entries = [...NATIVE_CATALOG, soon, longTail];

  it("Popular keeps only the top of the ranking, sorted by popularity", () => {
    const out = filterCatalog(entries, "popular", "");
    expect(out.map((e) => e.key)).toEqual(["meeting-bot", "slack", "github", "linear", "notion", "jira"]);
  });

  it("All includes the long tail and puts coming_soon after available", () => {
    const out = filterCatalog(entries, "all", "");
    expect(out.at(-1)?.key).toBe("jira");
    expect(out.some((e) => e.key === "linkhut")).toBe(true);
  });

  it("category tabs filter by category", () => {
    expect(filterCatalog(entries, "dev-tools", "").map((e) => e.key)).toEqual(["github"]);
  });

  it("search matches name, key and description case-insensitively", () => {
    expect(filterCatalog(entries, "all", "BOOKMARK").map((e) => e.key)).toEqual(["linkhut"]);
    expect(filterCatalog(entries, "all", "meeting-bot").map((e) => e.key)).toEqual(["meeting-bot"]);
  });
});

describe("hybrid OAuth helpers", () => {
  const oauthSetup = {
    callback_url: "https://nango.example.com/oauth/callback",
    scopes: ["https://www.googleapis.com/auth/drive.readonly"],
    console_url: "https://console.cloud.google.com/apis/credentials",
    auth_mode: "oauth2" as const,
  };

  it("needsOwnApp is true only for available entries without a shared app", () => {
    expect(needsOwnApp({ status: "available", setup: "needs_oauth_app" })).toBe(true);
    expect(needsOwnApp({ status: "available", setup: "ready" })).toBe(false);
    expect(needsOwnApp({ status: "available" })).toBe(false);
    // coming_soon cards offer no connect path regardless of setup.
    expect(needsOwnApp({ status: "coming_soon", setup: "needs_oauth_app" })).toBe(false);
  });

  it("canUseOwnApp needs a live Nango OAuth entry", () => {
    expect(canUseOwnApp({ status: "available", via: "nango", oauth_setup: oauthSetup })).toBe(true);
    expect(canUseOwnApp({ status: "available", via: "nango" })).toBe(false);
    expect(canUseOwnApp({ status: "available", via: "native", oauth_setup: oauthSetup })).toBe(false);
    expect(canUseOwnApp({ status: "coming_soon", via: "nango", oauth_setup: oauthSetup })).toBe(false);
  });

  it("installOAuthApp treats installs from before the hybrid model as shared", () => {
    expect(installOAuthApp(undefined)).toBe("shared");
    expect(installOAuthApp({})).toBe("shared");
    expect(installOAuthApp({ oauth_app: "shared" })).toBe("shared");
    expect(installOAuthApp({ oauth_app: "own" })).toBe("own");
  });

  it("oauthCallbackUrl prefers the setup's URL and has no default host", () => {
    expect(oauthCallbackUrl(oauthSetup)).toBe("https://nango.example.com/oauth/callback");
    // NANGO_PUBLIC_HOST is unset in tests: no URL is invented for it.
    expect(oauthCallbackUrl({ callback_url: "  " })).toBe("");
    expect(oauthCallbackUrl(null)).toBe("");
  });

  it("scopes are split, deduped and formatted one per line", () => {
    expect(uniqueScopes(["a b", "b,c", " c ", ""])).toEqual(["a", "b", "c"]);
    expect(uniqueScopes(undefined)).toEqual([]);
    expect(formatScopes(["read", "read write"])).toBe("read\nwrite");
  });
});
