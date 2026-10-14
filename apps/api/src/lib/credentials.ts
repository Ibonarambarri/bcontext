/**
 * Shared invariant: `credential` node secret values must never reach the
 * AI-agent surface (MCP, `/api/agents/*`, retrieval/RAG, embeddings, the
 * changes feed).
 *
 * The reason is stronger than "an agent might misuse it". Everything an
 * agent reads is written down: an MCP tool result lands verbatim in the
 * client's transcript on disk, is replayed to the model provider on every
 * following turn, and may be summarised into a session log. A secret that
 * enters an agent's context is a secret that has been copied to at least
 * three places nobody rotates. So the value never enters it — not even once,
 * not even for a "safe" read.
 *
 * Secrets live only in `node.data.fields[].value`, never in `content_md`.
 * The human web UI (authenticated session, RLS-scoped, via
 * `/api/nodes/[id]/inspector`) reads real values; every agent-facing
 * serialization point goes through `redactCredentialForAgents`, and every
 * agent that needs to USE a credential resolves
 * `bx://credential/<node>#<field>` out of band (see
 * `/api/credentials/[nodeId]/materialize`), so the value goes into a process
 * environment instead of into a conversation.
 */

import { readCredential, redactCredentialData, REDACTED_VALUE } from "@bcontext-dev/contract/credentials";

/**
 * Returns a safe-for-agents copy of `node`. Pass-through for any kind other
 * than `credential`. For a `credential`, `data` is replaced by its redacted
 * shape: the type, the environment, the service, and one entry per field
 * with its name, its `secret` flag and its `bx://` reference — but never a
 * value, secret-flagged or not.
 */
export function redactCredentialForAgents<
  T extends { id?: string; kind: string; data?: unknown; content_md?: unknown },
>(node: T): T {
  if (node.kind !== "credential") return node;
  const redacted = { ...node, data: redactCredentialData(node.data, node.id) };
  return typeof node.content_md === "string"
    ? { ...redacted, content_md: scrubValues(node.content_md, node.data) }
    : redacted;
}

/**
 * `content_md` is a note, not a field — but people paste. A production
 * credential node in this very workspace had a password sitting in its prose,
 * where the field redaction could not see it and every agent reading the node
 * could. So the note is scrubbed too: any run of characters that IS one of
 * this credential's values comes out as the sentinel.
 *
 * Short values are left alone — a three-character "value" would match half the
 * prose and turn the note into confetti, and it is not a secret worth the
 * damage. This is a net, not a policy: the policy is that secrets live in
 * `fields`.
 */
function scrubValues(contentMd: string, data: unknown): string {
  if (!contentMd) return contentMd;
  const values = readCredential(data)
    .fields.map((field) => field.value)
    .filter((value) => value.length >= 6)
    // Longest first, so a value that contains another is replaced whole.
    .sort((a, b) => b.length - a.length);
  let out = contentMd;
  for (const value of values) out = out.split(value).join(REDACTED_VALUE);
  return out;
}
