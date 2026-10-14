/**
 * `/docs/quickstart` — connecting an MCP client (Claude Code, Claude Desktop)
 * to a workspace. Prose; the MCP endpoints are the API's (`/mcp` and
 * `/mcp/<org>/<workspace>`), which this app proxies at the same paths — so
 * the examples use this instance's own origin (`appOrigin`).
 * The workspace endpoint is the recommended way in: OAuth through it yields
 * a token bound to that workspace, no header to remember.
 */
import { headers } from "next/headers";
import { agentInstructions } from "@/lib/agent-instructions";
import { appOrigin } from "@/web/public-origin";
import { Code, DocHeader, DocSection, Inline } from "../_components";

export const metadata = {
  title: "Quickstart — Bcontext docs",
  description:
    "Connect Claude Code or Claude Desktop to a Bcontext workspace via MCP in under a minute.",
};

const PLUGIN_INSTALL = `/plugin marketplace add Bcontext-dev/bcontext-plugin
/plugin install bcontext@bcontext`;

/** The copyable examples, on this instance's own origin. */
function examples(origin: string) {
  const CLAUDE_CODE_OAUTH = `claude mcp add --transport http bcontext-acme-docs ${origin}/mcp/acme/docs`;

  const CLAUDE_CODE_CONFIG = `{
  "mcpServers": {
    "bcontext-acme-docs": {
      "transport": "http",
      "url": "${origin}/mcp/acme/docs",
      "headers": {
        "Authorization": "Bearer bctx_live_..."
      }
    }
  }
}`;

  const CLAUDE_DESKTOP_CONFIG = `{
  "mcpServers": {
    "bcontext-acme-docs": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "${origin}/mcp/acme/docs",
        "--header",
        "Authorization: Bearer bctx_live_..."
      ]
    }
  }
}`;

  const CLAUDE_MD = agentInstructions(
    { endpoint: `${origin}/mcp/acme/docs`, serverName: "bcontext-acme-docs" },
    { org: "acme", slug: "docs" },
  );

  const TEST_CURL = `curl -X POST ${origin}/api/agents/context \\
  -H "Authorization: Bearer bctx_live_..." \\
  -H "Content-Type: application/json" \\
  -d '{ "workspace": "acme/docs", "query": "what is blocking us?", "k": 5 }'`;

  return { CLAUDE_CODE_OAUTH, CLAUDE_CODE_CONFIG, CLAUDE_DESKTOP_CONFIG, CLAUDE_MD, TEST_CURL };
}

