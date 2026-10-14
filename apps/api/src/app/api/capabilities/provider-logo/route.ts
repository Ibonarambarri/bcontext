/**
 * GET /api/capabilities/provider-logo?workspace_id=…&capability_id=… — the
 * provider's logo, fetched server-side and streamed back as an image.
 *
 * Served by us rather than linked directly so the browser never talks to the
 * provider's host and so the fetch runs under the egress pin: only the
 * brand hosts derived from the endpoint (`providerBrandHosts`), https, image
 * content types, 1 MB and 5 s. A stored `provenance.logo_url` is tried first;
 * older providers without one fall back to discovery. Anything doubtful is a
 * cacheable 404 rather than a guess. Session-cookie owner|admin.
 */
import { z } from "zod";
import { capabilityAdmin } from "@/lib/capabilities/admin";
import { createPinnedFetch, EgressPolicyError } from "@/lib/capabilities/egress";
import {
  discoverProviderLogo,
  isSafeLogoBytes,
  isSafeLogoContentType,
  normalizedLogoContentType,
  providerBrandHosts,
} from "@/lib/capabilities/provider-brand";
import { withRoute } from "@/lib/route";

const MAX_LOGO_BYTES = 1_000_000;

export const GET = withRoute(async (req: Request) => {
  const requestUrl = new URL(req.url);
  const workspaceId = requestUrl.searchParams.get("workspace_id");
  const capabilityId = requestUrl.searchParams.get("capability_id");
  if (
    !workspaceId || !z.string().uuid().safeParse(workspaceId).success
    || !capabilityId || !z.string().uuid().safeParse(capabilityId).success
  ) {
    return Response.json({ error: "invalid_request", message: "workspace_id and capability_id are required" }, { status: 400 });
  }
  const auth = await capabilityAdmin(req, workspaceId);
  if (auth instanceof Response) return auth;

  const [{ data: capability }, { data: connection }] = await Promise.all([
    auth.supabase
      .from("capabilities")
      .select("provenance")
      .eq("workspace_id", workspaceId)
      .eq("id", capabilityId)
      .is("deleted_at", null)
      .maybeSingle(),
    auth.supabase
      .from("capability_connections")
      .select("endpoint_url")
      .eq("workspace_id", workspaceId)
      .eq("capability_id", capabilityId)
      .eq("environment", "production")
      .maybeSingle(),
  ]);
  const provenance = capability?.provenance;
  const rawLogoUrl = provenance && typeof provenance === "object" && !Array.isArray(provenance)
    ? (provenance as Record<string, unknown>).logo_url
    : null;
  if (!capability || !connection?.endpoint_url) return unavailable();

  let endpointUrl: URL;
  try {
    endpointUrl = new URL(connection.endpoint_url);
  } catch {
    return Response.json({ error: "invalid_logo_url" }, { status: 400 });
  }
  const brandHosts = providerBrandHosts(endpointUrl);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const fetcher = createPinnedFetch(brandHosts);
    const candidates: URL[] = [];
    if (typeof rawLogoUrl === "string") {
      try {
        const stored = new URL(rawLogoUrl);
        if (
          stored.protocol === "https:"
          && brandHosts.some((host) => normalizeHost(host) === normalizeHost(stored.hostname))
        ) candidates.push(stored);
      } catch {}
    }

    for (const candidate of candidates) {
      const logo = await fetchLogo(fetcher, candidate, controller.signal);
      if (logo) return logoResponse(logo.bytes, logo.contentType);
    }

    // Existing providers may predate logo discovery. Resolve lazily from the
    // endpoint and, for generic MCP/API hosts, its registrable provider site.
    const discovered = await discoverProviderLogo(
      endpointUrl,
      controller.signal,
      fetcher,
    ).catch(() => null);
    if (!discovered) return unavailable();
    const discoveredUrl = new URL(discovered.url);
    const logo = await fetchLogo(fetcher, discoveredUrl, controller.signal);
    return logo ? logoResponse(logo.bytes, logo.contentType) : unavailable();
  } catch (error) {
    if (error instanceof EgressPolicyError) {
      return Response.json({ error: error.code, message: error.message }, { status: 400 });
    }
    return unavailable();
  } finally {
    clearTimeout(timeout);
  }
});

type PinnedFetch = ReturnType<typeof createPinnedFetch>;

async function fetchLogo(fetcher: PinnedFetch, logoUrl: URL, signal: AbortSignal) {
  const response = await fetcher(logoUrl, {
    headers: { accept: "image/avif,image/webp,image/png,image/jpeg,image/gif,image/x-icon" },
    signal,
  });
  const contentType = response.headers.get("content-type") ?? "";
  if (!response.ok || !isSafeLogoContentType(contentType)) {
    await response.body?.cancel();
    return null;
  }
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_LOGO_BYTES) {
    await response.body?.cancel();
    return null;
  }
  const bytes = await readLimited(response, MAX_LOGO_BYTES);
  if (!bytes || !isSafeLogoBytes(new Uint8Array(bytes), contentType)) return null;
  return { bytes, contentType };
}

function logoResponse(bytes: ArrayBuffer, contentType: string) {
  return new Response(bytes, {
    headers: {
      "content-type": normalizedLogoContentType(contentType),
      "cache-control": "private, max-age=86400, stale-while-revalidate=604800",
      "x-content-type-options": "nosniff",
    },
  });
}

function unavailable() {
  return Response.json(
    { error: "logo_unavailable" },
    { status: 404, headers: { "cache-control": "private, max-age=3600" } },
  );
}

function normalizeHost(value: string): string {
  return value.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

async function readLimited(response: Response, maxBytes: number): Promise<ArrayBuffer | null> {
  const reader = response.body?.getReader();
  if (!reader) return new ArrayBuffer(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const output = new Uint8Array(new ArrayBuffer(size));
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output.buffer;
}
