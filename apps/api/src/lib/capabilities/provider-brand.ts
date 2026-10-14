/**
 * Logo discovery for an external MCP provider: icons the server declared,
 * then `<link rel=icon>` on the endpoint homepage, then `/favicon.ico`, then
 * the same two on the registrable provider domain when the endpoint host is
 * a generic service subdomain. Used at discovery time and by the
 * `/api/capabilities/provider-logo` proxy, which re-checks content type and
 * magic bytes (`isSafeLogo*`) before serving anything to a browser.
 *
 * Decoration only: a logo never proves who the provider is, and every fetch
 * goes through the pinned egress policy.
 */
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { getDomain } from "tldts";
import { createPinnedFetch } from "./egress";

const MAX_HTML_BYTES = 256_000;
const MAX_DECLARED_ICON_CANDIDATES = 4;
const MAX_HOMEPAGE_ICON_CANDIDATES = 8;
const MAX_LOGO_CANDIDATE_FETCHES = 12;

export type ProviderLogoSource =
  | "mcp_declared"
  | "endpoint_homepage"
  | "endpoint_favicon"
  | "provider_homepage"
  | "provider_favicon";

export interface DiscoveredProviderLogo {
  url: string;
  endpointHost: string;
  source: ProviderLogoSource;
  /** Endpoint-hosted artwork is useful decoration, never identity proof. */
  identityVerified: false;
}

/**
 * Best-effort provider branding discovery. It starts on the exact MCP host,
 * then (only for generic service subdomains such as `mcp.` or `api.`) tries
 * the registrable provider domain from the Public Suffix List. Every request
 * remains HTTPS-only, redirect-free and DNS-pinned. A missing logo must never
 * make an otherwise valid MCP fail.
 */
export async function discoverProviderLogo(
  endpoint: URL,
  signal?: AbortSignal,
  fetchFn?: FetchLike,
  declaredIcons: readonly string[] = [],
): Promise<DiscoveredProviderLogo | null> {
  const origins = providerBrandOrigins(endpoint);
  const endpointOrigin = origins[0]!;
  const fetcher = fetchFn ?? createPinnedFetch(providerBrandHosts(endpoint));
  const declaredCandidates: Array<{ url: URL; source: ProviderLogoSource }> = declaredIcons.slice(0, MAX_DECLARED_ICON_CANDIDATES).flatMap((value) => {
    const candidate = safeSameHostUrl(value, endpointOrigin);
    return candidate ? [{ url: candidate, source: "mcp_declared" as const }] : [];
  });

  const candidateBudget = { remaining: MAX_LOGO_CANDIDATE_FETCHES };
  for (const [index, origin] of origins.entries()) {
    if (signal?.aborted) return null;
    const candidates = index === 0 ? [...declaredCandidates] : [];
    const homepageSource: ProviderLogoSource = index === 0 ? "endpoint_homepage" : "provider_homepage";
    const faviconSource: ProviderLogoSource = index === 0 ? "endpoint_favicon" : "provider_favicon";
    try {
      const root = await fetcher(origin, {
        headers: { accept: "text/html,application/xhtml+xml" },
        signal,
      });
      const contentType = root.headers.get("content-type") ?? "";
      if (root.ok && contentType.includes("text/html")) {
        const html = await readTextLimited(root, MAX_HTML_BYTES);
        for (const href of iconHrefs(html).slice(0, MAX_HOMEPAGE_ICON_CANDIDATES)) {
          const candidate = safeSameHostUrl(href, origin);
          if (candidate) candidates.push({ url: candidate, source: homepageSource });
        }
      } else {
        await root.body?.cancel();
      }
    } catch {
      if (signal?.aborted) return null;
      // The conventional favicon fallback below still has a chance to work.
    }
    candidates.push({ url: new URL("/favicon.ico", origin), source: faviconSource });
    const discovered = await firstUsableCandidate(
      candidates,
      fetcher,
      endpoint,
      signal,
      candidateBudget,
    );
    if (discovered) return discovered;
  }
  return null;
}

async function firstUsableCandidate(
  candidates: Array<{ url: URL; source: ProviderLogoSource }>,
  fetcher: FetchLike,
  endpoint: URL,
  signal?: AbortSignal,
  budget: { remaining: number } = { remaining: MAX_LOGO_CANDIDATE_FETCHES },
): Promise<DiscoveredProviderLogo | null> {
  for (const candidate of dedupeCandidates(candidates)) {
    if (signal?.aborted || budget.remaining <= 0) return null;
    budget.remaining -= 1;
    try {
      const response = await fetcher(candidate.url, {
        headers: { accept: "image/avif,image/webp,image/png,image/jpeg,image/gif,image/x-icon" },
        signal,
      });
      const contentType = response.headers.get("content-type") ?? "";
      const prefix = response.ok && isSafeLogoContentType(contentType)
        ? await readPrefix(response, 16)
        : null;
      if (!prefix) await response.body?.cancel();
      if (prefix && isSafeLogoBytes(prefix, contentType)) {
        return {
          url: candidate.url.toString(),
          endpointHost: normalizeHost(endpoint.hostname),
          source: candidate.source,
          identityVerified: false,
        };
      }
    } catch {
      if (signal?.aborted) return null;
      // Try the next candidate.
    }
  }
  return null;
}

