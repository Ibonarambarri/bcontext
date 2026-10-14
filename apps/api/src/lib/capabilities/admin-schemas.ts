/**
 * Request schemas for capability administration — register/update a
 * capability and its connection, create bundles and grants. Shared by the
 * REST routes under `/api/capabilities*` and the MCP admin path
 * (`mcp-admin.ts`) so both surfaces validate identically.
 *
 * The refinements are the security rules a maintainer must keep: HTTPS
 * only, the endpoint host must appear in `allowedHosts` (the egress pin
 * list), a static credential (`secret`) travels write-only and exactly when
 * the auth type needs one — it is stored in Vault by the caller and never
 * read back — OAuth needs a completed attempt, and managed OAuth exists only
 * for MCP servers.
 */
import { z } from "zod";
import {
  CapabilityTypeSchema,
  ExecutableContractSchema,
} from "./types";

const KeySchema = z.string().regex(/^[a-z][a-z0-9_-]{1,62}$/);
/**
 * The token the admin pastes for bearer/header auth. Write-only: it is
 * accepted here, handed to Vault, and replaced by a `vault:<uuid>` ref on the
 * connection row; no read path ever returns it.
 */
const SecretSchema = z.string().min(1).max(4096);

export const CapabilityConnectionInputSchema = z.object({
  endpointUrl: z.string().url().refine((value) => new URL(value).protocol === "https:", "HTTPS required"),
  authType: z.enum(["none", "oauth", "bearer", "header"]).default("none"),
  authHeaderName: z.string().min(1).max(100).optional(),
  secret: SecretSchema.optional(),
  oauthAttemptId: z.string().uuid().optional(),
  allowedHosts: z.array(z.string().min(1).max(253)).min(1).max(20),
  timeoutMs: z.number().int().min(1000).max(55000).default(15000),
}).superRefine((value, ctx) => {
  const endpointHost = new URL(value.endpointUrl).hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!value.allowedHosts.some((host) => host.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "") === endpointHost)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["allowedHosts"], message: "must include the endpoint host" });
  }
  if (value.authType === "none" && (value.secret || value.authHeaderName || value.oauthAttemptId)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["authType"], message: "none auth cannot carry credential fields" });
  }
  if ((value.authType === "bearer" || value.authType === "header") && !value.secret) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["secret"], message: "credential required" });
  }
  if (value.authType === "oauth" && !value.oauthAttemptId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["oauthAttemptId"], message: "completed OAuth authorization required" });
  }
  if (value.authType === "oauth" && value.secret) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["secret"], message: "managed OAuth cannot carry a static secret" });
  }
  if (value.authType !== "oauth" && value.oauthAttemptId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["oauthAttemptId"], message: "OAuth attempt is only valid for OAuth auth" });
  }
  if (value.authType === "header" && !value.authHeaderName) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["authHeaderName"], message: "header name required" });
  }
  if (value.authType !== "header" && value.authType !== "none" && value.authHeaderName) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["authHeaderName"], message: "header name is only valid for header auth" });
  }
});

const UpdateCapabilityConnectionInputSchema = z.object({
  endpointUrl: z.string().url().refine((value) => new URL(value).protocol === "https:", "HTTPS required"),
  authType: z.enum(["none", "oauth", "bearer", "header"]),
  authHeaderName: z.string().min(1).max(100).optional(),
  credentialMode: z.enum(["preserve", "replace"]),
  secret: SecretSchema.optional(),
  oauthAttemptId: z.string().uuid().optional(),
  allowedHosts: z.array(z.string().min(1).max(253)).min(1).max(20),
  timeoutMs: z.number().int().min(1000).max(55000).default(15000),
}).superRefine((value, ctx) => {
  const endpointHost = new URL(value.endpointUrl).hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!value.allowedHosts.some((host) => host.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "") === endpointHost)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["allowedHosts"], message: "must include the endpoint host" });
  }
  if (value.credentialMode === "preserve" && (value.secret || value.oauthAttemptId || value.authType === "none")) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["credentialMode"], message: "credential cannot be preserved for this configuration" });
  }
  if (value.authType === "none" && (value.secret || value.authHeaderName || value.oauthAttemptId)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["authType"], message: "none auth cannot carry credential fields" });
  }
  if (value.authType === "oauth") {
    if (value.secret || value.authHeaderName) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["authType"], message: "managed OAuth cannot carry static credential fields" });
    }
    if (value.credentialMode === "replace" && !value.oauthAttemptId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["oauthAttemptId"], message: "completed OAuth authorization required" });
    }
  } else if (value.oauthAttemptId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["oauthAttemptId"], message: "OAuth attempt is only valid for OAuth auth" });
  }
  if (value.authType === "bearer" || value.authType === "header") {
    if (value.credentialMode === "replace" && !value.secret) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["secret"], message: "credential required" });
    }
  }
  if (value.authType === "header" && !value.authHeaderName) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["authHeaderName"], message: "header name required" });
  }
  if (value.authType !== "header" && value.authHeaderName) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["authHeaderName"], message: "header name is only valid for header auth" });
  }
});

