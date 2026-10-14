import { afterEach, describe, expect, it, vi } from "vitest";
import { appBaseUrl, assertAppUrlConfigured, inviteUrl } from "./app-url";

afterEach(() => {
  vi.unstubAllEnvs();
});

function clearAppUrl() {
  vi.stubEnv("APP_URL", undefined as unknown as string);
  vi.stubEnv("NEXT_PUBLIC_APP_URL", undefined as unknown as string);
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", undefined as unknown as string);
}

describe("appBaseUrl", () => {
  it("uses APP_URL without its trailing slash", () => {
    vi.stubEnv("APP_URL", "https://bx.example.com/");
    expect(appBaseUrl()).toBe("https://bx.example.com");
    expect(inviteUrl("tok")).toBe("https://bx.example.com/invite/tok");
  });

  it("falls back to the local web outside production", () => {
    clearAppUrl();
    vi.stubEnv("NODE_ENV", "test");
    expect(appBaseUrl()).toBe("http://localhost:3000");
  });

  it("has no default in production", () => {
    clearAppUrl();
    vi.stubEnv("NODE_ENV", "production");
    expect(() => appBaseUrl()).toThrow(/APP_URL/);
  });
});

describe("assertAppUrlConfigured", () => {
  it("refuses a production boot without APP_URL", () => {
    expect(() => assertAppUrlConfigured({ NODE_ENV: "production" })).toThrow(/APP_URL is required/);
  });

  it("passes in production with APP_URL and anywhere outside production", () => {
    expect(() => assertAppUrlConfigured({ NODE_ENV: "production", APP_URL: "https://bx.example.com" })).not.toThrow();
    expect(() => assertAppUrlConfigured({ NODE_ENV: "development" })).not.toThrow();
  });
});
