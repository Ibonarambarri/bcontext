/**
 * Linear connector (first-party OAuth app — not through Nango).
 *
 * Install flow: OAuth against `linear.app/oauth/authorize`. Scopes:
 *   `read,issues:create,write`. We need `write` for two-way sync.
 *
 * Webhook flow: Linear POSTs to `/api/webhooks/linear`. Verified via
 *   HMAC-SHA256 with the workspace webhook secret in the
 *   `Linear-Signature` header.
 *
 * Mapping:
 *   - Issues → `task` nodes.
 *   - Comments → child nodes (`doc`) of the parent task.
 *   - Cycles + milestones stay metadata/tags; connector sync never creates
 *     structural folder nodes.
 *
 * Two-way sync: a Bcontext `task.status` flip is pushed back to Linear via
 *   the GraphQL `issueUpdate` mutation (`pushBcontextStatusToLinear`, called
 *   from `./push` on the node-update route).
 */
import { registerConnector } from "../registry";
import type {
  Connector,
  ContextNodeInput,
  WebhookEnvelope,
  WebhookOutcome,
} from "@bcontext-dev/contract/connectors/types";
import { ConnectorSignatureError } from "@bcontext-dev/contract/connectors/types";
import { appUrl as configuredAppUrl } from "@/lib/env";

interface LinearIssue {
  id: string;
  identifier: string; // "ENG-123"
  title: string;
  description: string | null;
  state: { id: string; name: string; type: string };
  priority?: number;
  assignee?: { name: string } | null;
  url?: string;
  team?: { id: string; key: string };
}

interface LinearComment {
  id: string;
  body: string;
  issue: { id: string; identifier: string };
  user?: { name: string } | null;
}

const linearConnector: Connector = {
  id: "linear",

  async authorize(ctx, phase) {
    if (phase === "start") {
      const clientId = process.env.LINEAR_CLIENT_ID;
      if (!clientId) return {};
      const redirect = `${appUrl()}/api/connectors/linear/callback`;
      const url = new URL("https://linear.app/oauth/authorize");
      url.searchParams.set("client_id", clientId);
      url.searchParams.set("redirect_uri", redirect);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("scope", "read,write,issues:create");
      url.searchParams.set("state", ctx.installId);
      url.searchParams.set("prompt", "consent");
      return { redirectUrl: url.toString() };
    }
    return {};
  },

  async fullSync(ctx) {
    if (!ctx.secret) {
      return {
        processed: 0,
        byKind: {} as Record<string, number>,
        nodes: [],
        hasMore: false,
        cursor: null,
      };
    }
    const issues = await listAssignedIssues(ctx.secret);
    const nodes: ContextNodeInput[] = issues.map(issueToNode);
    return {
      processed: nodes.length,
      byKind: { task: nodes.length } as Record<string, number>,
      nodes,
      hasMore: false,
      cursor: null,
    };
  },

  async handleWebhook(ctx, envelope: WebhookEnvelope): Promise<WebhookOutcome> {
    const installSecret = (ctx.config.webhook_secret as string | undefined) ?? null;
    const secret = installSecret ?? process.env.LINEAR_WEBHOOK_SECRET;
    if (!secret) {
      throw new ConnectorSignatureError("linear webhook secret missing");
    }
    const ok = await verifyLinearSignature(
      secret,
      envelope.rawBody,
      envelope.headers["linear-signature"] ?? "",
    );
    if (!ok) throw new ConnectorSignatureError();

    const payload = JSON.parse(envelope.rawBody) as {
      type: string;
      action: string;
      data: Record<string, unknown>;
    };

    const nodes: ContextNodeInput[] = [];
    if (payload.type === "Issue") {
      const issue = payload.data as unknown as LinearIssue;
      if (payload.action === "remove") {
        // Soft-handle: do nothing — keep the historical node.
        return { nodes, audit: "linear.issue.removed" };
      }
      nodes.push(issueToNode(issue));
    }
    if (payload.type === "Comment") {
      const comment = payload.data as unknown as LinearComment;
      nodes.push(commentToNode(comment));
    }
    return { nodes, audit: `linear.${payload.type}.${payload.action}` };
  },

  toContextNode(_ctx, entity) {
    return issueToNode(entity as unknown as LinearIssue);
  },
};

registerConnector(linearConnector);

// -- Mappers ----------------------------------------------------------------

