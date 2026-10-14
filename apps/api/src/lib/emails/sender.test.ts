import { afterEach, describe, expect, it, vi } from "vitest";
import { emailFooter, emailFrom, instanceName } from "./sender";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("email sender", () => {
  it("has no default from address", () => {
    vi.stubEnv("EMAIL_FROM", "");
    expect(emailFrom()).toBeNull();
    vi.stubEnv("EMAIL_FROM", "Acme <no-reply@acme.test>");
    expect(emailFrom()).toBe("Acme <no-reply@acme.test>");
  });

  it("signs with the instance name and the web app host", () => {
    vi.stubEnv("INSTANCE_NAME", "");
    vi.stubEnv("APP_URL", "https://context.acme.test/");
    expect(instanceName()).toBe("Bcontext");
    expect(emailFooter()).toBe("Bcontext · context.acme.test");
    vi.stubEnv("INSTANCE_NAME", "Acme Context");
    expect(emailFooter()).toBe("Acme Context · context.acme.test");
  });
});
