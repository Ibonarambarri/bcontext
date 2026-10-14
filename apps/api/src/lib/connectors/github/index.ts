/**
 * GitHub connector (GitHub App, first-party — not through Nango).
 *
 * Install flow: workspace owner clicks "Connect GitHub" → we redirect to
 *   `https://github.com/apps/<APP_SLUG>/installations/new?state=<install_id>`.
 *
 * Webhook flow: GitHub POSTs to `/api/webhooks/github`. The route verifies
 *   `X-Hub-Signature-256` (HMAC-SHA256 of the raw body with the App's
 *   webhook secret) and dispatches to this connector's `handleWebhook`.
 *
 * Pull side: fullSync backfills repo READMEs + open issues + open PRs.
 *
 * Push side: the AGENTS.md generator calls `pushFileToRepo` to commit on
 *   the repo's default branch using an installation token.
 *
 * No SDK dependency — we hit the REST API with `fetch` and use the JWT
 * signed by the App's private key for installation-token exchange.
 */
import { registerConnector } from "../registry";
import type {
  Connector,
  ConnectorContext,
  ContextNodeInput,
  SyncResult,
  WebhookEnvelope,
  WebhookOutcome,
} from "@bcontext-dev/contract/connectors/types";
import { ConnectorAuthError, ConnectorSignatureError } from "@bcontext-dev/contract/connectors/types";
import { putSecret } from "../secrets";
import { updateInstall } from "../installs";
import {
  isCandidateWorthyIssue,
  isCandidateWorthyMergedPr,
  proposeGithubIssueCandidate,
  proposeGithubMergedPrCandidate,
} from "@/lib/ingest/extractors/github";

const APP_INSTALL_PATH = "/installations/new";

interface InstallationToken {
  token: string;
  expires_at: string;
}

interface RepoLite {
  id: number;
  full_name: string;
  default_branch: string;
}

interface IssueLite {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  html_url: string;
  pull_request?: { url: string };
  user?: { login: string } | null;
  labels?: Array<{ name: string }>;
  /** Only present on `pull_request` webhook payloads. */
  merged?: boolean;
  additions?: number;
  deletions?: number;
}

export type GitHubInstallLifecycleStatus =
  | "active"
  | "paused"
  | "uninstalled";

/**
 * Map GitHub App installation lifecycle webhooks onto the local install.
 * Keeping this pure makes the security-sensitive transition easy to test;
 * the webhook route applies it only after the request signature is verified.
 */
export function githubInstallStatusFromWebhook(
  event: string,
  payload: Record<string, unknown>,
): GitHubInstallLifecycleStatus | null {
  if (event !== "installation") return null;
  switch (payload.action) {
    case "deleted":
      return "uninstalled";
    case "suspend":
      return "paused";
    case "unsuspend":
      return "active";
    default:
      return null;
  }
}