function iconHrefs(html: string): string[] {
  const ranked: Array<{ href: string; rank: number }> = [];
  for (const match of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = match[0];
    const rel = attribute(tag, "rel")?.toLowerCase() ?? "";
    const href = attribute(tag, "href");
    if (!href || !rel.split(/\s+/).some((part) => part === "icon" || part === "shortcut" || part === "apple-touch-icon")) continue;
    ranked.push({ href, rank: rel.includes("apple-touch-icon") ? 0 : 1 });
  }
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = match[0];
    const property = (attribute(tag, "property") ?? attribute(tag, "name") ?? "").toLowerCase();
    const content = attribute(tag, "content");
    if (content && property === "og:image") ranked.push({ href: content, rank: 2 });
  }
  return ranked.sort((a, b) => a.rank - b.rank).map((item) => item.href);
}

function attribute(tag: string, name: string): string | null {
  const pattern = new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i");
  const match = pattern.exec(tag);
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
}

function safeSameHostUrl(value: string, base: URL): URL | null {
  if (value.length > 4096) return null;
  try {
    const url = new URL(value, base);
    return url.protocol === "https:" && normalizeHost(url.hostname) === normalizeHost(base.hostname)
      ? url
      : null;
  } catch {
    return null;
  }
}

function normalizeHost(value: string): string {
  return value.toLowerCase().replace(/\.$/, "");
}

/**
 * Hosts the logo fetch may touch: the endpoint host plus, for generic
 * service subdomains, the registrable domain. Derived from the endpoint
 * alone, on purpose: the connection's `allowed_hosts` govern what the
 * capability may call, and neither list widens the other — a logo on the
 * provider's own site is fetchable even when the allowlist names only the
 * `mcp.` host, and an allowlisted third-party host never becomes a place
 * to look for branding.
 */
export function providerBrandHosts(endpoint: URL): string[] {
  return providerBrandOrigins(endpoint).map((origin) => normalizeHost(origin.hostname));
}

function providerBrandOrigins(endpoint: URL): URL[] {
  const endpointHost = normalizeHost(endpoint.hostname);
  const origins = [new URL("/", endpoint)];
  const registrableDomain = getDomain(endpointHost, { allowPrivateDomains: true });
  if (!registrableDomain || normalizeHost(registrableDomain) === endpointHost) return origins;

  const prefix = endpointHost.slice(0, -(registrableDomain.length + 1));
  const serviceLabels = prefix.split(".").filter(Boolean);
  if (serviceLabels.length === 0 || !serviceLabels.every(isGenericServiceLabel)) return origins;
  origins.push(new URL(`https://${registrableDomain}/`));
  return origins;
}

const GENERIC_SERVICE_TOKENS = new Set([
  "api", "connect", "gateway", "mcp", "remote", "server", "service", "services", "tool", "tools", "www",
]);

function isGenericServiceLabel(label: string): boolean {
  const tokens = label.split(/[-_]/).filter(Boolean);
  return tokens.length > 0 && tokens.every((token) => (
    GENERIC_SERVICE_TOKENS.has(token) || /^v\d+$/.test(token)
  ));
}

/** Raster image types the proxy will serve; SVG is excluded because it can script. */
export function isSafeLogoContentType(value: string): boolean {
  const type = normalizedLogoContentType(value);
  return type === "image/png"
    || type === "image/jpeg"
    || type === "image/webp"
    || type === "image/avif"
    || type === "image/gif"
    || type === "image/x-icon"
    || type === "image/vnd.microsoft.icon";
}

/** Magic-byte check so a mislabelled HTML or SVG body is never served as an image. */
export function isSafeLogoBytes(bytes: Uint8Array, contentType: string): boolean {
  const type = normalizedLogoContentType(contentType);
  if (type === "image/png") {
    return startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  }
  if (type === "image/jpeg") return startsWith(bytes, [0xff, 0xd8, 0xff]);
  if (type === "image/gif") {
    return ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a";
  }
  if (type === "image/webp") {
    return ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP";
  }
  if (type === "image/avif") {
    const brand = ascii(bytes, 8, 4);
    return ascii(bytes, 4, 4) === "ftyp" && (brand === "avif" || brand === "avis");
  }
  if (type === "image/x-icon" || type === "image/vnd.microsoft.icon") {
    return startsWith(bytes, [0x00, 0x00, 0x01, 0x00]);
  }
  return false;
}

export function normalizedLogoContentType(value: string): string {
  return value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function dedupeCandidates(
  candidates: Array<{ url: URL; source: ProviderLogoSource }>,
): Array<{ url: URL; source: ProviderLogoSource }> {
  return [...new Map(candidates.map((candidate) => [candidate.url.toString(), candidate])).values()];
}

async function readTextLimited(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < maxBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    const remaining = maxBytes - size;
    const chunk = value.byteLength > remaining
      ? value.subarray(0, remaining)
      : value;
    chunks.push(chunk);
    size += chunk.byteLength;
    if (value.byteLength > remaining || size === maxBytes) {
      await reader.cancel().catch(() => {});
      break;
    }
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

async function readPrefix(response: Response, maxBytes: number): Promise<Uint8Array | null> {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const prefix = new Uint8Array(maxBytes);
  let size = 0;
  while (size < maxBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    const take = Math.min(value.byteLength, maxBytes - size);
    prefix.set(value.subarray(0, take), size);
    size += take;
  }
  await reader.cancel().catch(() => {});
  return size > 0 ? prefix.subarray(0, size) : null;
}

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  return signature.every((value, index) => bytes[index] === value);
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}
