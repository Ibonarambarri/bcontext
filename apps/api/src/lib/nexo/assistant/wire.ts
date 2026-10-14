/**
 * The NDJSON wire between a Nexo turn and the browser.
 *
 * One JSON object per line. Only what the UI renders survives — provider
 * metadata, request warnings and the noisy `text-start` / `tool-input-delta`
 * markers are dropped — so the client parser stays a `switch` over
 * `NexoWireEvent` (defined in the contract, shared by both repos).
 */
import type { NexoWireEvent } from "@bcontext-dev/contract/nexo/assistant";

function serializePart(part: unknown): NexoWireEvent | null {
  if (!part || typeof part !== "object") return null;
  const p = part as Record<string, unknown>;
  switch (p.type) {
    case "text-delta":
      return { type: "text-delta", text: String(p.text ?? "") };
    case "reasoning-delta":
      return { type: "reasoning-delta", text: String(p.text ?? "") };
    case "tool-call":
      return {
        type: "tool-call",
        toolCallId: String(p.toolCallId ?? ""),
        toolName: String(p.toolName ?? ""),
        input: p.input,
      };
    case "tool-result":
      return {
        type: "tool-result",
        toolCallId: String(p.toolCallId ?? ""),
        toolName: String(p.toolName ?? ""),
        output: p.output,
      };
    case "tool-error":
      return {
        type: "tool-error",
        toolCallId: String(p.toolCallId ?? ""),
        toolName: String(p.toolName ?? ""),
        error:
          p.error instanceof Error ? p.error.message : String(p.error ?? "tool error"),
      };
    case "finish":
      return { type: "finish" };
    case "error":
      return {
        type: "error",
        message:
          p.error instanceof Error ? p.error.message : String(p.error ?? "stream error"),
      };
    default:
      return null;
  }
}

/** Pipes an AI SDK `fullStream` to the browser as NDJSON, dropping parts the UI never renders. */
export function streamAsNdjson(
  parts: AsyncIterable<unknown>,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    async start(controller) {
      const emit = (event: NexoWireEvent) =>
        controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
      try {
        for await (const part of parts) {
          const wire = serializePart(part);
          if (wire) emit(wire);
        }
      } catch (err) {
        emit({
          type: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      } finally {
        controller.close();
      }
    },
  });
}

/** A whole turn as two lines — used when there is no model to call. */
export function textAsNdjson(text: string): string {
  return (
    JSON.stringify({ type: "text-delta", text } satisfies NexoWireEvent) +
    "\n" +
    JSON.stringify({ type: "finish" } satisfies NexoWireEvent) +
    "\n"
  );
}
