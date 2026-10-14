/**
 * Provider identity for a discovered MCP server. The name Bcontext shows and
 * stores is derived from the endpoint hostname; whatever the server declares
 * in `initialize` is kept apart under `declared`, because a remote server can
 * claim any name it likes.
 */
import type { Implementation } from "@modelcontextprotocol/sdk/types.js";

export interface DiscoveredProviderMetadata {
  title: string;
  name: string;
  description: string;
  endpointHost: string;
  identitySource: "endpoint_host";
  declared?: {
    title?: string;
    name?: string;
    description?: string;
    version?: string;
  };
}

const GENERIC_HOST_LABELS = new Set(["api", "mcp", "remote", "server", "services", "www"]);
const COMMON_SECOND_LEVEL_SUFFIXES = new Set(["ac", "co", "com", "edu", "gov", "net", "org"]);

/**
 * Builds a useful provider identity anchored to the configured endpoint host.
 * MCP initialize metadata is self-declared by an untrusted remote server, so
 * it is returned separately and must never replace the hostname-derived
 * identity in persistent or prominent UI.
 */
export function inferProviderMetadata(
  endpoint: URL,
  serverInfo?: Implementation,
): DiscoveredProviderMetadata {
  const endpointHost = normalizedEndpointHost(endpoint.hostname);
  const hostName = providerNameFromHost(endpoint.hostname);
  const declaredTitle = cleanLabel(serverInfo?.title);
  const declaredName = cleanLabel(serverInfo?.name);
  const declaredDescription = cleanDescription(serverInfo?.description);
  const declaredVersion = cleanVersion(serverInfo?.version);
  const declared = {
    ...(declaredTitle ? { title: declaredTitle } : {}),
    ...(declaredName ? { name: declaredName } : {}),
    ...(declaredDescription ? { description: declaredDescription } : {}),
    ...(declaredVersion ? { version: declaredVersion } : {}),
  };

  return {
    title: hostName,
    name: providerLabel(hostName),
    description: `${hostName} MCP server at ${endpointHost}`,
    endpointHost,
    identitySource: "endpoint_host",
    ...(Object.keys(declared).length ? { declared } : {}),
  };
}

/**
 * Human label from a hostname: drops the public suffix and generic service
 * labels (`api`, `mcp`, …) so `mcp.linear.app` becomes "Linear". Falls back
 * to "MCP provider" for bare IPs.
 */
export function providerNameFromHost(hostname: string): string {
  const labels = hostname.toLowerCase().replace(/\.$/, "").split(".").filter(Boolean);
  if (labels.length === 0 || labels.every((label) => /^\d+$/.test(label))) return "MCP provider";
  const suffixDepth = labels.at(-1)?.length === 2 && COMMON_SECOND_LEVEL_SUFFIXES.has(labels.at(-2) ?? "")
    ? 2
    : 1;
  const candidates = labels.slice(0, -suffixDepth).filter((label) => !GENERIC_HOST_LABELS.has(label));
  const label = candidates.at(-1) ?? labels.at(0) ?? "MCP provider";
  return titleCase(label.replace(/^mcp[-_]/, "").replace(/[-_]mcp$/, "").replace(/[-_]+/g, " ")) || "MCP provider";
}

function providerLabel(value: string): string {
  const withoutProtocolWords = value
    .replace(/\b(model context protocol|mcp)\b/gi, " ")
    .replace(/\bserver\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return withoutProtocolWords || value;
}

function cleanLabel(value: string | undefined): string {
  if (!value) return "";
  const normalized = stripInvisibleFormatting(value)
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
  if (!normalized) return "";
  return /[a-z]/.test(normalized) && normalized === normalized.toLowerCase()
    ? titleCase(normalized)
    : normalized;
}

function cleanDescription(value: string | undefined): string {
  if (!value) return "";
  return stripInvisibleFormatting(value)
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

function cleanVersion(value: string | undefined): string {
  if (!value) return "";
  return stripInvisibleFormatting(value)
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

function stripInvisibleFormatting(value: string): string {
  return value.normalize("NFKC").replace(/\p{Cf}/gu, "");
}

function normalizedEndpointHost(value: string): string {
  return value.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

function titleCase(value: string): string {
  return value.split(/\s+/).filter(Boolean)
    .map((part) => part.length <= 3 && part === part.toUpperCase()
      ? part
      : `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}