function issueToNode(issue: LinearIssue): ContextNodeInput {
  const status = mapLinearState(issue.state.type);
  return {
    source: "linear",
    external_id: `issue:${issue.id}`,
    kind: "task",
    title: `${issue.identifier} — ${issue.title}`,
    content_md:
      (issue.description ?? "") +
      (issue.url ? `\n\n---\n_${issue.url}_` : ""),
    status,
    priority: mapLinearPriority(issue.priority ?? 0),
    data: {
      linear_id: issue.id,
      identifier: issue.identifier,
      team: issue.team?.key ?? null,
      assignee: issue.assignee?.name ?? null,
      url: issue.url ?? null,
    },
  };
}

function commentToNode(comment: LinearComment): ContextNodeInput {
  return {
    source: "linear",
    external_id: `comment:${comment.id}`,
    kind: "doc",
    title: `Comment on ${comment.issue.identifier}`,
    content_md: comment.body,
    data: {
      linear_id: comment.id,
      issue_id: comment.issue.id,
      issue_identifier: comment.issue.identifier,
      author: comment.user?.name ?? null,
    },
  };
}

function mapLinearState(type: string): string {
  switch (type) {
    case "backlog":
      return "backlog";
    case "unstarted":
      return "todo";
    case "started":
      return "in_progress";
    case "completed":
      return "done";
    case "canceled":
      return "done";
    default:
      return "todo";
  }
}

function mapLinearPriority(n: number): string {
  switch (n) {
    case 1:
      return "urgent";
    case 2:
      return "high";
    case 3:
      return "med";
    case 4:
      return "low";
    default:
      return "low";
  }
}

// -- GraphQL ----------------------------------------------------------------

const LINEAR_API = "https://api.linear.app/graphql";

async function listAssignedIssues(token: string): Promise<LinearIssue[]> {
  const query = `
    query Bcontext {
      viewer {
        assignedIssues(first: 100, filter: { state: { type: { in: ["backlog","unstarted","started"] } } }) {
          nodes {
            id identifier title description priority url
            state { id name type }
            assignee { name }
            team { id key }
          }
        }
      }
    }
  `;
  const res = await fetch(LINEAR_API, {
    method: "POST",
    headers: {
      Authorization: token.startsWith("lin_") ? token : `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) return [];
  const json = (await res.json()) as {
    data?: { viewer?: { assignedIssues?: { nodes?: LinearIssue[] } } };
  };
  return json.data?.viewer?.assignedIssues?.nodes ?? [];
}

/**
 * Two-way sync helper. Call this from the Bcontext → Linear push path
 * (subscribed via the outbound-webhook system on `node.updated`).
 */
export async function pushBcontextStatusToLinear(opts: {
  token: string;
  linearIssueId: string;
  status: string;
}): Promise<boolean> {
  const stateType = bcontextStatusToLinearStateType(opts.status);
  if (!stateType) return false;

  // Resolve the state id for the issue's team.
  const stateRes = await fetch(LINEAR_API, {
    method: "POST",
    headers: {
      Authorization: opts.token.startsWith("lin_") ? opts.token : `Bearer ${opts.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query: `query StateFor($id: String!, $type: String!) {
        issue(id: $id) { team { id states(filter: { type: { eq: $type } }, first: 1) { nodes { id } } } }
      }`,
      variables: { id: opts.linearIssueId, type: stateType },
    }),
  });
  if (!stateRes.ok) return false;
  const stateJson = (await stateRes.json()) as {
    data?: { issue?: { team?: { states?: { nodes?: Array<{ id: string }> } } } };
  };
  const stateId = stateJson.data?.issue?.team?.states?.nodes?.[0]?.id;
  if (!stateId) return false;

  const updRes = await fetch(LINEAR_API, {
    method: "POST",
    headers: {
      Authorization: opts.token.startsWith("lin_") ? opts.token : `Bearer ${opts.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query: `mutation($id: String!, $stateId: String!) {
        issueUpdate(id: $id, input: { stateId: $stateId }) { success }
      }`,
      variables: { id: opts.linearIssueId, stateId },
    }),
  });
  return updRes.ok;
}

function bcontextStatusToLinearStateType(status: string): string | null {
  switch (status) {
    case "backlog":
      return "backlog";
    case "todo":
      return "unstarted";
    case "in_progress":
      return "started";
    case "review":
      return "started";
    case "blocked":
      return "started";
    case "done":
      return "completed";
    default:
      return null;
  }
}

// -- Signature --------------------------------------------------------------

export async function verifyLinearSignature(
  secret: string,
  rawBody: string,
  header: string,
): Promise<boolean> {
  if (!header) return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(rawBody));
  const hex = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return timingSafeEqual(hex, header);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function appUrl(): string {
  return (
    configuredAppUrl() ?? "http://localhost:3000"
  );
}

export { linearConnector };