export const RegisterCapabilityInputSchema = z.object({
  workspace_id: z.string().uuid(),
  key: KeySchema,
  type: CapabilityTypeSchema,
  provider: z.string().trim().min(1).max(100),
  title: z.string().trim().min(1).max(200),
  description: z.string().max(4000).default(""),
  provenance: z.record(z.unknown()).default({}),
  environment: z.string().min(1).max(50).default("production"),
  contract: z.record(z.unknown()),
  change_summary: z.string().max(1000).optional(),
  status: z.enum(["draft", "approved"]).default("draft"),
  connection: CapabilityConnectionInputSchema.optional(),
}).superRefine((value, ctx) => {
  const executable = value.type === "mcp_server" || value.type === "api" || value.type === "workflow";
  if (executable && !value.connection) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["connection"], message: "executable capabilities require a connection" });
  }
  if (executable) {
    const result = ExecutableContractSchema.safeParse(value.contract);
    if (!result.success) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["contract"], message: result.error.message });
    } else if (value.type === "mcp_server" && result.data.protocol !== "mcp_streamable_http") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["contract", "protocol"], message: "mcp_server requires mcp_streamable_http" });
    } else if ((value.type === "api" || value.type === "workflow") && result.data.protocol !== "webhook") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["contract", "protocol"], message: "api/workflow requires webhook" });
    }
  }
  if (value.connection?.authType === "oauth" && value.type !== "mcp_server") {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["connection", "authType"], message: "OAuth is supported only for MCP servers" });
  }
});

export const UpdateCapabilityInputSchema = z.object({
  workspace_id: z.string().uuid(),
  id: z.string().uuid(),
  status: z.enum(["draft", "approved", "deprecated", "disabled"]),
});

export const UpdateCapabilityProviderInputSchema = z.object({
  workspace_id: z.string().uuid(),
  expected_updated_at: z.string().datetime({ offset: true }),
  type: z.enum(["mcp_server", "api", "workflow"]),
  provider: z.string().trim().min(1).max(100),
  title: z.string().trim().min(1).max(200),
  description: z.string().max(4000).default(""),
  provenance: z.record(z.unknown()).default({}),
  environment: z.string().min(1).max(50).default("production"),
  contract: z.record(z.unknown()),
  connection: UpdateCapabilityConnectionInputSchema,
}).superRefine((value, ctx) => {
  const result = ExecutableContractSchema.safeParse(value.contract);
  if (!result.success) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["contract"], message: result.error.message });
  } else if (value.type === "mcp_server" && result.data.protocol !== "mcp_streamable_http") {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["contract", "protocol"], message: "mcp_server requires mcp_streamable_http" });
  } else if ((value.type === "api" || value.type === "workflow") && result.data.protocol !== "webhook") {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["contract", "protocol"], message: "api/workflow requires webhook" });
  }
  if (value.connection.authType === "oauth" && value.type !== "mcp_server") {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["connection", "authType"], message: "OAuth is supported only for MCP servers" });
  }
});

export const CreateBundleInputSchema = z.object({
  workspace_id: z.string().uuid(),
  key: KeySchema,
  title: z.string().trim().min(1).max(200),
  description: z.string().max(4000).default(""),
  capability_version_ids: z.array(z.string().uuid()).min(1).max(50),
  status: z.enum(["draft", "approved"]).default("draft"),
});

export const CreateGrantInputSchema = z.object({
  workspace_id: z.string().uuid(),
  principal: z.object({
    kind: z.enum(["user", "agent", "team", "service_account"]),
    source_type: z.enum(["user", "agent", "agent_token", "team", "service_account"]),
    source_id: z.string().min(1).max(200).optional(),
    display_name: z.string().trim().min(1).max(200),
  }),
  capability_id: z.string().uuid().optional(),
  bundle_id: z.string().uuid().optional(),
  actions: z.array(z.enum(["discover", "invoke", "admin"])).min(1).default(["discover", "invoke"]),
  constraints: z.record(z.unknown()).default({}),
  expires_at: z.string().datetime().optional(),
}).refine((value) => Number(Boolean(value.capability_id)) + Number(Boolean(value.bundle_id)) === 1, {
  message: "exactly one of capability_id or bundle_id is required",
});