export default async function QuickstartPage() {
  const origin = appOrigin(await headers());
  const {
    CLAUDE_CODE_OAUTH,
    CLAUDE_CODE_CONFIG,
    CLAUDE_DESKTOP_CONFIG,
    CLAUDE_MD,
    TEST_CURL,
  } = examples(origin);
  return (
    <article className="max-w-3xl">
      <DocHeader
        eyebrow="Quickstart"
        title="Connect Claude Code in 60 seconds."
        lede="Bcontext speaks the Model Context Protocol over HTTP. Every workspace has its own endpoint; connect through it and the credential is bound to that workspace."
      />

      <DocSection title="1. Take the workspace endpoint">
        <p>
          Each workspace is served at{" "}
          <Inline>{`${origin}/mcp/<org>/<workspace>`}</Inline>{" "}
          — <Inline>Agents → Add agent</Inline> inside the workspace shows the
          exact URL and a snippet per client. A client connected through it
          can only reach that workspace, so a project folder can carry its
          own <Inline>.mcp.json</Inline>. The root <Inline>/mcp</Inline> stays
          for tokens that reach several workspaces; those pick one per request
          with the <Inline>X-Bcontext-Workspace: &lt;org&gt;/&lt;workspace&gt;</Inline>{" "}
          header.
        </p>
      </DocSection>

      <DocSection title="2. Connect Claude Code with OAuth">
        <p>
          One command. Claude Code opens the Bcontext consent screen in your
          browser, where you name the agent and choose its role and
          permissions; the token it receives is bound to the workspace in the
          URL.
        </p>
        <Code
          label="shell"
          code={CLAUDE_CODE_OAUTH}
          caption="Streamable HTTP transport. No proxy, no daemon, no token to store."
        />
      </DocSection>

      <DocSection title="3. Or use a token">
        <p>
          For clients and scripts that do not speak OAuth: sign in, open{" "}
          <Inline>Agents → Add agent → API key</Inline> inside the workspace,
          and create a token with the scopes your agent actually needs — at
          minimum <Inline>nodes:read</Inline> and <Inline>agents:read</Inline>{" "}
          for read-only assistants, plus <Inline>nodes:write</Inline> and{" "}
          <Inline>agents:write</Inline> to let it draft new nodes. Tokens start
          with <Inline>bctx_live_</Inline>. Then add the server to{" "}
          <Inline>~/.claude/mcp.json</Inline> (or the project-level{" "}
          <Inline>.mcp.json</Inline>); Claude Code reloads MCP servers on
          restart.
        </p>
        <Code label="~/.claude/mcp.json" code={CLAUDE_CODE_CONFIG} />
      </DocSection>

      <DocSection title="4. Or use Claude Desktop">
        <p>
          Claude Desktop still expects a stdio command. Bridge it with{" "}
          <Inline>mcp-remote</Inline>, which turns any HTTP MCP server into a
          local stdio process.
        </p>
        <Code
          label="Claude Desktop config"
          code={CLAUDE_DESKTOP_CONFIG}
          caption="macOS path: ~/Library/Application Support/Claude/claude_desktop_config.json"
        />
      </DocSection>

      <DocSection title="5. Install the plugin">
        <p>
          Connecting gives the agent the tools; the plugin gives it the
          conventions. It ships a skill Claude Code loads whenever it touches
          Bcontext — start with <Inline>brief</Inline>, H2 blocks, subtasks
          inside a task, the <Inline>if_updated_at</Inline> rule, edges instead
          of prose — and <Inline>/bcontext:brief</Inline>, a standup of the
          workspace. Two lines inside Claude Code:
        </p>
        <Code label="claude code" code={PLUGIN_INSTALL} />
        <p>
          Other runtimes get the same manual from the server: the{" "}
          <Inline>instructions</Inline> field of <Inline>initialize</Inline>{" "}
          is short and accurate for the build they are talking to.
        </p>
      </DocSection>

      <DocSection title="6. Put the workflow in CLAUDE.md">
        <p>
          The file the runtime reads at the start of every session in a
          project — <Inline>CLAUDE.md</Inline> for Claude Code,{" "}
          <Inline>AGENTS.md</Inline> for Codex and Zed,{" "}
          <Inline>.cursor/rules</Inline> for Cursor — is where the workflow
          lives: where the project&apos;s memory is, how a session runs
          (<Inline>brief</Inline> → one task in progress with subtasks →{" "}
          <Inline>done</Inline> + a <Inline>## Result</Inline> block) and
          how to write so the next reader can use it. <Inline>Agents → Add
          agent</Inline> renders this with your workspace&apos;s address
          already in place; this is the shape:
        </p>
        <Code label="CLAUDE.md" code={CLAUDE_MD} />
      </DocSection>

      <DocSection title="7. Structure content with H2 blocks">
        <p>
          Every <Inline>##</Inline> heading in a node body becomes a stable,
          addressable block. References look like{" "}
          <Inline>/n/abc#vision-2026</Inline>, where the fragment is the slug
          of the heading. Bcontext uses block-level ids to sharpen RAG
          retrieval and lets agents (or humans) link to a specific section
          instead of an entire document.
        </p>
      </DocSection>

      <DocSection title="8. Verify it works">
        <p>
          From Claude Code, ask the agent to search Bcontext for something you
          know exists. Or hit the REST endpoint directly to confirm the
          token is wired up correctly:
        </p>
        <Code label="curl" code={TEST_CURL} />
        <p>
          A <Inline>200</Inline> with a <Inline>retrieved</Inline> array
          means you&apos;re live. A <Inline>401</Inline> means the token is
          wrong; a <Inline>403</Inline> means the token doesn&apos;t grant
          access to that workspace.
        </p>
      </DocSection>
    </article>
  );
}
