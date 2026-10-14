/**
 * `/docs/api` — the REST surface for people and automations that cannot speak
 * MCP. Static prose; MCP (`/mcp`) is the agent surface, so nothing here is
 * advertised to agents as the way in.
 */
import { headers } from "next/headers";
import { appOrigin } from "@/web/public-origin";
import { Code, DocHeader, DocSection, Inline } from "../_components";

export const metadata = {
  title: "API reference — Bcontext docs",
  description:
    "REST endpoints for people and automations that cannot speak MCP: context retrieval, idempotent writes, Nexo, and direct node CRUD.",
};

const CONTEXT_REQ = `POST /api/agents/context
Authorization: Bearer bctx_live_...
Content-Type: application/json

{
  "workspace": "acme/docs",
  "query":     "what is blocking the embedding pipeline?",
  "k":         6,
  "scope":     { "schema_version": 1, "type": "tags", "tags_any": ["product", "tech"] },
  "fields":    ["id", "title", "kind", "status"],
  "include_counts": true
}`;

const CONTEXT_RES = `{
  "workspace": "acme/docs",
  "query":     "what is blocking the embedding pipeline?",
  "scope":     { "schema_version": 1, "type": "tags", "size": 31, "workspace_size": 128, "can_expand_to_workspace": true },
  "retrieved": [
    { "node_id": "...", "title": "...", "score": 0.82, "excerpt": "..." }
  ],
  "tree":   [ { "id": "...", "title": "...", "kind": "doc", "status": null } ],
  "counts": { "docs": 14, "tasks": 22, "decisions": 3, "bugs": 5 }
}`;

const WRITE_REQ = `POST /api/agents/write
Authorization: Bearer bctx_live_...
Idempotency-Key: agent-42-batch-7
Content-Type: application/json

{
  "workspace": "acme/docs",
  "ops": [
    { "op": "create", "node": {
        "title": "ADR — switch auth provider",
        "kind": "adr",
        "parent_id": null,
        "content_md": "## Context\\n..."
    } },
    { "op": "patch", "id": "node_123", "patch": { "status": "done" } }
  ]
}`;

const CHAT_REQ = `POST /api/nexo
Authorization: Bearer bctx_live_...
Content-Type: application/json

{
  "workspace": "acme/docs",
  "scope": { "schema_version": 1, "type": "neighborhood", "root_node_ids": ["node_123"], "depth": 1 },
  "messages": [
    { "role": "user", "content": "summarize the open ADRs" }
  ]
}`;

const NODES_REQ = `GET /api/nodes?workspace=acme/docs
Authorization: Bearer bctx_live_...

POST /api/nodes
Authorization: Bearer bctx_live_...
Content-Type: application/json

{
  "workspace": "acme/docs",
  "title":     "Migration plan",
  "kind":      "doc",
  "parent_id": null,
  "tag_ids":   ["tag_product", "tag_ai"]
}`;

const TAGS_REQ = `GET /api/tags?workspace=acme/docs
Authorization: Bearer bctx_live_...

POST /api/tags
Authorization: Bearer bctx_live_...
Content-Type: application/json

{ "workspace": "acme/docs", "name": "Customer research" }

PUT /api/nodes/node_123/tags
Authorization: Bearer bctx_live_...
Content-Type: application/json

{ "workspace": "acme/docs", "tag_ids": ["tag_product", "tag_ai"] }`;

