/**
 * `GET /api/credentials/:nodeId/materialize` — the ONE place a credential's
 * plaintext leaves Bcontext for a machine.
 *
 * Why it is not an MCP tool. Everything an MCP tool returns is written into
 * the client's transcript on disk, replayed to the model provider on every
 * subsequent turn, and often summarised into a log. A secret that an agent
 * *reads* has been copied to places nobody rotates. So the agent never reads
 * it: it reads the credential's SHAPE over MCP (type, fields, `bx://` refs,
 * all values `[redacted]`) and then materialises the value into a process it
 * starts, in one command whose output it never prints:
 *
 *   STRIPE_SECRET_KEY=$(curl -sS -H "Authorization: Bearer $BCONTEXT_MCP_TOKEN" \
 *     "$BCONTEXT_API/api/credentials/<node>/materialize?workspace=<ws>&field=secret_key") \
 *     node scripts/charge.js
 *
 * The command line is logged; the substitution's output is not. Same idea as
 * `op run` / `doppler run`.
 *
 * Guards: `credentials:use` — a scope `admin:*` deliberately does NOT grant
 * (see contract `auth/scopes`) — plus the workspace grant's read reach. Every
 * call is audited by node id and field key; the value is never in the audit
 * row, the URL, the logs or the error reporter. Responses are `no-store` and
 * `text/plain`, never JSON, so nothing downstream is tempted to pretty-print
 * one into a trace.
 */
import { appendAudit, type ActorType } from "@/lib/audit";
import { openWorkspace } from "@/lib/auth/workspace";
import { withRoute } from "@/lib/route";
import {
  credentialEnvName,
  readCredential,
  type CredentialField,
} from "@bcontext-dev/contract/credentials";

const SECRET_HEADERS = {
  "Content-Type": "text/plain; charset=utf-8",
  "Cache-Control": "no-store, no-cache, must-revalidate, private",
  Pragma: "no-cache",
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "noindex, nofollow",
  // Nothing downstream should keep this around: no shared cache, no CDN.
  Vary: "Authorization",
} as const;

function actorType(kind: string): ActorType {
  if (kind === "agent" || kind === "agent_user") return "agent";
  if (kind === "user") return "user";
  return "demo";
}

/** POSIX-safe single-quoted dotenv line — the value is never interpolated. */
function envLine(name: string, value: string): string {
  return `${name}='${value.replace(/'/g, `'\\''`)}'`;
}

export const GET = withRoute(async (
  req: Request,
  { params }: { params: Promise<{ nodeId: string }> },
) => {
  const url = new URL(req.url);
  const ctx = await openWorkspace(req, url.searchParams.get("workspace"), "read", {
    scope: "credentials:use",
  });
  if (ctx instanceof Response) return ctx;
  const { nodeId } = await params;
  const node = await ctx.storage.getNode(nodeId);
  // A non-credential node is "not found" here rather than "wrong kind": this
  // endpoint should never confirm what else lives at an id.
  if (!node || node.kind !== "credential") {
    return Response.json({ error: "not found" }, { status: 404 });
  }

  const credential = readCredential(node.data);
  const fieldKey = url.searchParams.get("field")?.trim() || null;
  const format = url.searchParams.get("format") === "env" ? "env" : "raw";

  const matches = (field: CredentialField) =>
    field.key === fieldKey || field.name.toLowerCase() === fieldKey?.toLowerCase();
  const selected = fieldKey ? credential.fields.filter(matches) : credential.fields;

  if (fieldKey && selected.length === 0) {
    return Response.json(
      {
        error: "unknown_field",
        // Field NAMES are not secret — telling the caller which keys exist is
        // how it fixes its own call without a second round trip through MCP.
        fields: credential.fields.map((field) => field.key ?? field.name),
      },
      { status: 404 },
    );
  }
  if (!fieldKey && format !== "env") {
    return Response.json(
      { error: "field_required", message: "pass ?field=<key>, or ?format=env for the whole credential" },
      { status: 400 },
    );
  }

  const auditActor = ctx.actor;
  void appendAudit({
    workspaceId: ctx.storage.workspace.id,
    actorType: actorType(auditActor.kind),
    actorId: "userId" in auditActor ? auditActor.userId ?? null : null,
    agentTokenId: "tokenId" in auditActor ? auditActor.tokenId ?? null : null,
    action: "credential.materialize",
    targetType: "node",
    targetId: node.id,
    // Keys and counts only. The audit log is readable by every workspace
    // member; it records THAT a secret was used, never which bytes.
    input: { field: fieldKey, format, fields: selected.length },
  });

  const body = format === "env"
    ? selected
        .map((field) => envLine(credentialEnvName(credential, field, node.title), field.value))
        .join("\n")
    : selected[0]!.value;

  return new Response(body, { status: 200, headers: SECRET_HEADERS });
});
