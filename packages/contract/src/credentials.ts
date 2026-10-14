/**
 * Typed credentials — the shape of a `credential` node's `data`.
 *
 * ONE node is ONE credential. A node never holds two platforms' secrets, and
 * never two environments of the same platform: those are separate nodes, told
 * apart by `environment` (dev/prod/…) and by their title. That rule is what
 * makes a credential addressable — `bx://credential/<node_id>#<field_key>` —
 * and what lets a person (or an agent) reason about blast radius when one
 * leaks or is rotated.
 *
 * Storage (`node.data`):
 *
 *   {
 *     credential: { schema_version, type, environment, service, rotated_at, expires_at },
 *     fields: [{ key, name, value, secret }]
 *   }
 *
 * `fields` stays the ONLY home for secret material — it is the single thing
 * every agent-facing serialization redacts (`redactCredentialData`). The
 * `credential` block is metadata: never secret, always visible, so an agent
 * can tell WHICH credential it needs without ever seeing it.
 *
 * `type` picks a template of slots (`CREDENTIAL_TYPES`). Templates are a UI
 * and documentation aid, not a straitjacket: a typed credential may carry
 * extra fields, and `custom` is the escape hatch for the shapes nobody
 * anticipated. A node whose data has no `credential` block is read as
 * `custom` — that is how every credential written before this schema is
 * understood, with no migration required to stay readable.
 */

import { z } from "zod";

export const CREDENTIAL_SCHEMA_VERSION = 1;

/** Where this credential is valid. Closed set — colours and grouping depend on it. */
export const CREDENTIAL_ENVIRONMENTS = ["local", "dev", "staging", "prod"] as const;
export type CredentialEnvironment = (typeof CREDENTIAL_ENVIRONMENTS)[number];

export const CREDENTIAL_ENVIRONMENT_LABELS: Record<CredentialEnvironment, string> = {
  local: "Local",
  dev: "Dev",
  staging: "Staging",
  prod: "Prod",
};

export const CREDENTIAL_TYPE_IDS = [
  "api_key",
  "api_key_pair",
  "basic_auth",
  "bearer_token",
  "oauth2_client",
  "cloud_keys",
  "database",
  "ssh_key",
  "service_account",
  "webhook",
  "custom",
] as const;
export type CredentialTypeId = (typeof CREDENTIAL_TYPE_IDS)[number];

/** One value the credential is made of. `secret: true` is masked everywhere. */
export interface CredentialSlot {
  key: string;
  label: string;
  secret: boolean;
  required: boolean;
  /** Renders as a textarea (PEM keys, JSON blobs). */
  multiline?: boolean;
  placeholder?: string;
  help?: string;
}

export interface CredentialTypeDef {
  id: CredentialTypeId;
  label: string;
  /** One line, shown in the type picker. */
  description: string;
  /** What a good title for this credential looks like. */
  title_hint: string;
  slots: CredentialSlot[];
}

const S = (
  key: string,
  label: string,
  secret: boolean,
  required: boolean,
  extra: Partial<CredentialSlot> = {},
): CredentialSlot => ({ key, label, secret, required, ...extra });

/**
 * The shapes that cover almost everything in practice — the same set every
 * secret manager converges on (1Password, Doppler, Vault, n8n): a single key,
 * a published/secret pair, a login, a token, an OAuth app, cloud keys, a
 * database, an SSH key, a service-account JSON, a webhook secret. `custom` is
 * last, deliberately: it is the edge case, not the default.
 */
