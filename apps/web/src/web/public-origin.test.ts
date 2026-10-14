import { afterEach, describe, expect, it, vi } from "vitest";
import { appOrigin, publicOrigin } from "./public-origin";

// What the standalone server sees behind Traefik: its own bind address in
// `req.url`, the public host and scheme in the forwarded headers.
const BIND = "http://0.0.0.0:3000/auth/signout";

describe("publicOrigin", () => {
  it("prefers the forwarded host and scheme over the bind address", () => {
    const req = new Request(BIND, {
      headers: {
        host: "0.0.0.0:3000",
        "x-forwarded-host": "bcontext.example.com",
        "x-forwarded-proto": "https",
      },
    });
    expect(publicOrigin(req)).toBe("https://bcontext.example.com");
  });

  it("takes the first scheme when the proxy chain appends several", () => {
    const req = new Request(BIND, {
      headers: { "x-forwarded-host": "bcontext.example.com", "x-forwarded-proto": "https, http" },
    });
    expect(publicOrigin(req)).toBe("https://bcontext.example.com");
  });

  it("falls back to Host and the request scheme without a proxy", () => {
    const req = new Request("http://localhost:3000/auth/signout", {
      headers: { host: "localhost:3000" },
    });
    expect(publicOrigin(req)).toBe("http://localhost:3000");
  });

  it("falls back to the request origin when there is no Host at all", () => {
    expect(publicOrigin(new Request("http://localhost:3000/auth/signout"))).toBe(
      "http://localhost:3000",
    );
  });
});

describe("appOrigin", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("prefers the configured NEXT_PUBLIC_APP_URL, without a trailing slash", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://bcontext.example.com/");
    const headers = new Headers({ host: "0.0.0.0:3000" });
    expect(appOrigin(headers)).toBe("https://bcontext.example.com");
  });

  it("falls back to the forwarded host and first scheme", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "");
    const headers = new Headers({
      host: "0.0.0.0:3000",
      "x-forwarded-host": "bcontext.example.com",
      "x-forwarded-proto": "https, http",
    });
    expect(appOrigin(headers)).toBe("https://bcontext.example.com");
  });

  it("falls back to Host over plain http without a proxy", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "");
    expect(appOrigin(new Headers({ host: "localhost:3000" }))).toBe("http://localhost:3000");
  });
});