export function githubInstallationId(
  config: Record<string, unknown>,
): number | null {
  const value = config.installation_id;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

const githubConnector: Connector = {
  id: "github",

  async authorize(ctx, phase) {
    if (phase === "start") {
      const appSlug = process.env.GITHUB_APP_SLUG;
      if (!appSlug) {
        throw new ConnectorAuthError(
          "GitHub App is not configured on the server: set GITHUB_APP_SLUG, GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY and GITHUB_WEBHOOK_SECRET.",
        );
      }
      return {
        redirectUrl: `https://github.com/apps/${appSlug}${APP_INSTALL_PATH}?state=${ctx.installId}`,
      };
    }
    if (phase === "complete") {
      // Called by /api/connectors/github/callback once the GitHub App
      // installation completes and we exchange a JWT for an installation
      // token. The caller passes { installation_id }.
      return {};
    }
    // revoke: the install is local-only; GitHub-side revocation happens
    // when the user uninstalls the App from github.com/settings.
    return {};
  },

  async fullSync(ctx, _cursor): Promise<SyncResult & { nodes: ContextNodeInput[] }> {
    let token = ctx.secret;
    const installationId = githubInstallationId(ctx.config);
    if (installationId) {
      const refreshed = await refreshInstallationToken({
        workspaceId: ctx.workspaceId,
        installId: ctx.installId,
        installationId,
      });
      if (!refreshed) {
        throw new ConnectorAuthError("GitHub installation token refresh failed");
      }
      token = refreshed.token;
    }
    if (!token) return { processed: 0, byKind: {}, nodes: [] };
    const repos = await listInstallationRepos(token);
    const allowed = (ctx.config.repo_allowlist as string[] | undefined) ?? null;
    const targets = allowed
      ? repos.filter((r) => allowed.includes(r.full_name))
      : repos;

    const nodes: ContextNodeInput[] = [];
    const byKind: Record<string, number> = {};
    for (const repo of targets) {
      const readme = await fetchReadme(token, repo.full_name);
      if (readme) {
        nodes.push(readme);
        byKind.doc = (byKind.doc ?? 0) + 1;
      }
      const issues = await listOpenIssues(token, repo.full_name);
      for (const issue of issues) {
        const node = issueToNode(repo, issue);
        if (node) {
          nodes.push(node);
          byKind[node.kind] = (byKind[node.kind] ?? 0) + 1;
        }
      }
    }

    return {
      processed: nodes.length,
      byKind,
      nodes,
      hasMore: false,
      cursor: null,
    };
  },

  async handleWebhook(ctx, envelope: WebhookEnvelope): Promise<WebhookOutcome> {
    const secret = process.env.GITHUB_WEBHOOK_SECRET;
    if (!secret) {
      throw new ConnectorSignatureError("github webhook secret missing");
    }
    const signature = envelope.headers["x-hub-signature-256"] ?? "";
    const ok = await verifyHubSignature(secret, envelope.rawBody, signature);
    if (!ok) throw new ConnectorSignatureError();

    const event = envelope.headers["x-github-event"] ?? "";
    const payload = JSON.parse(envelope.rawBody) as Record<string, unknown>;
    const nodes: ContextNodeInput[] = [];

    if (event === "issues" || event === "pull_request") {
      const action = payload.action as string;
      const isPR = event === "pull_request";
      const issueLike = (payload.issue ?? payload.pull_request) as IssueLite | undefined;
      const repo = payload.repository as { full_name: string; default_branch: string } | undefined;

      if (isPR && action === "closed" && issueLike && repo) {
        // Merged PRs go exclusively through review (an ingest candidate),
        // never a direct node upsert: a merged PR is a summary-worthy event,
        // not a task that needs to exist as a node.
        if (issueLike.merged) {
          if (isCandidateWorthyMergedPr(issueLike)) {
            await proposeGithubMergedPrCandidate({
              workspaceId: ctx.workspaceId,
              repo: { full_name: repo.full_name },
              pr: issueLike,
            });
          }
        } else {
          const node = issueToNode(repo, issueLike);
          if (node) {
            node.status = "done";
            nodes.push(node);
          }
        }
      } else if (
        action === "opened" ||
        action === "edited" ||
        action === "reopened" ||
        action === "closed"
      ) {
        if (issueLike && repo) {
          // Only opened/closed issues are ever candidate-eligible, and only
          // when the cheap filter judges them worth an LLM call; everything
          // else (edited,
          // reopened, or filtered-out issues, and all non-merged PR
          // actions) keeps the existing direct-upsert behavior unchanged.
          const routeToCandidates =
            !isPR &&
            (action === "opened" || action === "closed") &&
            isCandidateWorthyIssue(issueLike);
          if (routeToCandidates) {
            await proposeGithubIssueCandidate({
              workspaceId: ctx.workspaceId,
              repo: { full_name: repo.full_name },
              issue: issueLike,
            });
          } else {
            const node = issueToNode(
              { full_name: repo.full_name, default_branch: repo.default_branch },
              issueLike,
            );
            if (node) {
              // Closed issues become done tasks; map status.
              if (action === "closed") node.status = "done";
              nodes.push(node);
            }
          }
        }
      }
    }

    if (event === "push") {
      // Touched README on default branch → re-pull the doc node.
      const ref = payload.ref as string | undefined;
      const repo = payload.repository as { full_name: string; default_branch: string } | undefined;
      if (repo && ref && ref === `refs/heads/${repo.default_branch}`) {
        // Defer to a synthetic full_sync on this repo — small + idempotent.
        // The runtime queues this implicitly via the install's
        // last_sync_at; we just emit nothing here.
      }
    }

    return { nodes, audit: `github.${event}` };
  },

  toContextNode(_ctx, entity) {
    // Used by tests + callers that already have an entity object.
    return entity as unknown as ContextNodeInput;
  },
};

registerConnector(githubConnector);

// -- GitHub REST helpers ----------------------------------------------------

const GH_API = "https://api.github.com";
const ACCEPT = "application/vnd.github+json";

async function listInstallationRepos(token: string): Promise<RepoLite[]> {
  const res = await fetch(`${GH_API}/installation/repositories?per_page=100`, {
    headers: { Authorization: `token ${token}`, Accept: ACCEPT },
  });
  if (!res.ok) return [];
  const json = (await res.json()) as { repositories: RepoLite[] };
  return json.repositories ?? [];
}

async function fetchReadme(
  token: string,
  fullName: string,
): Promise<ContextNodeInput | null> {
  const res = await fetch(`${GH_API}/repos/${fullName}/readme`, {
    headers: {
      Authorization: `token ${token}`,
      Accept: "application/vnd.github.raw",
    },
  });
  if (!res.ok) return null;
  const md = await res.text();
  return {
    source: "github",
    external_id: `repo:${fullName}:readme`,
    kind: "doc",
    title: `${fullName} · README`,
    content_md: md,
    tags: ["tech"],
    data: { repo: fullName, kind_hint: "readme" },
  };
}

async function listOpenIssues(
  token: string,
  fullName: string,
): Promise<IssueLite[]> {
  const res = await fetch(
    `${GH_API}/repos/${fullName}/issues?state=open&per_page=50`,
    { headers: { Authorization: `token ${token}`, Accept: ACCEPT } },
  );
  if (!res.ok) return [];
  return (await res.json()) as IssueLite[];
}

function issueToNode(
  repo: { full_name: string; default_branch?: string },
  issue: IssueLite,
): ContextNodeInput | null {
  const isPR = !!issue.pull_request;
  const kind = isPR ? "adr" : "task";
  const externalId = `${isPR ? "pr" : "issue"}:${repo.full_name}#${issue.number}`;
  const status = issue.state === "open" ? "in_progress" : "done";
  return {
    source: "github",
    external_id: externalId,
    kind,
    title: `${repo.full_name}#${issue.number} — ${issue.title}`,
    content_md:
      (issue.body ?? "") +
      `\n\n---\n\n_${isPR ? "PR" : "Issue"} on ${repo.full_name} · ${issue.html_url}_`,
    status,
    data: {
      repo: repo.full_name,
      number: issue.number,
      author: issue.user?.login ?? null,
      labels: (issue.labels ?? []).map((l) => l.name),
      html_url: issue.html_url,
    },
  };
}

// -- Signature verification -------------------------------------------------

export async function verifyHubSignature(
  secret: string,
  rawBody: string,
  header: string,
): Promise<boolean> {
  if (!header.startsWith("sha256=")) return false;
  const expected = header.slice("sha256=".length);
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(rawBody));
  const hex = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return timingSafeEqual(hex, expected);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// -- Push side (AGENTS.md commit-back) --------------------------------------

/**
 * Commit a single file to the repo's default branch. Used by the
 * AGENTS.md generator when skill/rule nodes change.
 *
 * Returns the resulting commit sha, or null on failure (best-effort —
 * never throws into the AGENTS.md export path).
 */
export async function pushFileToRepo(opts: {
  token: string;
  repo: string; // "owner/name"
  path: string; // e.g. "AGENTS.md"
  message: string;
  content: string;
}): Promise<string | null> {
  const headers = {
    Authorization: `token ${opts.token}`,
    Accept: ACCEPT,
  };
  // Read existing sha, if any, for the PUT-with-sha update path.
  const existing = await fetch(
    `${GH_API}/repos/${opts.repo}/contents/${encodeURIComponent(opts.path)}`,
    { headers },
  );
  let sha: string | undefined;
  if (existing.ok) {
    const j = (await existing.json()) as { sha?: string };
    sha = j.sha;
  }
  const res = await fetch(
    `${GH_API}/repos/${opts.repo}/contents/${encodeURIComponent(opts.path)}`,
    {
      method: "PUT",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        message: opts.message,
        content: Buffer.from(opts.content, "utf8").toString("base64"),
        sha,
      }),
    },
  );
  if (!res.ok) return null;
  const j = (await res.json()) as { commit?: { sha?: string } };
  return j.commit?.sha ?? null;
}