export default async function ApiDocsPage() {
  const origin = appOrigin(await headers());
  return (
    <article className="max-w-3xl">
      <DocHeader
        eyebrow="API reference"
        title="REST endpoints."
        lede="Four primary surfaces, for the web app, scripts, CI hooks and curl. Agents connect over MCP instead — REST is kept for callers that cannot. Auth is always a workspace-scoped bearer token. Writes accept Idempotency-Key for retry safety."
      />

      <DocSection title="MCP endpoints">
        <p>
          Agents connect to{" "}
          <Inline>{`${origin}/mcp/<org>/<workspace>`}</Inline>,
          one endpoint per workspace: OAuth through it issues a token bound to
          that workspace, and nothing else needs saying. The root{" "}
          <Inline>/mcp</Inline> serves tokens that reach several workspaces;
          those name the one to use per request with{" "}
          <Inline>X-Bcontext-Workspace: &lt;org&gt;/&lt;workspace&gt;</Inline>.
        </p>
      </DocSection>

      <DocSection title="Authentication">
        <p>
          Send your token as <Inline>Authorization: Bearer bctx_live_...</Inline>.
          Tokens are workspace-scoped: a token issued for workspace{" "}
          <Inline>acme/docs</Inline> can only read/write nodes in{" "}
          <Inline>acme/docs</Inline>. Cross-workspace calls return{" "}
          <Inline>403</Inline> with{" "}
          <Inline>&quot;token does not grant access to this workspace&quot;</Inline>.
        </p>
      </DocSection>

      <DocSection title="Content conventions">
        <p>
          Structure node bodies with <Inline>##</Inline> headings — each
          section becomes a stable, addressable block. References use{" "}
          <Inline>/n/&lt;node_id&gt;#&lt;block_id&gt;</Inline> (e.g.{" "}
          <Inline>/n/abc#vision-2026</Inline>), where the block id is the
          slug of the heading text. The convention is soft: nodes without
          H2s still work, they just degrade to whole-document references.
        </p>
        <p>
          <Inline>kind</Inline> is the node&apos;s primary semantics. Tags are
          reusable workspace taxonomy and a node may carry several of them;
          <Inline>parent_id</Inline> optionally connects semantic nodes into a
          real hierarchy. Tags only classify content — they never grant access
          or replace workspace RLS. <Inline>folder</Inline> and{" "}
          <Inline>category</Inline> are not node fields.
        </p>
      </DocSection>

      <DocSection title="Rate limits">
        <p>
          Token-bucket per <Inline>(workspace, scope-class)</Inline>. Buckets
          refill continuously; denial returns <Inline>429</Inline> with a{" "}
          <Inline>Retry-After</Inline> header.
        </p>
        <Code
          code={`read   120 req, refill   2 req/s
write   60 req, refill   1 req/s
chat    30 req, refill 0.5 req/s
embed   10 req, refill 0.1 req/s`}
          caption="Burst capacity, then the sustained rate — so 120, 60 and 30 requests a minute for read, write and chat per token. Fixed in the API, not configurable per workspace."
        />
      </DocSection>

      <DocSection title="POST /api/agents/context">
        <p>
          The read endpoint for automations that cannot speak MCP (an agent
          gets the same through the MCP tools). Returns the top-k retrieval
          hits for <Inline>query</Inline> plus a projected semantic hierarchy.
          Retrieval scope is versioned and supports workspace (default), saved
          view, tags any/all, selection, neighborhood, and auto. Explicit
          scopes filter candidates before vector/BM25 ranking; auto reports
          its boosted lanes and always keeps a global workspace lane.
          Requires scope <Inline>agents:read</Inline>.
        </p>
        <Code label="Request" code={CONTEXT_REQ} />
        <Code label="Response" code={CONTEXT_RES} />
      </DocSection>

      <DocSection title="POST /api/agents/write">
        <p>
          Batch up to 20 ops per call. <Inline>create</Inline> inserts a
          new node; <Inline>patch</Inline> partially updates one by id.
          Include an <Inline>Idempotency-Key</Inline> header — replays of
          the same key return the original response with{" "}
          <Inline>Idempotent-Replay: true</Inline>. Requires scope{" "}
          <Inline>agents:write</Inline>.
        </p>
        <Code label="Request" code={WRITE_REQ} />
        <p>
          Supported writable node kinds: <Inline>doc</Inline>, <Inline>task</Inline>, <Inline>decision</Inline>,{" "}
          <Inline>meeting</Inline>, <Inline>bug</Inline>, <Inline>adr</Inline>,{" "}
          <Inline>entity</Inline>, <Inline>skill</Inline>.
        </p>
      </DocSection>

      <DocSection title="POST /api/nexo">
        <p>
          One turn with Nexo, the assistant inside the app, against your
          workspace via the configured AI Gateway model. Retrieves citations
          from RAG, builds a context block, and streams the Vercel AI SDK{" "}
          <Inline>streamText</Inline> result back as NDJSON. Optional{" "}
          <Inline>pageContext</Inline> says where the caller is standing and{" "}
          <Inline>conversationId</Inline> continues a conversation (omit it to
          open one; the id comes back in a header). Requires scope{" "}
          <Inline>chat:run</Inline>.
        </p>
        <Code label="Request" code={CHAT_REQ} />
      </DocSection>

      <DocSection title="GET/POST /api/nodes">
        <p>
          Direct node CRUD for non-agent clients. <Inline>GET</Inline> needs{" "}
          <Inline>nodes:read</Inline>; <Inline>POST</Inline> needs{" "}
          <Inline>nodes:write</Inline>. Individual nodes live at{" "}
          <Inline>/api/nodes/[id]</Inline> with{" "}
          <Inline>PATCH</Inline> and <Inline>DELETE</Inline>.
          Filter by reusable taxonomy with <Inline>tag_id</Inline> or{" "}
          <Inline>tag</Inline>; repeat either parameter and pass{" "}
          <Inline>tags_match=all</Inline> to require every tag.
        </p>
        <Code label="Request" code={NODES_REQ} />
      </DocSection>

      <DocSection title="Tags taxonomy">
        <p>
          List tags and usage counts with <Inline>GET /api/tags</Inline>.
          Owners/admins create, rename, merge, and delete tag definitions;
          callers with <Inline>nodes:write</Inline> may assign existing tags.
          Rename and merge preserve aliases for compatibility. Node tag
          assignments are metadata-only and do not create separate embeddings.
        </p>
        <Code label="Requests" code={TAGS_REQ} />
      </DocSection>

      <DocSection title="Errors">
        <p>
          All errors return JSON with an <Inline>error</Inline> field and an
          appropriate HTTP status: <Inline>400</Inline> bad input,{" "}
          <Inline>401</Inline> missing/invalid token, <Inline>403</Inline>{" "}
          wrong workspace, <Inline>404</Inline> workspace or node not
          found, <Inline>429</Inline> rate limited.
        </p>
      </DocSection>
    </article>
  );
}
