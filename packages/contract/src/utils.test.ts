import { describe, it, expect } from "vitest";
import { slugify, formatRelative, cn } from "./utils.js";

describe("slugify", () => {
  it("lowercases and hyphenates", () => {
    expect(slugify("Hello World")).toBe("hello-world");
  });

  it("collapses repeated separators", () => {
    expect(slugify("  multi   space ")).toBe("multi-space");
  });

  it("strips punctuation outside [a-z0-9-]", () => {
    expect(slugify("Auth & Tokens!")).toBe("auth-tokens");
  });

  it("normalizes accented characters", () => {
    expect(slugify("Café résumé")).toBe("cafe-resume");
  });

  it("caps at 80 chars", () => {
    const long = "a".repeat(120);
    expect(slugify(long).length).toBe(80);
  });
});

describe("formatRelative", () => {
  it("returns 'just now' for sub-minute timestamps", () => {
    expect(formatRelative(new Date())).toBe("just now");
  });

  it("returns minutes-ago for 5-minute-old timestamps", () => {
    const past = new Date(Date.now() - 5 * 60_000);
    expect(formatRelative(past)).toBe("5m ago");
  });
});

describe("cn", () => {
  it("merges tailwind classes deduping conflicts", () => {
    expect(cn("p-2", "p-4")).toBe("p-4");
  });

  it("drops falsy values", () => {
    expect(cn("a", false, undefined, null, "b")).toBe("a b");
  });
});
