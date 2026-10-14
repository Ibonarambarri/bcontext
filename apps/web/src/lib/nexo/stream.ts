/**
 * Reading a Nexo turn off the wire.
 *
 * `POST /api/nexo` answers with NDJSON — one JSON event per `\n`-terminated
 * line. This module is the parser plus the small vocabulary the UI needs to
 * describe a step while it runs ("Editing 4f2a…#goal") and after it lands.
 *
 * The event union itself lives in the contract, so the two repos cannot drift.
 */
import {
  NEXO_TOOL_LABELS,
  type NexoToolName,
  type NexoWireEvent,
} from "@bcontext-dev/contract/nexo/assistant";

export type { NexoWireEvent };

/** One tool call as the trace shows it. */
export interface ToolStep {
  id: string;
  name: string;
  input: unknown;
  status: "running" | "ok" | "error";
  summary: string;
  detail?: string;
}

/**
 * What a step says while it is running. Nexo names the node it is touching,
 * because "Editing" alone tells the user nothing about what is about to change.
 */
export function describeToolCall(name: string, input: unknown): string {
  const label = NEXO_TOOL_LABELS[name as NexoToolName] ?? `Calling ${name}`;
  const i = (input ?? {}) as Record<string, unknown>;
  if (name === "search_nodes" && typeof i.query === "string") {
    return `${label}: “${truncate(i.query, 48)}”`;
  }
  if (name === "list_nodes") {
    const bits = [i.kind, i.status].filter(Boolean).map(String);
    return bits.length ? `${label} · ${bits.join(" · ")}` : label;
  }
  if (name === "create_node" && typeof i.title === "string") {
    return `${label}: ${truncate(i.title, 40)}`;
  }
  if (name === "read_block" || name === "replace_in_block") {
    const block = i.block_id ? `#${String(i.block_id)}` : "";
    return `${label} ${shortId(String(i.node_id ?? ""))}${block}`;
  }
  if (name === "add_reference" || name === "remove_reference" || name === "link_nodes") {
    return `${label} ${shortId(String(i.from_node_id ?? ""))} → ${shortId(String(i.to_node_id ?? ""))}`;
  }
  if (typeof i.node_id === "string") {
    return `${label} ${shortId(i.node_id)}`;
  }
  if (name === "open_view" && typeof i.view_slug === "string") {
    return `${label} ${i.view_slug}`;
  }
  return label;
}

/** What a step says once it has an answer. */
export function describeToolOutput(name: string, output: unknown): string | undefined {
  if (!output || typeof output !== "object") return undefined;
  const o = output as Record<string, unknown>;
  if (o.ok === false && typeof o.error === "string") return o.error;
  if (typeof o.summary === "string") return o.summary;
  if (name === "search_nodes" && Array.isArray(o.hits)) {
    return `${o.hits.length} match${o.hits.length === 1 ? "" : "es"}`;
  }
  if (name === "list_nodes" && typeof o.count === "number") {
    return `${o.count} node${o.count === 1 ? "" : "s"}`;
  }
  if (name === "list_tags" && Array.isArray(o.tags)) {
    return `${o.tags.length} tags`;
  }
  if (name === "read_node" && typeof o.title === "string") {
    const chars =
      typeof o.content_md === "string" ? ` · ${(o.content_md as string).length} chars` : "";
    return `${o.title}${chars}`;
  }
  if (name === "read_block" && typeof o.heading === "string") {
    const chars =
      typeof o.body_md === "string" ? ` · ${(o.body_md as string).length} chars` : "";
    return `${o.heading}${chars}`;
  }
  return undefined;
}

/** Tool results carry failure as `{ error }` in the payload, not as a separate event. */
export function outputIsError(output: unknown): boolean {
  return (
    typeof output === "object" &&
    output !== null &&
    (output as Record<string, unknown>).ok === false
  );
}

function shortId(raw: string): string {
  const s = raw.startsWith("/n/") ? raw.slice(3) : raw;
  return s.length <= 14 ? s : `${s.slice(0, 6)}…${s.slice(-4)}`;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/**
 * Feed bytes in, get the incomplete trailing line back so the caller can
 * prepend it to the next chunk. A line that isn't JSON is forwarded as text
 * rather than dropped — a plain-text error from a proxy should still reach the
 * user instead of vanishing.
 */
function parseNdjsonChunk(
  buf: string,
  onEvent: (event: NexoWireEvent) => void,
): string {
  let remaining = buf;
  let idx = remaining.indexOf("\n");
  while (idx !== -1) {
    const raw = remaining.slice(0, idx).trim();
    remaining = remaining.slice(idx + 1);
    if (raw) emitLine(raw, onEvent);
    idx = remaining.indexOf("\n");
  }
  return remaining;
}

function emitLine(raw: string, onEvent: (event: NexoWireEvent) => void): void {
  try {
    onEvent(JSON.parse(raw) as NexoWireEvent);
  } catch {
    onEvent({ type: "text-delta", text: `${raw}\n` });
  }
}

/** Drain a response body, dispatching every event. Resolves when it ends. */
export async function consumeNdjsonStream(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: NexoWireEvent) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      buf = parseNdjsonChunk(buf, onEvent);
    }
    buf += decoder.decode();
    if (buf.trim()) emitLine(buf.trim(), onEvent);
  } finally {
    reader.releaseLock();
  }
}
