/**
 * Embedding pipeline: chunk a node's content, embed each chunk with the
 * instance's AI backend (`@/lib/ai/provider`), and upsert into the
 * `embeddings` table.
 *
 * Called fire-and-forget from `SupabaseStorage.{create,update}Node`
 * (`scheduleEmbed`) so freshly-written content is searchable within seconds
 * without manual triggering; `embedNode` is the awaitable form for tests and
 * batch re-embeds.
 */
import { embedMany } from "ai";
import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveEmbeddingModel } from "@/lib/rag";
import { aiConfigured, embeddingModel } from "@/lib/ai/provider";
import { chunkMarkdown } from "@bcontext-dev/contract/rag/chunk";
import { datasetEmbeddingText, type DatasetNodeData } from "@bcontext-dev/contract/datasets";
import {
  combinePrefix,
  contextualRetrievalEnabled,
  contextualizeChunks,
  resolveContextModel,
  type ContextualChunk,
} from "./contextualize";
import { recordAiUsageEvent, type AiUsageTokens } from "@/lib/telemetry/ai-usage";

/**
 * The text a node contributes to the vector index.
 *
 * For a `data` node this is its SHAPE and not its rows: title, description,
 * columns and their types. A dataset has to be findable by semantics — "do we
 * have customer data?" must reach it — and must never put a row in an answer.
 * The rows live in `dataset_rows`; embedding them would put three thousand
 * customers into hundreds of chunks competing with the workspace's actual
 * knowledge in every single search, which is exactly what the ```csv block in
 * `content_md` used to do.
 *
 * Anything left in a legacy `data` node's body is deliberately dropped rather
 * than appended: a node that has not been migrated yet still carries its CSV
 * there, and "embed the prose too" would embed the table with it.
 */
export function embeddingSourceFor(node: {
  title: string;
  content_md?: string | null;
  kind?: string | null;
  data?: Record<string, unknown> | null;
}): string {
  if (node.kind === "data") {
    return datasetEmbeddingText({ title: node.title }, (node.data ?? {}) as DatasetNodeData);
  }
  return `# ${node.title}\n\n${node.content_md ?? ""}`;
}

export interface EmbedNodeResult {
  status: "embedded" | "skipped";
  chunks: number;
  reason?: string;
}

/**
 * (Re-)embed a single node by id. Idempotent: removes any prior chunks
 * for the node before writing the new ones, so retries converge.
 */