// -- Install-token exchange (called from /api/connectors/github/callback) --

/**
 * Exchange the App JWT for an installation access token. Stored as
 * `vault:<id>` on the install row; tokens expire after 1h so the runtime
 * may need to refresh on use (left to a followup — current token has
 * full sync budget).
 */
export async function exchangeInstallationToken(
  installationId: number,
): Promise<InstallationToken | null> {
  const jwt = await mintAppJwt();
  if (!jwt) return null;
  const res = await fetch(
    `${GH_API}/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${jwt}`, Accept: ACCEPT },
    },
  );
  if (!res.ok) return null;
  return (await res.json()) as InstallationToken;
}

/**
 * Mint a short-lived JWT signed with the GitHub App's private key.
 * Returns null when the App isn't configured (dev / OSS self-host
 * without GitHub integration).
 */
async function mintAppJwt(): Promise<string | null> {
  const appId = process.env.GITHUB_APP_ID;
  const pem = process.env.GITHUB_APP_PRIVATE_KEY;
  if (!appId || !pem) return null;
  try {
    const now = Math.floor(Date.now() / 1000);
    const header = { alg: "RS256", typ: "JWT" };
    const payload = { iat: now - 60, exp: now + 540, iss: appId };
    const enc = (obj: unknown) =>
      Buffer.from(JSON.stringify(obj)).toString("base64url");
    const data = `${enc(header)}.${enc(payload)}`;
    const key = await crypto.subtle.importKey(
      "pkcs8",
      pemToDer(pem),
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sig = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      key,
      new TextEncoder().encode(data),
    );
    const b64 = Buffer.from(sig).toString("base64url");
    return `${data}.${b64}`;
  } catch {
    return null;
  }
}

function pemToDer(pem: string): ArrayBuffer {
  const b64 = pem
    .replace(/-----BEGIN [A-Z ]+-----/g, "")
    .replace(/-----END [A-Z ]+-----/g, "")
    .replace(/\s+/g, "");
  const raw = Buffer.from(b64, "base64");
  return raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer;
}

// -- Callback helper --------------------------------------------------------

/**
 * Called by /api/connectors/github/callback after the App install. The
 * GitHub installation_id arrives via the redirect query. We exchange for
 * a token, persist it via putSecret, and flip the install to 'active'.
 *
 * Returns the new secret_ref so the route can finalise.
 */
export async function refreshInstallationToken(opts: {
  workspaceId: string;
  installId: string;
  installationId: number;
}): Promise<{ secretRef: string; token: string } | null> {
  if (!Number.isSafeInteger(opts.installationId) || opts.installationId <= 0) {
    return null;
  }
  const tok = await exchangeInstallationToken(opts.installationId);
  if (!tok) return null;
  const secretRef = await putSecret({
    workspaceId: opts.workspaceId,
    connectorId: "github",
    plaintext: tok.token,
  });
  await updateInstall(opts.installId, { secret_ref: secretRef });
  return { secretRef, token: tok.token };
}

export { githubConnector };
