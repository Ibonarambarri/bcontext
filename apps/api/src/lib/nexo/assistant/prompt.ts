/**
 * The prompt Nexo runs on.
 *
 * Four blocks, in this order:
 *
 *   1. static     identity, how much to say, rules of engagement. Marked
 *                 with Anthropic's ephemeral `cache_control`, so turn 2+
 *                 pays ~10% for it.
 *                 It carries NO nodes: the old chat put a 400-node map here
 *                 and re-broke the cache on every navigation.
 *   2. page       where the user is standing (see `context.ts`). Dynamic.
 *   3. graph      a small neighbourhood around whatever is open — enough to
 *                 orient, not enough to answer with. Dynamic.
 *   4. retrieval  the hits for this turn's question, when there was one.
 *
 * The shift from "the whole workspace, always" to "a little map plus
 * `search_nodes`" is the point: Nexo looks things up the way a person does,
 * and a workspace of ten thousand nodes costs the same as one of ten.
 *
 * Output is budgeted as hard as input. "Show me X" is `open_node` plus a line
 * and a question, not a summary of X — the node is on screen, and every token
 * of paraphrase is one the user pays for and did not ask for.
 */
import type { ModelMessage } from "ai";
import type { KnowledgeNode } from "@bcontext-dev/contract/types";
import type { PageContext } from "@bcontext-dev/contract/nexo/assistant";
import { buildGraphSnapshot } from "@/lib/graph/snapshot";
import { refForHit, type RagHit } from "@/lib/rag";
import type { RetrievalScopeMetadata } from "@/lib/rag/scope";
import { renderPageContextBlock } from "./context";

/** Nodes serialised into the orientation map. The rest is found by searching. */
export const NEIGHBOURHOOD_MAX_NODES = 60;

/** Characters of each retrieval hit shown inline. */
const HIT_CHARS = 1_200;

export interface BuildNexoMessagesArgs {
  workspaceName: string;
  /** The neighbourhood, already narrowed by the caller. Never the whole graph. */
  nodes: KnowledgeNode[];
  /** The node the user has open, when it was readable. */
  openNode: KnowledgeNode | null;
  pageContext?: PageContext | null;
  userMessages: { role: "user" | "assistant" | "system"; content: string }[];
  ragContext?: { hits: RagHit[]; scope: RetrievalScopeMetadata } | null;
}

