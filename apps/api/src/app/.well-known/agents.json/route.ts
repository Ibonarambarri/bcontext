/**
 * Discovery manifest for agent frameworks. Lets a scanner introduce a host
 * to Bcontext without prior knowledge of the surface:
 *
 *   curl https://host/.well-known/agents.json
 */
import { withRoute } from "@/lib/route";
import { TOOLS } from "@/lib/mcp/server";

export const GET = withRoute(async (req: Request) => {
  const url = new URL(req.url);
  const origin = `${url.protocol}//${url.host}`;
  return Response.json(
    {
      name: "Bcontext",
      description:
        "The context layer for the AI-first company — typed knowledge graph + RAG. MCP-native: agents connect over MCP; REST serves people and automations that cannot speak MCP.",
      // Decided 2026-09-08 (task "Calidad y escala", D3): MCP is the agent
      // surface; REST is for humans and for automations that cannot speak
      // MCP. Nothing was removed — REST simply stops being advertised to
      // agents. `audience` is the machine-readable form of that decision.
      surfaces: {
        agents: "mcp",
        humans_and_automations: "rest",
        decided_at: "2026-09-08",
      },
      mcp: {
        url: `${origin}/mcp`,
        // One endpoint per workspace, for a project's own config: the path
        // fixes the workspace and an OAuth grant made through it is bound to
        // it. `url` alone takes the workspace from the token.
        workspace_url_template: `${origin}/mcp/{org}/{workspace}`,
        transport: "streamable-http",
        audience: "agents",
        recommendation:
          "The agent surface. Every capability is a tool here; if you are an agent, connect over MCP.",
        // Derived from the server's own tool table: a manifest that lists
        // tool names by hand goes stale the first time they are consolidated,
        // and did.
        tools: TOOLS.map((tool) => tool.name),
      },
      rest: {
        base_url: `${origin}/api`,
        audience: "humans-and-automations",
        note: "For the web app, scripts, CI hooks and curl — callers that cannot speak MCP. Not an agent surface and not at parity with the MCP tools; kept for compatibility, no longer advertised to agents.",
        endpoints: [
          { method: "POST", path: "/api/agents/context", scope: "agents:read" },
          { method: "POST", path: "/api/agents/write", scope: "agents:write" },
          { method: "POST", path: "/api/nexo", scope: "chat:run" },
          { method: "GET", path: "/api/nodes", scope: "nodes:read" },
          { method: "POST", path: "/api/nodes", scope: "nodes:write" },
          { method: "GET", path: "/api/tags", scope: "nodes:read" },
          { method: "POST", path: "/api/tags", scope: "admin:*" },
          { method: "PUT", path: "/api/nodes/:id/tags", scope: "nodes:write" },
          { method: "GET", path: "/api/nodes/:id/subtasks", scope: "nodes:read" },
          { method: "POST", path: "/api/nodes/:id/subtasks", scope: "nodes:write" },
          { method: "GET", path: "/api/views", scope: "nodes:read" },
          { method: "POST", path: "/api/views", scope: "nodes:write" },
          { method: "POST", path: "/api/views/resolve", scope: "nodes:read" },
        ],
      },
      auth: {
        scheme: "bearer",
        scopes: [
          "nodes:read",
          "nodes:write",
          "chat:run",
          "skills:execute",
          "agents:read",
          "agents:write",
          "admin:*",
        ],
        token_prefix: "bctx_live_",
      },
      docs: `${origin}/docs`,
      conventions: {
        content_blocks: {
          rule: "Structure node content with H2 (##) headings. Each H2 section becomes a stable, addressable block referenced as /n/<node_id>#<block_id> where block_id = slugify(heading_text).",
          rationale:
            "Block-level addressing improves RAG retrieval precision and lets references target a specific section instead of an entire document.",
        },
        optimistic_concurrency: {
          rule: "Pass if_updated_at (the updated_at you last read) on content patches. A 409 means another session wrote first: re-fetch, rebase, retry with the new timestamp.",
          rationale:
            "Multiple agents and humans write the same workspace concurrently; last-write-wins silently destroys their work.",
        },
        archiving: {
          rule: "Status archived takes a task out of every view, board, graph and default listing while keeping it readable by id, linked and searchable; any other status brings it back. Archive finished or abandoned work instead of leaving it to pile up.",
          rationale:
            "Tasks are created for a piece of work and then just exist; archiving keeps live views about live work without losing the record or breaking references.",
        },
        subtasks: {
          rule: "A task is one node; the steps to finish it are its subtasks (title, a summary written by the creator, full content_md), passed on create and edited one at a time with subtasks_write — never split one piece of work into phase-N task nodes.",
          rationale:
            "One read of a task returns everything needed to do the work, the graph holds only meaningful units, and a one-line edit costs one small call instead of re-sending the task.",
        },
        dependencies: {
          rule: "Express task dependencies as typed edges (links_write op=link, relation blocked_by), never as prose. Query ready work with nodes({op:\"list\",unblocked:true}).",
          rationale:
            "Structured edges give every agent the same live answer to 'what can I start now' and let briefs report newly-unblocked work.",
        },
        taxonomy: {
          rule: "Keep kind as primary node semantics. Assign zero or more reusable workspace tags for aboutness, and use parent_id only for real hierarchy between semantic nodes. folder and category are not node fields. Tags never grant access or replace workspace RLS.",
          rationale:
            "A shared multi-value taxonomy lets humans and agents retrieve the same node through several topics without duplicating nodes, embeddings, or RAG indexes.",
        },
      },
    },
    {
      headers: {
        "Cache-Control": "public, max-age=300",
      },
    },
  );
});