export async function embedNode(
  client: SupabaseClient,
  nodeId: string,
  opts?: { embeddingModel?: string },
): Promise<EmbedNodeResult> {
  if (!aiConfigured()) {
    return { status: "skipped", chunks: 0, reason: "no AI backend configured" };
  }

  const { data: node, error: nodeErr } = await client
    .from("nodes")
    .select("id, workspace_id, title, content_md, kind, data")
    .eq("id", nodeId)
    .maybeSingle();
  if (nodeErr) throw new Error(`embedNode: ${nodeErr.message}`);
  if (!node) return { status: "skipped", chunks: 0, reason: "node not found" };
  // Security invariant: credential nodes are never embedded. Secrets live
  // in node.data.fields, never content_md, but even a keyword-matchable
  // title/content trace of a credential's existence in the vector index
  // is more agent-surface than the invariant allows — skip entirely.
  if (node.kind === "credential") {
    await client.from("embeddings").delete().eq("node_id", node.id);
    return { status: "skipped", chunks: 0, reason: "credential" };
  }
  // A `data` node is the other kind whose content does not belong in the
  // index, but for the opposite reason: it must stay findable. It is not
  // skipped — `embeddingSourceFor` gives it its schema instead of its rows.

  const source = embeddingSourceFor({
    title: node.title as string,
    content_md: node.content_md as string | null,
    kind: node.kind as string | null,
    data: node.data as Record<string, unknown> | null,
  });
  const chunks = chunkMarkdown(source);
  if (chunks.length === 0) {
    await client.from("embeddings").delete().eq("node_id", node.id);
    return { status: "embedded", chunks: 0 };
  }

  const model = opts?.embeddingModel ?? resolveEmbeddingModel();

  // Most re-embeds are small edits: a `## Result` appended, a checklist item
  // flipped, a sentence changed in one block. Every other chunk of the node
  // comes out of the splitter byte-identical, so its prefix and its vector
  // are still right — regenerating them was ~38% of all contextualize calls
  // in prod (188 of 495). Reuse what we already have for chunks whose text
  // did not change, and pay only for the ones that did. With prefixes on,
  // a chunk whose stored prefix is empty is regenerated: that is what a
  // past gateway outage looks like, and this is where it heals.
  const wantPrefix = contextualRetrievalEnabled();
  const reusable = new Map<string, { context_prefix: string; embedding: unknown }>();
  {
    const { data: prior } = await client
      .from("embeddings")
      .select("content, context_prefix, embedding, embedding_version")
      .eq("node_id", node.id);
    for (const row of prior ?? []) {
      if (row.embedding_version !== model || !row.embedding) continue;
      if (wantPrefix && !row.context_prefix) continue;
      reusable.set(row.content as string, {
        context_prefix: (row.context_prefix as string | null) ?? "",
        embedding: row.embedding,
      });
    }
  }
  const fresh = chunks.filter((c) => !reusable.has(c.content));

  // Contextual Retrieval: generate a short LLM prefix per chunk
  // that situates it inside the parent doc. Embedding and BM25 both key
  // off the prefixed text; the raw chunk content is preserved on the row
  // so UI snippets still show the actual document substring. Resilient:
  // on failure the prefix is "" and we fall back to plain content.
  let contextualizeTokens: AiUsageTokens = { input: 0, output: 0, cached: 0 };
  let contextualizeCost: number | null = null;
  const generated = await contextualizeChunks(
    { title: node.title as string, content_md: source },
    fresh,
    {
      onUsage: (tokens, costUsd) => {
        contextualizeTokens = {
          input: (contextualizeTokens.input ?? 0) + (tokens.input ?? 0),
          output: (contextualizeTokens.output ?? 0) + (tokens.output ?? 0),
          cached: (contextualizeTokens.cached ?? 0) + (tokens.cached ?? 0),
          cacheWrite: (contextualizeTokens.cacheWrite ?? 0) + (tokens.cacheWrite ?? 0),
        };
        if (costUsd !== null) contextualizeCost = (contextualizeCost ?? 0) + costUsd;
      },
    },
  );
  if (contextualizeTokens.input || contextualizeTokens.output) {
    void recordAiUsageEvent({
      workspaceId: node.workspace_id as string,
      surface: "contextualize",
      model: resolveContextModel(),
      tokens: contextualizeTokens,
      providerCostUsd: contextualizeCost,
      metadata: {
        node_id: node.id as string,
        chunks: chunks.length,
        reused: chunks.length - fresh.length,
      },
    });
  }
  const generatedByContent = new Map(generated.map((c) => [c.content, c]));
  const enriched: ContextualChunk[] = chunks.map((c) => {
    const kept = reusable.get(c.content);
    if (kept) {
      return {
        ...c,
        context_prefix: kept.context_prefix,
        embedding_input: combinePrefix(kept.context_prefix, c.content),
      };
    }
    return generatedByContent.get(c.content) ?? { ...c, context_prefix: "", embedding_input: c.content };
  });

  // Embedding models cap input tokens (~8k for text-embedding-3-small). A
  // pathological chunk the splitter couldn't break further (e.g. one huge
  // paragraph with no sentence boundaries) would fail the WHOLE embedMany
  // batch and leave the node silently unindexed — including its small,
  // perfectly indexable sibling blocks. Clamp the embedding input; the row
  // keeps the full content for snippets and BM25.
  const MAX_EMBED_CHARS = 24_000;
  const toEmbed = enriched.filter((c) => !reusable.has(c.content));
  const vectors = new Map<string, unknown>();
  for (const [content, kept] of reusable) vectors.set(content, kept.embedding);
  if (toEmbed.length > 0) {
    const { embeddings, usage, providerMetadata } = await embedMany({
      model: embeddingModel(model),
      values: toEmbed.map((c) => c.embedding_input.slice(0, MAX_EMBED_CHARS)),
    });
    toEmbed.forEach((c, i) => vectors.set(c.content, embeddings[i]));
    void recordAiUsageEvent({
      workspaceId: node.workspace_id as string,
      surface: "embed",
      model,
      tokens: { input: usage?.tokens ?? 0 },
      providerMetadata,
      metadata: { node_id: node.id as string, chunks: enriched.length, reused: enriched.length - toEmbed.length },
    });
  }

  await client.from("embeddings").delete().eq("node_id", node.id);

  // Tag every chunk with the model id that produced it. Retrieval filters
  // on this so we never mix vector spaces across models.
  //
  // note: `metadata.block_id` is the H2-derived stable in-node block
  // identifier (`@bcontext-dev/contract/rag/chunk`). Rows written before block ids
  // existed don't have this field — `retrieveFromSupabase` reads
  // `block_id: null` and downstream code treats it as "whole node".
  // We don't backfill: the next edit of such a node will naturally
  // rewrite its rows here with `block_id` populated.
  const rows = enriched.map((c, i) => ({
    workspace_id: node.workspace_id,
    node_id: node.id,
    chunk_index: i,
    content: c.content,
    context_prefix: c.context_prefix,
    embedding: vectors.get(c.content),
    embedding_version: model,
    metadata: { heading_path: c.heading_path, tokens: c.tokens, block_id: c.block_id },
  }));
  const { error: insErr } = await client.from("embeddings").insert(rows);
  if (insErr) throw new Error(`embedNode: ${insErr.message}`);
  return { status: "embedded", chunks: rows.length };
}

/**
 * Fire-and-forget wrapper for write-path hooks. Logs failures but never
 * throws, so a failing embed never blocks the user's write.
 */
export function scheduleEmbed(
  client: SupabaseClient,
  nodeId: string,
): void {
  void embedNode(client, nodeId).catch((err) => {
    // Intentional: never throw from the write path. Logged as a JSON line
    // so failures are visible in the process logs.
    process.stderr.write(
      JSON.stringify({
        level: "error",
        event: "embed.failed",
        node_id: nodeId,
        error: { message: err instanceof Error ? err.message : String(err) },
      }) + "\n",
    );
  });
}
