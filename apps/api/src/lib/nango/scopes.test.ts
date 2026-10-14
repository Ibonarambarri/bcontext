import { describe, expect, it } from "vitest";
import {
  consoleUrlFor,
  defaultScopesFor,
  nangoCallbackUrl,
  nangoCredentialTypeFor,
  oauthAuthModeFor,
  oauthSetupFor,
  scopesForNango,
} from "./scopes";

describe("Nango OAuth scopes and setup facts", () => {
  it("splits the comma-separated defaults and joins them back for Nango", () => {
    expect(defaultScopesFor("google-drive")).toEqual(["https://www.googleapis.com/auth/drive.readonly"]);
    expect(defaultScopesFor("hubspot")).toHaveLength(3);
    expect(defaultScopesFor("intercom")).toEqual([]);
    expect(defaultScopesFor("nope")).toEqual([]);
    expect(scopesForNango("hubspot")).toBe("crm.objects.deals.read,crm.objects.contacts.read,crm.objects.companies.read");
    expect(scopesForNango("intercom")).toBeUndefined();
    expect(scopesForNango("hubspot", ["a", "b"])).toBe("a,b");
    expect(scopesForNango("hubspot", [])).toBe("crm.objects.deals.read,crm.objects.contacts.read,crm.objects.companies.read");
  });

  it("knows the auth mode Nango wants per provider", () => {
    expect(oauthAuthModeFor("trello")).toBe("oauth1");
    expect(oauthAuthModeFor("personio")).toBe("oauth2_cc");
    expect(oauthAuthModeFor("asana")).toBe("oauth2");
    expect(nangoCredentialTypeFor("oauth1")).toBe("OAUTH1");
    expect(nangoCredentialTypeFor("oauth2_cc")).toBe("OAUTH2_CC");
    expect(nangoCredentialTypeFor("oauth2")).toBe("OAUTH2");
  });

  it("derives the callback from the public Nango URL", () => {
    expect(nangoCallbackUrl({})).toBeNull();
    expect(nangoCallbackUrl({ NANGO_SERVER_URL: "http://nango-server:3003/" })).toBe("http://nango-server:3003/oauth/callback");
    expect(nangoCallbackUrl({ NANGO_SERVER_URL: "http://nango-server:3003", NANGO_PUBLIC_URL: "https://nango.example.com" })).toBe(
      "https://nango.example.com/oauth/callback",
    );
  });

  it("points at the developer console for the big families and nothing for the rest", () => {
    expect(consoleUrlFor("google-mail")).toBe("https://console.cloud.google.com/apis/credentials");
    expect(consoleUrlFor("youtube")).toBe("https://console.cloud.google.com/apis/credentials");
    expect(consoleUrlFor("outlook")).toBe("https://entra.microsoft.com");
    expect(consoleUrlFor("microsoft-planner")).toBe("https://entra.microsoft.com");
    expect(consoleUrlFor("jira")).toBe("https://developer.atlassian.com/console/myapps/");
    expect(consoleUrlFor("slack")).toBe("https://api.slack.com/apps");
    expect(consoleUrlFor("salesforce-sandbox")).toBe("https://login.salesforce.com");
    expect(consoleUrlFor("calendly")).toBeNull();
  });

  it("assembles the oauth_setup block for the catalog", () => {
    expect(oauthSetupFor("hubspot", {})).toBeNull();
    const env = { NANGO_PUBLIC_URL: "https://nango.example.com" };
    expect(oauthSetupFor("hubspot", env)).toEqual({
      callback_url: "https://nango.example.com/oauth/callback",
      scopes: ["crm.objects.deals.read", "crm.objects.contacts.read", "crm.objects.companies.read"],
      console_url: "https://developers.hubspot.com",
      auth_mode: "oauth2",
    });
    expect(oauthSetupFor("trello", env)?.auth_mode).toBe("oauth1");
  });
});
