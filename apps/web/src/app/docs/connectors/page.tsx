/**
 * `/docs/connectors` — the first-party connectors (GitHub, Slack, Linear,
 * Notion) and the connector SDK. Static prose; the work it describes runs in
 * bcontext-api and its pg-boss worker.
 */
import { Code, DocHeader, DocSection, Inline } from "../_components";

export const metadata = {
  title: "Connectors — Bcontext docs",
  description:
    "GitHub, Slack, Linear, and Notion connectors — install flow, scopes, webhooks, and the 4-method connector SDK.",
};

export default function ConnectorsDoc() {
  return (
    <article>
      <DocHeader
        eyebrow="Docs"
        title="Connectors"
        lede="Plug Bcontext into GitHub, Slack, Linear, or Notion. Each connector implements the same 4-method interface (authorize / fullSync / handleWebhook / toContextNode), runs on the shared job queue, and upserts nodes idempotently by (source, external_id)."
      />

      <DocSection title="Overview">
        <p>
          A connector is a workspace-scoped install of an external system. Install state lives in <Inline>connector_installs</Inline>; jobs (full sync, webhook ingest, push-back) flow through <Inline>connector_jobs</Inline> with a 30s → 24h retry ladder and a dead-letter status after five attempts.
        </p>
        <p>
          Secrets never sit in the install row itself. They&apos;re stored in Supabase Vault and referenced via <Inline>secret_ref</Inline> (formats: <Inline>vault:&lt;id&gt;</Inline>, <Inline>env:&lt;NAME&gt;</Inline>, or <Inline>inline:&lt;b64&gt;</Inline> — the last only valid in dev).
        </p>
      </DocSection>

      <DocSection title="GitHub">
        <p>
          A GitHub App per Bcontext deployment, with one installation per workspace. Webhooks signed with the App&apos;s secret arrive at <Inline>/api/webhooks/github</Inline> and are verified with HMAC-SHA256 (header <Inline>X-Hub-Signature-256</Inline>).
        </p>
        <Code
          label="Install"
          code={`POST /api/connectors/github/install
{ "workspace_id": "<uuid>" }

# 200
{ "install_id": "<uuid>", "redirect_url": "https://github.com/apps/<slug>/installations/new?state=<install_id>" }`}
        />
        <p>
          After the user installs the App, GitHub redirects to <Inline>/api/connectors/github/callback?installation_id=&lt;n&gt;&amp;state=&lt;install_id&gt;</Inline>. The callback exchanges the App JWT for an installation access token and persists it via the Vault. Tokens are refreshed before every full sync and push because GitHub installation tokens are short-lived.
        </p>
        <p>
          <strong>Pull side.</strong> <Inline>fullSync</Inline> backfills the install&apos;s repo READMEs (kind=<Inline>doc</Inline>) and open issues/PRs (issues → <Inline>task</Inline>, PRs → <Inline>adr</Inline>).
        </p>
        <p>
          <strong>Push side.</strong> Updating a <Inline>skill</Inline> node fires <Inline>pushSkillExports</Inline> which commits <Inline>AGENTS.md</Inline>, <Inline>CLAUDE.md</Inline>, <Inline>.cursor/rules/bcontext.mdc</Inline>, and <Inline>.clinerules</Inline> to every repo in <Inline>config.repo_allowlist[]</Inline> on the default branch.
        </p>
        <p>
          Required env vars: <Inline>GITHUB_APP_ID</Inline>, <Inline>GITHUB_APP_SLUG</Inline>, <Inline>GITHUB_APP_PRIVATE_KEY</Inline> (PKCS8 PEM), <Inline>GITHUB_WEBHOOK_SECRET</Inline>.
        </p>
        <p>
          Minimum repository permissions: Contents read/write (README pull plus explicit rules push), Issues read, and Pull requests read. Subscribe only to Issues, Pull request, Push, and Installation events; the last keeps suspend, unsuspend, and uninstall state aligned locally.
        </p>
      </DocSection>

      <DocSection title="Slack">
        <p>
          A Slack App with the user-installable OAuth flow. Scopes intentionally exclude <Inline>im:*</Inline> and <Inline>mpim:*</Inline> — DMs are off-limits by default for compliance.
        </p>
        <Code
          label="OAuth scopes"
          code={`channels:history,groups:history,users:read,commands,reactions:read`}
          caption="No DM/MPIM scopes. Channel allowlist on connector_installs.config.channels[]."
        />
        <p>
          Events arrive at <Inline>/api/webhooks/slack</Inline>. The v0 signature scheme (HMAC-SHA256 over <Inline>v0:{`<ts>`}:{`<body>`}</Inline>) is verified with a 5-minute replay window. The URL-verification handshake responds inline.
        </p>
        <p>
          <strong>Slash command.</strong> <Inline>/bcontext search &lt;query&gt;</Inline> ephemeral-responds with the top-3 RAG hits via the standard <Inline>retrieve()</Inline> path. The signature is verified before the response is computed.
        </p>
        <p>
          <strong>Reaction.</strong> A <Inline>:bcontext:</Inline> reaction on any message in an allowlisted channel creates a <Inline>doc</Inline> node, keyed by <Inline>(channel, ts)</Inline> so re-reacts upsert.
        </p>
        <p>
          Required env vars: <Inline>SLACK_CLIENT_ID</Inline>, <Inline>SLACK_CLIENT_SECRET</Inline>, <Inline>SLACK_SIGNING_SECRET</Inline>.
        </p>
      </DocSection>

      <DocSection title="Linear">
        <p>
          OAuth against <Inline>linear.app/oauth/authorize</Inline> with scopes <Inline>read,write,issues:create</Inline>. Webhook payloads arrive at <Inline>/api/webhooks/linear</Inline> and are verified via HMAC-SHA256 against the per-install <Inline>config.webhook_secret</Inline> (env fallback: <Inline>LINEAR_WEBHOOK_SECRET</Inline>).
        </p>
        <p>
          <strong>Pull side.</strong> <Inline>fullSync</Inline> issues GraphQL <Inline>viewer.assignedIssues</Inline> (backlog/unstarted/started) → <Inline>task</Inline> nodes. Comments → <Inline>doc</Inline> children. State + priority are mapped to Bcontext&apos;s <Inline>backlog/todo/in_progress/done</Inline> shape.
        </p>
        <p>
          <strong>Push side.</strong> Updating a Bcontext task that carries <Inline>data.linear_id</Inline> fires <Inline>pushBcontextStatusToLinear</Inline> (GraphQL <Inline>issueUpdate</Inline>) — fire-and-forget. No-op when the status is unchanged or the connector install is missing.
        </p>
        <p>
          Required env vars: <Inline>LINEAR_CLIENT_ID</Inline>, <Inline>LINEAR_CLIENT_SECRET</Inline>, <Inline>LINEAR_WEBHOOK_SECRET</Inline>.
        </p>
      </DocSection>

      <DocSection title="Notion (bulk import only)">
        <p>
          Notion&apos;s webhook surface is unreliable for bulk-import use cases, so this connector is intentionally one-shot. Two paths:
        </p>
        <p>
          <strong>OAuth path.</strong> Standard authorize redirect (Notion uses Basic auth on the token endpoint). <Inline>fullSync</Inline> crawls <Inline>/v1/search</Inline> with cursor pagination persisted in <Inline>connector_jobs.payload.cursor</Inline> so the worker can resume after rate-limit pauses.
        </p>
        <p>
          <strong>ZIP path.</strong> Drop a Notion export zip on the workspace sidebar. Markdown pages become semantic nodes; every enclosing directory and legacy category frontmatter becomes a reusable tag. Directories never become synthetic nodes.
        </p>
        <p>
          Required env vars: <Inline>NOTION_CLIENT_ID</Inline>, <Inline>NOTION_CLIENT_SECRET</Inline>.
        </p>
      </DocSection>

      <DocSection title="Worker">
        <p>
          Inline <Inline>runJob</Inline> is fast-path for the install + immediate-sync flow. Retried and background work (<Inline>connector.drain</Inline>, <Inline>connector.schedule</Inline>, <Inline>webhook.drain</Inline>) runs in the API&apos;s pg-boss worker process — same image, <Inline>BCONTEXT_PROCESS=worker</Inline> — with the cadence versioned in code. Nothing to schedule from outside.
        </p>
      </DocSection>

      <DocSection title="Build your own">
        <p>
          The connector SDK is a 4-method interface. Implement <Inline>authorize</Inline>, <Inline>fullSync</Inline>, <Inline>handleWebhook</Inline>, and <Inline>toContextNode</Inline>; call <Inline>registerConnector(c)</Inline> at module load. See <Inline>src/lib/connectors/types.ts</Inline> for the contract and <Inline>github/index.ts</Inline> for the most complete reference.
        </p>
      </DocSection>
    </article>
  );
}