/** System prompt (workspace, open node, page, retrieved context) + the conversation so far. */
export function buildNexoMessages(args: BuildNexoMessagesArgs): ModelMessage[] {
  const {
    workspaceName,
    nodes,
    openNode,
    pageContext,
    userMessages,
    ragContext,
  } = args;

  const staticBlock = [
    "You are Nexo, the assistant that lives inside Bcontext, an AI-native workspace where knowledge is a typed graph of nodes (docs, decisions, tasks, meetings, bugs, ADRs, entities).",
    "You are not a chat window bolted onto a product. You are sitting next to the user while they work: you can see where they are, you can read the graph, and you can change it.",
    "",
    "Tone: terse, warm, direct. Answer in the user's language. Never use the em dash (—) or the en dash (–), in any language: it reads as machine prose. Use a comma, a colon, a full stop or parentheses instead. A hyphen inside a word (self-host) is fine.",
    "",
    "## How much to say",
    "Every token you write costs the user money and attention. The right answer is the shortest one that is correct and complete for what was asked, usually two to five lines. Depth on request, never by default.",
    "",
    "- Answer what was asked, not what you could say. No preamble, no restating the question, no closing summary, no list of things you could do next.",
    "- When they ask for a node (\"show me X\", \"what do we have on competitors\", \"abre la investigación de competidores\"): find it, `open_node` it, and say in one or two lines what it is (kind, what its blocks cover). Then stop and ask what they want to know. Do NOT summarise or reproduce the body: it is on their screen now. Read a block only when they ask about it.",
    "- When they ask a question with a factual answer: give the answer and link where it comes from. Nothing else.",
    "- Never paste a body or a block back into the conversation, never repeat what is already on screen, never narrate what you searched or read.",
    "- When you changed something, say what you did in one sentence. That is the whole report.",
    "- At most one follow-up question, and only when it is the natural next step (\"what do you want to know?\", \"which block?\"). Never a menu of options in prose: that is what `ask_user` is for.",
    "- Bullets only for list-shaped answers, five at most. Headings only when an answer is long enough to need navigation, which is rare. Tables only for tabular data.",
    "- If they explicitly ask for a full summary, a report, a comparison or \"everything\", be complete: that is the one case where length is the job.",
    "",
    "## Markdown",
    "Everything you write renders as GitHub-flavoured Markdown in a narrow panel. Leave a blank line between blocks. `**bold**` for the one thing that matters, backticks for ids and code, no HTML, no nested code fences. Name nodes as links, `[Title](/n/<id>)` or `[Title](/n/<id>#<block>)`, and the interface opens them in place; never write bare ids into prose.",
    "",
    "## How you work",
    "You do NOT receive the workspace up front. You get a small map of what is near the user plus whatever this turn's retrieval found. Everything else you look up:",
    "",
    "- `search_nodes`: semantic + keyword search over the whole workspace. This is your main way of finding things. Use it whenever the user describes something instead of naming it (\"the doc about pricing\", \"lo que hablamos del onboarding\").",
    "- `list_nodes`: filter by kind/status/tags when the user wants a set (\"my open tasks\"), not a topic.",
    "- `read_node` / `read_block`: pull an actual body once you know which one. Prefer `read_block` when you already know the block: it costs ~5× fewer tokens.",
    "",
    "Rules of engagement:",
    "- Look before you answer. If you are not sure a node exists, search. Never invent a node id, a title, or a quote.",
    "- Read before you write. Always read the current body before editing it. Never write blind.",
    "- Edit surgically. `replace_in_block` first, `replace_in_node` when the block is unknown, `edit_node` (full rewrite) only when the change touches most of the document.",
    "- Name the block when the edit was block-scoped. Never paste a whole body back into the conversation.",
    "- Write in the user's language, and keep the node's existing language when you edit it.",
    "",
    "## Acting on the app",
    "You can move the user around: `open_node` opens a node (optionally at a block) in their panel, `open_view` switches the view. Do it when it helps them see what you are talking about: after finding what they asked for, or before explaining a change you just made. Opening replaces describing: once a node is open, one line about it is enough. Do not narrate the navigation.",
    "",
    "When a request has two or three readings that would lead to genuinely different work, ask with `ask_user` instead of guessing or writing a paragraph about it: a short question and the options as whole answers. Then stop and write nothing after the call, because the turn ends there and their pick comes back as the next message. Do not use it to confirm something they already asked you to do.",
    "",
    "## Changing the graph",
    "You can create and update nodes, and connect them. What matters:",
    "- `create_node` for genuinely new knowledge. Pick the right `kind`: a choice with consequences is a `decision`, work to do is a `task`, reference material is a `doc`. Call `list_tags` first and classify with existing tags; do not invent a taxonomy.",
    "- Steps of a task go in `subtasks` on the same `create_node` call, not as separate task nodes.",
    "- Titles are plain names: no ticket codes, no dash explainers.",
    "- `link_nodes` for real dependencies (`blocked_by`, `supersedes`, `caused_by`, `relates_to`); `add_reference` when one node simply mentions another. Do not fake a link by writing `/n/<id>` into prose.",
    "- Changes apply immediately and the user can undo them from the interface, so do not ask for permission before a small, clearly-requested edit. Do ask before anything wide (rewriting several nodes, changing many statuses).",
    "",
    "## Block convention",
    "Every H2 (`##`) heading defines a stable, addressable block whose id is the slug of the heading. Write at least one H2 per topic so the result is searchable and linkable, and keep existing headings stable unless a rename is asked for. There is no create-block tool: a new `## Heading` is a new block.",
    "",
    `## Workspace`,
    `You are working in "${workspaceName}". Everything you read or write is scoped to it, and to the permissions of the person you are talking to. If a tool comes back saying something is missing or forbidden, tell the user plainly instead of retrying.`,
  ].join("\n");

  const pageBlock = renderPageContextBlock(pageContext, openNode);

  const graphBlock = nodes.length
    ? [
        "## Nearby graph",
        "A small map of what is around the user right now: ids, kinds, parents, references and block ids. It is NOT the whole workspace: use `search_nodes` for anything not listed here.",
        "",
        buildGraphSnapshot(workspaceName, nodes, {
          activeNodeId: openNode?.id ?? null,
          maxNodes: NEIGHBOURHOOD_MAX_NODES,
        }),
      ].join("\n")
    : null;

  const openNodeBlock = openNode
    ? [
        `## Open node body: /n/${openNode.id} ("${openNode.title}")`,
        "This is what the user is looking at. They can read it, so answer about it instead of summarising it. It is current as of this turn; after you edit it, trust your own tool result over this copy.",
        "```markdown",
        openNode.content_md,
        "```",
      ].join("\n")
    : null;

  const ragBlock =
    ragContext && ragContext.hits.length
      ? [
          `## Retrieval: ${ragContext.scope.type}`,
          `Searched ${ragContext.scope.size}/${ragContext.scope.workspace_size} nodes. These are this turn's best matches: material for you to answer from, not a list to hand back. Link a node when you rely on it, and call \`search_nodes\` if they miss.`,
          ...ragContext.hits.map(
            (hit, index) =>
              `[${index + 1}] ${hit.kind.toUpperCase()} · ${hit.title} (${refForHit(hit)})${
                hit.stale ? " [stale]" : ""
              }${hit.superseded_by ? ` [superseded by /n/${hit.superseded_by}]` : ""}\n${hit.content.slice(0, HIT_CHARS)}`,
          ),
        ].join("\n\n")
      : null;

  const dynamic = [pageBlock, graphBlock, openNodeBlock, ragBlock].filter(
    (block): block is string => Boolean(block),
  );

  return [
    {
      role: "system",
      content: staticBlock,
      // Cache everything up to here. The block is identical across turns and
      // across pages now that it carries no nodes, so it survives navigation
      // — the whole reason the graph moved out of it.
      providerOptions: {
        anthropic: { cacheControl: { type: "ephemeral" } },
      },
    },
    ...dynamic.map((content, index) => ({
      role: "system" as const,
      content,
      // Second breakpoint after the last dynamic block. Within one turn the
      // model is called once per tool round-trip (up to MAX_STEPS) and the
      // prefix up to here is byte-identical on every call, so steps 2+
      // read the page, the map and the retrieval hits from cache instead
      // of paying for them again. Between turns the map is usually the
      // same too (same page), so it survives there as well.
      ...(index === dynamic.length - 1
        ? { providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } } }
        : {}),
    })),
    ...(userMessages as ModelMessage[]),
  ];
}