export const CREDENTIAL_TYPES: readonly CredentialTypeDef[] = [
  {
    id: "api_key",
    label: "API key",
    description: "A single key sent on every request. The most common shape.",
    title_hint: "Service — API key",
    slots: [
      S("api_key", "API key", true, true, { placeholder: "sk_live_…" }),
      S("base_url", "Base URL", false, false, { placeholder: "https://api.service.com" }),
      S("header_name", "Header", false, false, { placeholder: "Authorization", help: "Header the key travels in, when it is not Authorization." }),
    ],
  },
  {
    id: "api_key_pair",
    label: "API key pair (public + secret)",
    description: "A published/client key alongside the secret one — Stripe, Algolia, most SDKs.",
    title_hint: "Service — API keys",
    slots: [
      S("public_key", "Public / publishable key", false, true, { placeholder: "pk_live_…" }),
      S("secret_key", "Secret key", true, true, { placeholder: "sk_live_…" }),
      S("base_url", "Base URL", false, false),
    ],
  },
  {
    id: "basic_auth",
    label: "Username & password",
    description: "A login: a dashboard, a basic-auth endpoint, an SMTP or FTP account.",
    title_hint: "Service — account",
    slots: [
      S("username", "Username", false, true),
      S("password", "Password", true, true),
      S("url", "URL", false, false, { placeholder: "https://…" }),
      S("totp_secret", "TOTP secret", true, false, { help: "The 2FA seed, if this account has one." }),
    ],
  },
  {
    id: "bearer_token",
    label: "Access token",
    description: "A bearer/personal-access token, usually with an expiry.",
    title_hint: "Service — access token",
    slots: [
      S("token", "Token", true, true),
      S("base_url", "Base URL", false, false),
      S("scopes", "Scopes", false, false, { placeholder: "repo, read:org" }),
    ],
  },
  {
    id: "oauth2_client",
    label: "OAuth 2.0 app",
    description: "Client id + secret for an OAuth app, with its endpoints.",
    title_hint: "Service — OAuth app",
    slots: [
      S("client_id", "Client ID", false, true),
      S("client_secret", "Client secret", true, true),
      S("authorize_url", "Authorize URL", false, false),
      S("token_url", "Token URL", false, false),
      S("redirect_uri", "Redirect URI", false, false),
      S("scopes", "Scopes", false, false),
      S("refresh_token", "Refresh token", true, false),
    ],
  },
  {
    id: "cloud_keys",
    label: "Cloud access keys",
    description: "AWS-shaped: an access key id, its secret, a region.",
    title_hint: "Cloud — access keys",
    slots: [
      S("access_key_id", "Access key ID", false, true, { placeholder: "AKIA…" }),
      S("secret_access_key", "Secret access key", true, true),
      S("region", "Region", false, false, { placeholder: "eu-west-1" }),
      S("account_id", "Account / project", false, false),
      S("session_token", "Session token", true, false),
    ],
  },
  {
    id: "database",
    label: "Database",
    description: "A connection string, or the host/user/password it is built from.",
    title_hint: "Database — role",
    slots: [
      S("connection_url", "Connection URL", true, false, { placeholder: "postgres://user:pass@host:5432/db" }),
      S("host", "Host", false, false),
      S("port", "Port", false, false, { placeholder: "5432" }),
      S("database", "Database", false, false),
      S("username", "Username", false, false),
      S("password", "Password", true, false),
    ],
  },
  {
    id: "ssh_key",
    label: "SSH key",
    description: "A private key (and its passphrase) for a host.",
    title_hint: "Host — SSH key",
    slots: [
      S("private_key", "Private key", true, true, { multiline: true, placeholder: "-----BEGIN OPENSSH PRIVATE KEY-----" }),
      S("passphrase", "Passphrase", true, false),
      S("public_key", "Public key", false, false, { multiline: true }),
      S("host", "Host", false, false),
      S("username", "User", false, false, { placeholder: "root" }),
    ],
  },
  {
    id: "service_account",
    label: "Service account (JSON)",
    description: "A whole JSON key file — Google Cloud, Firebase, a GCP service account.",
    title_hint: "Provider — service account",
    slots: [
      S("service_account_json", "Service account JSON", true, true, { multiline: true, placeholder: "{ \"type\": \"service_account\", … }" }),
      S("client_email", "Client email", false, false),
      S("project_id", "Project", false, false),
    ],
  },
  {
    id: "webhook",
    label: "Webhook",
    description: "A delivery URL and the secret its signatures are verified with.",
    title_hint: "Service — webhook",
    slots: [
      S("url", "Webhook URL", false, true),
      S("signing_secret", "Signing secret", true, true, { placeholder: "whsec_…" }),
    ],
  },
  {
    id: "custom",
    label: "Custom",
    description: "Anything the shapes above do not cover — name every field yourself.",
    title_hint: "Service — credential",
    slots: [],
  },
];

const TYPES_BY_ID = new Map<string, CredentialTypeDef>(CREDENTIAL_TYPES.map((type) => [type.id, type]));

