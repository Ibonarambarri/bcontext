import { describe, expect, it } from "vitest";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { discoverProviderLogo, isSafeLogoBytes, providerBrandHosts } from "./provider-brand";

const PNG_PREFIX = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ICO_PREFIX = new Uint8Array([0x00, 0x00, 0x01, 0x00, 0x01, 0x00]);

describe("provider logo discovery", () => {
  it("uses a same-host icon declared by the provider homepage", async () => {
    const requested: string[] = [];
    const fetchFn: FetchLike = async (input) => {
      const url = String(input);
      requested.push(url);
      if (url === "https://mcp.example.com/") {
        return new Response('<link rel="apple-touch-icon" href="/brand.png">', {
          headers: { "content-type": "text/html" },
        });
      }
      return new Response(PNG_PREFIX, { headers: { "content-type": "image/png" } });
    };

    await expect(discoverProviderLogo(
      new URL("https://mcp.example.com/mcp"),
      undefined,
      fetchFn,
    )).resolves.toEqual({
      url: "https://mcp.example.com/brand.png",
      endpointHost: "mcp.example.com",
      source: "endpoint_homepage",
      identityVerified: false,
    });
    expect(requested).toEqual([
      "https://mcp.example.com/",
      "https://mcp.example.com/brand.png",
    ]);
  });

  it("prefers a safe same-host icon declared by MCP initialize", async () => {
    const requested: string[] = [];
    const fetchFn: FetchLike = async (input) => {
      requested.push(String(input));
      return new Response(PNG_PREFIX, { headers: { "content-type": "image/png" } });
    };

    await expect(discoverProviderLogo(
      new URL("https://mcp.example.com/mcp"),
      undefined,
      fetchFn,
      ["https://mcp.example.com/assets/provider.png"],
    )).resolves.toEqual({
      url: "https://mcp.example.com/assets/provider.png",
      endpointHost: "mcp.example.com",
      source: "mcp_declared",
      identityVerified: false,
    });
    expect(requested).toEqual([
      "https://mcp.example.com/",
      "https://mcp.example.com/assets/provider.png",
    ]);
  });

  it("ignores cross-host icons declared by MCP initialize", async () => {
    const requested: string[] = [];
    const fetchFn: FetchLike = async (input) => {
      requested.push(String(input));
      const url = String(input);
      if (url.endsWith("/")) return new Response("missing", { status: 404 });
      return new Response(ICO_PREFIX, { headers: { "content-type": "image/x-icon" } });
    };

    await expect(discoverProviderLogo(
      new URL("https://mcp.example.com/mcp"),
      undefined,
      fetchFn,
      ["https://cdn.example.net/provider.png"],
    )).resolves.toEqual({
      url: "https://mcp.example.com/favicon.ico",
      endpointHost: "mcp.example.com",
      source: "endpoint_favicon",
      identityVerified: false,
    });
    expect(requested).not.toContain("https://cdn.example.net/provider.png");
  });

  it("ignores cross-host images and falls back to favicon.ico", async () => {
    const fetchFn: FetchLike = async (input) => {
      const url = String(input);
      if (url.endsWith("/")) {
        return new Response('<meta property="og:image" content="https://cdn.example.net/logo.png">', {
          headers: { "content-type": "text/html" },
        });
      }
      return new Response(ICO_PREFIX, { headers: { "content-type": "image/x-icon" } });
    };

    await expect(discoverProviderLogo(
      new URL("https://mcp.example.com/mcp"),
      undefined,
      fetchFn,
    )).resolves.toEqual({
      url: "https://mcp.example.com/favicon.ico",
      endpointHost: "mcp.example.com",
      source: "endpoint_favicon",
      identityVerified: false,
    });
  });

  it("uses the registrable provider homepage when a generic MCP host has no logo", async () => {
    const requested: string[] = [];
    const fetchFn: FetchLike = async (input) => {
      const url = String(input);
      requested.push(url);
      if (url === "https://supabase.com/") {
        return new Response('<link rel="icon" href="/favicon/favicon.ico">', {
          headers: { "content-type": "text/html" },
        });
      }
      if (url === "https://supabase.com/favicon/favicon.ico") {
        return new Response(ICO_PREFIX, { headers: { "content-type": "image/x-icon" } });
      }
      return new Response("missing", { status: 404, headers: { "content-type": "text/plain" } });
    };
    await expect(discoverProviderLogo(
      new URL("https://mcp.supabase.com/mcp"),
      undefined,
      fetchFn,
    )).resolves.toEqual({
      url: "https://supabase.com/favicon/favicon.ico",
      endpointHost: "mcp.supabase.com",
      source: "provider_homepage",
      identityVerified: false,
    });
    expect(requested).toContain("https://supabase.com/");
  });

  it("keeps the bounded homepage prefix when the response is larger than the HTML budget", async () => {
    const requested: string[] = [];
    const oversizedHomepage = `<link rel="icon" href="/favicon/favicon.ico">${"x".repeat(300_000)}`;
    const fetchFn: FetchLike = async (input) => {
      const url = String(input);
      requested.push(url);
      if (url === "https://supabase.com/") {
        return new Response(oversizedHomepage, {
          headers: { "content-type": "text/html" },
        });
      }
      if (url === "https://supabase.com/favicon/favicon.ico") {
        return new Response(ICO_PREFIX, { headers: { "content-type": "image/x-icon" } });
      }
      return new Response("missing", { status: 404, headers: { "content-type": "text/plain" } });
    };

    await expect(discoverProviderLogo(
      new URL("https://mcp.supabase.com/mcp"),
      undefined,
      fetchFn,
    )).resolves.toEqual({
      url: "https://supabase.com/favicon/favicon.ico",
      endpointHost: "mcp.supabase.com",
      source: "provider_homepage",
      identityVerified: false,
    });
    expect(requested).toContain("https://supabase.com/favicon/favicon.ico");
  });

  it("uses the exact Vercel MCP favicon when it is available", async () => {
    const requested: string[] = [];
    const fetchFn: FetchLike = async (input) => {
      const url = String(input);
      requested.push(url);
      if (url === "https://mcp.vercel.com/favicon.ico") {
        return new Response(ICO_PREFIX, { headers: { "content-type": "image/x-icon" } });
      }
      return new Response("missing", { status: 404, headers: { "content-type": "text/plain" } });
    };
    await expect(discoverProviderLogo(
      new URL("https://mcp.vercel.com/mcp"),
      undefined,
      fetchFn,
    )).resolves.toMatchObject({
      url: "https://mcp.vercel.com/favicon.ico",
      source: "endpoint_favicon",
    });
    expect(requested).toEqual([
      "https://mcp.vercel.com/",
      "https://mcp.vercel.com/favicon.ico",
    ]);
  });

  it("does not collapse private multi-tenant suffixes to their operator domain", () => {
    expect(providerBrandHosts(
      new URL("https://mcp.customer.vercel.app/mcp"),
    )).toEqual(["mcp.customer.vercel.app", "customer.vercel.app"]);
    expect(providerBrandHosts(
      new URL("https://customer.vercel.app/mcp"),
    )).toEqual(["customer.vercel.app"]);
  });

  it("does not widen a branded non-generic subdomain", () => {
    expect(providerBrandHosts(
      new URL("https://tenant.example.com/mcp"),
    )).toEqual(["tenant.example.com"]);
  });

  it("widens only when the complete subdomain prefix is service-only", () => {
    expect(providerBrandHosts(
      new URL("https://api.mcp.acme-tools.io/mcp"),
    )).toEqual(["api.mcp.acme-tools.io", "acme-tools.io"]);
    for (const host of [
      "mcp.customer.example.com",
      "mcp-api.tenant.example.com",
      "legit-mcp.example.com",
    ]) {
      expect(providerBrandHosts(new URL(`https://${host}/mcp`))).toEqual([host]);
    }
  });

  it("does no network work when discovery is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    let requests = 0;
    const fetchFn: FetchLike = async () => {
      requests += 1;
      return new Response("missing", { status: 404 });
    };
    await expect(discoverProviderLogo(
      new URL("https://mcp.example.com/mcp"),
      controller.signal,
      fetchFn,
    )).resolves.toBeNull();
    expect(requests).toBe(0);
  });

  it("caps icon candidates and the total fetch budget", async () => {
    const requested: string[] = [];
    const icons = Array.from({ length: 100 }, (_, index) => (
      `<link rel="icon" href="/icon-${index}.png">`
    )).join("");
    const fetchFn: FetchLike = async (input) => {
      const url = String(input);
      requested.push(url);
      if (url.endsWith("/")) {
        return new Response(icons, { headers: { "content-type": "text/html" } });
      }
      return new Response("missing", { status: 404, headers: { "content-type": "text/plain" } });
    };
    await expect(discoverProviderLogo(
      new URL("https://mcp.example.com/mcp"),
      undefined,
      fetchFn,
    )).resolves.toBeNull();
    expect(requested).not.toContain("https://mcp.example.com/icon-8.png");
    expect(requested.length).toBeLessThanOrEqual(14);
  });

  it("rejects SVG and content that lies about a raster MIME type", () => {
    const svg = new TextEncoder().encode("<svg><script>alert(1)</script></svg>");
    expect(isSafeLogoBytes(svg, "image/svg+xml")).toBe(false);
    expect(isSafeLogoBytes(svg, "image/png")).toBe(false);
    expect(isSafeLogoBytes(PNG_PREFIX, "image/png; charset=binary")).toBe(true);
  });

  it("returns null when the host exposes no usable image", async () => {
    const fetchFn: FetchLike = async () => new Response("missing", {
      status: 404,
      headers: { "content-type": "text/plain" },
    });
    await expect(discoverProviderLogo(
      new URL("https://mcp.example.com/mcp"),
      undefined,
      fetchFn,
    )).resolves.toBeNull();
  });
});
