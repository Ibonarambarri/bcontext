import { afterEach, describe, expect, it } from "vitest";
import { isAdminEmail } from "./access";

const ORIGINAL = process.env.ADMIN_EMAILS;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.ADMIN_EMAILS;
  else process.env.ADMIN_EMAILS = ORIGINAL;
});

describe("isAdminEmail", () => {
  it("fails closed without ADMIN_EMAILS: nobody is an admin", () => {
    delete process.env.ADMIN_EMAILS;
    expect(isAdminEmail("founder@example.com")).toBe(false);
    expect(isAdminEmail("root@example.com")).toBe(false);
  });

  it("fails closed when ADMIN_EMAILS is blank or only separators", () => {
    process.env.ADMIN_EMAILS = " , ,";
    expect(isAdminEmail("root@example.com")).toBe(false);
    expect(isAdminEmail("")).toBe(false);
  });

  it("matches the allowlist case-insensitively and ignores spaces", () => {
    process.env.ADMIN_EMAILS = " Root@Example.com , ops@example.com";
    expect(isAdminEmail("root@example.com")).toBe(true);
    expect(isAdminEmail("OPS@example.com")).toBe(true);
    expect(isAdminEmail("someone@example.com")).toBe(false);
    expect(isAdminEmail(null)).toBe(false);
  });
});