export function isCredentialTypeId(value: unknown): value is CredentialTypeId {
  return typeof value === "string" && TYPES_BY_ID.has(value);
}

export function isCredentialEnvironment(value: unknown): value is CredentialEnvironment {
  return typeof value === "string" && (CREDENTIAL_ENVIRONMENTS as readonly string[]).includes(value);
}

/** Never throws: an unknown id reads as `custom`, the shape that fits everything. */
export function credentialTypeDef(id: unknown): CredentialTypeDef {
  return (isCredentialTypeId(id) ? TYPES_BY_ID.get(id) : undefined) ?? TYPES_BY_ID.get("custom")!;
}

export interface CredentialField {
  /** Slot key when the field fills one of the type's slots; null when free-form. */
  key: string | null;
  /** Human label. For a slot field this is the slot's label. */
  name: string;
  value: string;
  secret: boolean;
}

export interface CredentialMeta {
  schema_version: number;
  type: CredentialTypeId;
  environment: CredentialEnvironment | null;
  /** The platform this belongs to — "Stripe", "Supabase", the VPS's hostname. */
  service: string | null;
  rotated_at: string | null;
  expires_at: string | null;
}

export interface Credential extends CredentialMeta {
  fields: CredentialField[];
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readFields(raw: unknown): CredentialField[] {
  if (!Array.isArray(raw)) return [];
  const out: CredentialField[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name : null;
    const key = typeof record.key === "string" && record.key.trim() ? record.key.trim() : null;
    if (!name && !key) continue;
    out.push({
      key,
      name: name ?? key ?? "",
      value: typeof record.value === "string" ? record.value : "",
      secret: Boolean(record.secret),
    });
  }
  return out;
}

/**
 * Reads any `credential` node's `data` — including one written before this
 * schema existed, which comes back as `custom` with its fields intact.
 */
export function readCredential(data: unknown): Credential {
  const record = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
  const metaRaw = record.credential && typeof record.credential === "object"
    ? (record.credential as Record<string, unknown>)
    : {};
  return {
    schema_version: typeof metaRaw.schema_version === "number" ? metaRaw.schema_version : CREDENTIAL_SCHEMA_VERSION,
    type: isCredentialTypeId(metaRaw.type) ? metaRaw.type : "custom",
    environment: isCredentialEnvironment(metaRaw.environment) ? metaRaw.environment : null,
    service: str(metaRaw.service),
    rotated_at: str(metaRaw.rotated_at),
    expires_at: str(metaRaw.expires_at),
    fields: readFields(record.fields),
  };
}

/** The inverse of `readCredential` — what actually goes into `node.data`. */
export function writeCredential(credential: Credential): Record<string, unknown> {
  return {
    credential: {
      schema_version: CREDENTIAL_SCHEMA_VERSION,
      type: credential.type,
      environment: credential.environment,
      service: credential.service,
      rotated_at: credential.rotated_at,
      expires_at: credential.expires_at,
    },
    fields: credential.fields.map((field) => ({
      ...(field.key ? { key: field.key } : {}),
      name: field.name,
      value: field.value,
      secret: field.secret,
    })),
  };
}

export function emptyCredential(type: CredentialTypeId, environment: CredentialEnvironment | null = null): Credential {
  return {
    schema_version: CREDENTIAL_SCHEMA_VERSION,
    type,
    environment,
    service: null,
    rotated_at: null,
    expires_at: null,
    fields: credentialTypeDef(type).slots
      .filter((slot) => slot.required)
      .map((slot) => ({ key: slot.key, name: slot.label, value: "", secret: slot.secret })),
  };
}

export interface CredentialSlotView extends CredentialSlot {
  value: string;
  /** Index in `credential.fields`, or -1 when the slot is not filled yet. */
  index: number;
}

/**
 * The type's slots with the node's values merged in, followed by whatever
 * fields the node carries that no slot claims. Retyping a credential never
 * drops data: the orphans simply move to the "extra" list.
 */
export function credentialSlotViews(credential: Credential): {
  slots: CredentialSlotView[];
  extra: Array<CredentialField & { index: number }>;
} {
  const def = credentialTypeDef(credential.type);
  const claimed = new Set<number>();
  const slots = def.slots.map((slot) => {
    const index = credential.fields.findIndex(
      (field, i) => !claimed.has(i) && (field.key === slot.key || (!field.key && field.name.toLowerCase() === slot.label.toLowerCase())),
    );
    if (index >= 0) claimed.add(index);
    return { ...slot, value: index >= 0 ? credential.fields[index]!.value : "", index };
  });
  const extra = credential.fields
    .map((field, index) => ({ ...field, index }))
    .filter((field) => !claimed.has(field.index));
  return { slots, extra };
}

/** Required slots that are still empty. Empty array = ready to use. */
export function missingCredentialSlots(credential: Credential): CredentialSlot[] {
  const { slots } = credentialSlotViews(credential);
  return slots.filter((slot) => slot.required && !slot.value.trim());
}

/**
 * `bx://credential/<node_id>#<field_key>` — how a credential is named in
 * prose, in a capability config or in a shell command. A reference is not
 * secret: it says WHICH value is wanted, never the value.
 */
export function credentialRef(nodeId: string, fieldKey: string): string {
  return `bx://credential/${nodeId}#${fieldKey}`;
}

const REF_PATTERN = /^bx:\/\/credential\/([^#\s]+)#([^\s]+)$/;

export function parseCredentialRef(value: string): { nodeId: string; fieldKey: string } | null {
  const match = REF_PATTERN.exec(value.trim());
  return match ? { nodeId: match[1]!, fieldKey: match[2]! } : null;
}

/**
 * Environment-variable name a field is conventionally materialized under —
 * `SERVICE_FIELD`, upper snake case. Used by the shell recipe the MCP hands
 * agents instead of the value.
 */
export function credentialEnvName(credential: Credential, field: { key: string | null; name: string }, fallbackTitle = ""): string {
  const base = credential.service ?? fallbackTitle;
  const slug = (input: string) =>
    input
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-zA-Z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .toUpperCase();
  const prefix = base ? `${slug(base)}_` : "";
  return `${prefix}${slug(field.key ?? field.name)}`.replace(/_{2,}/g, "_").slice(0, 64) || "SECRET";
}

export const REDACTED_VALUE = "[redacted]";

/**
 * The safe-for-agents copy of a credential node's `data`: every value gone,
 * every bit of SHAPE kept — type, environment, service, which fields exist,
 * which are secret, and each field's `ref`. An agent can therefore pick the
 * right credential and hand its reference to something that resolves it,
 * while the value itself never enters the agent's context (and so never
 * enters its transcript, its logs, or a model provider's).
 *
 * Anything in `data` that is neither `credential` nor `fields` is dropped:
 * unstructured keys are not a sanctioned home for credential material, so
 * they are treated as if they held some.
 */
export function redactCredentialData(data: unknown, nodeId?: string): Record<string, unknown> {
  const credential = readCredential(data);
  return {
    credential: {
      schema_version: credential.schema_version,
      type: credential.type,
      environment: credential.environment,
      service: credential.service,
      rotated_at: credential.rotated_at,
      expires_at: credential.expires_at,
    },
    fields: credential.fields.map((field) => ({
      ...(field.key ? { key: field.key } : {}),
      name: field.name,
      secret: field.secret,
      value: REDACTED_VALUE,
      ...(nodeId && field.key ? { ref: credentialRef(nodeId, field.key) } : {}),
    })),
  };
}

/** Runtime validation for a `data` payload written to a credential node. */
export const CredentialDataSchema = z
  .object({
    credential: z
      .object({
        schema_version: z.number().int().optional(),
        type: z.enum(CREDENTIAL_TYPE_IDS).optional(),
        environment: z.enum(CREDENTIAL_ENVIRONMENTS).nullable().optional(),
        service: z.string().max(200).nullable().optional(),
        rotated_at: z.string().max(40).nullable().optional(),
        expires_at: z.string().max(40).nullable().optional(),
      })
      .passthrough()
      .optional(),
    fields: z
      .array(
        z.object({
          key: z.string().max(80).optional(),
          name: z.string().max(200),
          value: z.string().max(100_000),
          secret: z.boolean().optional(),
        }),
      )
      .max(50)
      .optional(),
  })
  .passthrough();
