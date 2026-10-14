/**
 * SSRF policy for everything the API fetches on behalf of a capability
 * (discovery, OAuth, invocation, logos, health checks). A target is accepted
 * only when it is HTTPS, carries no URL credentials, its host is in the
 * connection's allowlist and every resolved address is public. Callers fetch
 * through `createPinnedFetch`, which dials the validated address instead of
 * re-resolving the name, and usually wrap it in `withResponseSizeLimit`.
 *
 * Failures are `EgressPolicyError`s with a stable `code`; the gateway shows
 * the code to agents and excludes it from circuit-breaker counting.
 */
import type { LookupAddress, LookupOptions } from "node:dns";
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";

/** Policy rejection with a stable `code` (`https_required`, `host_not_allowed`, …). */
export class EgressPolicyError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
  }
}

interface ResolvedTarget {
  url: URL;
  addresses: Array<{ address: string; family: 4 | 6 }>;
}

const blocked = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10],
  ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blocked.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
  ["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10],
  ["ff00::", 8], ["2001:db8::", 32],
] as const) blocked.addSubnet(network, prefix, "ipv6");

/**
 * Validates a URL against the policy and resolves its addresses, rejecting
 * any that fall in a private, loopback, link-local or reserved range. The
 * returned addresses are what `createPinnedFetch` dials.
 */
export async function resolveSafeTarget(
  value: string | URL,
  allowedHosts: readonly string[],
): Promise<ResolvedTarget> {
  const url = value instanceof URL ? new URL(value) : new URL(value);
  if (url.protocol !== "https:") {
    throw new EgressPolicyError("https_required", "capability endpoints must use HTTPS");
  }
  if (url.username || url.password) {
    throw new EgressPolicyError("url_credentials_forbidden", "credentials are forbidden in capability URLs");
  }
  const hostname = normalizeHostname(url.hostname);
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw new EgressPolicyError("local_host_forbidden", "local capability hosts are forbidden");
  }
  const allow = new Set(allowedHosts.map(normalizeHostname));
  if (allow.size === 0 || !allow.has(hostname)) {
    throw new EgressPolicyError("host_not_allowed", `capability host is not allowlisted: ${hostname}`);
  }

  const literalFamily = isIP(hostname);
  const records = literalFamily
    ? [{ address: hostname, family: literalFamily as 4 | 6 }]
    : await lookup(hostname, { all: true, verbatim: true });
  if (records.length === 0) {
    throw new EgressPolicyError("dns_empty", `capability host has no addresses: ${hostname}`);
  }
  const addresses = records.map((record) => ({
    address: record.address,
    family: record.family as 4 | 6,
  }));
  for (const record of addresses) {
    const family = record.family === 4 ? "ipv4" : "ipv6";
    if (blocked.check(record.address, family)) {
      throw new EgressPolicyError("private_address_forbidden", "capability host resolves to a non-public address");
    }
  }
  return { url, addresses };
}

function normalizeHostname(value: string): string {
  return value.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

/**
 * A FetchLike for the MCP SDK that enforces the egress policy and pins each
 * socket to the address we validated. Pinning closes the DNS-rebinding gap
 * left by a validate-then-global-fetch implementation. Redirects are not
 * followed because node:https does not follow them implicitly.
 */
export function createPinnedFetch(allowedHosts: readonly string[]): FetchLike {
  return async (input, init) => {
    const target = await resolveSafeTarget(input, allowedHosts);
    const selected = target.addresses[0]!;
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    const body = bodyBytes(init?.body);

    return new Promise<Response>((resolve, reject) => {
      const req = httpsRequest(
        {
          protocol: "https:",
          hostname: target.url.hostname,
          port: target.url.port || 443,
          method,
          path: `${target.url.pathname}${target.url.search}`,
          headers: Object.fromEntries(headers.entries()),
          servername: target.url.hostname,
          lookup: createPinnedLookup(selected),
        },
        (res) => {
          const responseHeaders = new Headers();
          for (const [name, value] of Object.entries(res.headers)) {
            if (Array.isArray(value)) value.forEach((item) => responseHeaders.append(name, item));
            else if (value !== undefined) responseHeaders.set(name, value);
          }
          resolve(new Response(Readable.toWeb(res) as ReadableStream, {
            status: res.statusCode ?? 502,
            statusText: res.statusMessage,
            headers: responseHeaders,
          }));
        },
      );
      const abort = () => req.destroy(new DOMException("The operation was aborted", "AbortError"));
      if (init?.signal?.aborted) abort();
      else init?.signal?.addEventListener("abort", abort, { once: true });
      req.once("error", reject);
      req.once("close", () => init?.signal?.removeEventListener("abort", abort));
      if (body) req.write(body);
      req.end();
    });
  };
}

/**
 * Caps every upstream HTTP response while it is being consumed. Checking only
 * Content-Length is insufficient because MCP servers may stream JSON or SSE
 * without declaring a size.
 */
export function withResponseSizeLimit(fetchFn: FetchLike, maxBytes: number): FetchLike {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new TypeError("maxBytes must be a positive integer");
  }
  return async (input, init) => {
    const response = await fetchFn(input, init);
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      await response.body?.cancel().catch(() => {});
      throw responseTooLarge(maxBytes);
    }
    if (!response.body) return response;

    const reader = response.body.getReader();
    let received = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const chunk = await reader.read();
          if (chunk.done) {
            controller.close();
            return;
          }
          received += chunk.value.byteLength;
          if (received > maxBytes) {
            await reader.cancel().catch(() => {});
            controller.error(responseTooLarge(maxBytes));
            return;
          }
          controller.enqueue(chunk.value);
        } catch (error) {
          controller.error(error);
        }
      },
      async cancel(reason) {
        await reader.cancel(reason).catch(() => {});
      },
    });
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}

/** `lookup` option for node:https that always answers with the validated address. */
export function createPinnedLookup(selected: { address: string; family: 4 | 6 }) {
  return (
    _hostname: string,
    options: LookupOptions,
    callback: (
      error: NodeJS.ErrnoException | null,
      address: string | LookupAddress[],
      family?: number,
    ) => void,
  ) => {
    // Node's Happy Eyeballs path requests all addresses and requires the
    // array callback shape. Returning the single-address overload here makes
    // node:net read `address` from a string and fail with ERR_INVALID_IP_ADDRESS.
    if (options.all) {
      callback(null, [{ address: selected.address, family: selected.family }]);
      return;
    }
    callback(null, selected.address, selected.family);
  };
}

function bodyBytes(body: BodyInit | null | undefined): string | Uint8Array | undefined {
  if (body == null) return undefined;
  if (typeof body === "string") return body;
  if (body instanceof URLSearchParams) return body.toString();
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  throw new EgressPolicyError("unsupported_body", "gateway only supports buffered request bodies");
}

function responseTooLarge(maxBytes: number): EgressPolicyError {
  return new EgressPolicyError(
    "response_too_large",
    `capability response exceeded ${maxBytes} bytes`,
  );
}
