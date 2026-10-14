/**
 * Shared contract + helpers for the per-provider Nango adapters.
 *
 * One adapter = one file in this directory, registered with one line in
 * `./index.ts`. That is deliberate: batches of providers are built in
 * parallel by different people/agents, and the only file two of them ever
 * touch together is the index (one line each, alphabetical). The generic
 * connector (`../index.ts`) does everything an adapter does not: connect
 * session, cursor bookkeeping, batch extraction, NEXO triage.
 *
 * An adapter answers one question — "what changed since `since`?" — by
 * calling the provider through the Nango proxy and mapping each item to an
 * `IngestSignal` with a stable `external_id`, a title, flattened text, a
 * URL back to the source, the author and the change instant.
 */
import type { IngestSignal } from "@/lib/ingest/batch-extract";
import type { NangoClient } from "@/lib/nango/client";

export interface FetchChangesArgs {
  client: NangoClient;
  connectionId: string;
  /** Nango's connection_config (subdomain, hostname, …). */
  connectionConfig: Record<string, unknown>;
  /** Install config (allow-lists, …). */
  config: Record<string, unknown>;
  /** Fetch changes strictly after this instant. */
  since: Date;
  /** Soft cap on signals per run. */
  limit: number;
}

export interface FetchChangesResult {
  signals: IngestSignal[];
  /** Diagnostics for the install's last_run_stats. */
  stats?: Record<string, number>;
}

export interface NangoAdapter {
  /** connector_id and the Nango integration unique_key — the same string. */
  id: string;
  /** Nango provider key (providers.yaml). */
  provider: string;
  sourceHint: string;
  fetchChanges(args: FetchChangesArgs): Promise<FetchChangesResult>;
}

// -- helpers ------------------------------------------------------------------

export function str(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

export function subdomain(connectionConfig: Record<string, unknown>): string {
  return str(connectionConfig.subdomain);
}

export function hostname(connectionConfig: Record<string, unknown>, fallback = ""): string {
  return str(connectionConfig.hostname) || fallback;
}

/** Atlassian Document Format → plain text (text nodes, in order). */
export function adfToText(node: unknown): string {
  if (!node || typeof node !== "object") return "";
  const n = node as { type?: string; text?: string; content?: unknown[] };
  if (n.type === "text") return n.text ?? "";
  const inner = (n.content ?? []).map(adfToText).join(n.type === "paragraph" || n.type === "heading" ? "" : "\n");
  return n.type === "paragraph" || n.type === "heading" || n.type === "listItem" ? `${inner}\n` : inner;
}

/** Storage-format / HTML → plain text, good enough for an LLM. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(br|\/p|\/li|\/h[1-6]|\/tr|\/div)[^>]*>/gi, "\n")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Jira's JQL wants "yyyy/MM/dd HH:mm" in the account's timezone; UTC is fine for "since". */
export function jqlDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}/${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

/** A string[] allow-list from the install config, or null when unset/empty. */
export function allowList(config: Record<string, unknown>, key: string): string[] | null {
  const raw = config[key];
  if (!Array.isArray(raw)) return null;
  const list = raw.map(str).filter(Boolean);
  return list.length ? list : null;
}

/** A single string from the install config, or null. */
export function configString(config: Record<string, unknown>, key: string): string | null {
  const v = config[key];
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** Keep the first N chars of a long body so one signal cannot eat the whole batch. */
export function clip(text: string, max = 6000): string {
  return text.length > max ? `${text.slice(0, max)}\n…` : text;
}

/** Decode base64url (Gmail bodies) to UTF-8 text. */
export function base64UrlToText(data: string): string {
  const normalised = data.replace(/-/g, "+").replace(/_/g, "/");
  try {
    return Buffer.from(normalised, "base64").toString("utf8");
  } catch {
    return "";
  }
}

/** Date → epoch seconds, for APIs that take unix timestamps. */
export function epochSeconds(d: Date): number {
  return Math.floor(d.getTime() / 1000);
}
