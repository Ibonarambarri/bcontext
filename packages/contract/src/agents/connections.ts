/**
 * How an agent connection is described to people: the provider it identifies
 * as (guessed from the OAuth client name on the consent page), the role
 * presets (observer / collaborator / operator) and the scope set each one
 * expands to. The API mints tokens from `scopesForRole`; the web labels
 * existing grants with `roleForScopes` — a grant whose scopes match no preset
 * is `custom`.
 */
import { parseScopes, type Scope } from "../auth/scopes.js";

export const AGENT_PROVIDERS = [
  "codex",
  "claude_code",
  "hermes",
  "openclaw",
  "other",
] as const;
export type AgentProvider = (typeof AGENT_PROVIDERS)[number];

export const AGENT_ROLES = [
  "observer",
  "collaborator",
  "operator",
  "custom",
] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];

export const ROLE_SCOPES: Record<Exclude<AgentRole, "custom">, Scope[]> = {
  observer: ["nodes:read", "agents:read"],
  collaborator: ["nodes:read", "nodes:write", "agents:read", "agents:write"],
  operator: [
    "nodes:read",
    "nodes:write",
    "agents:read",
    "agents:write",
    "chat:run",
    "skills:execute",
  ],
};

export function detectAgentProvider(clientName: string): AgentProvider {
  const normalized = clientName.toLowerCase();
  if (normalized.includes("claude")) return "claude_code";
  if (normalized.includes("codex")) return "codex";
  if (normalized.includes("hermes")) return "hermes";
  if (normalized.includes("openclaw") || normalized.includes("open claw")) {
    return "openclaw";
  }
  return "other";
}

export function scopesForRole(
  role: AgentRole,
  requested: readonly Scope[],
  custom: readonly Scope[] = [],
): Scope[] {
  const requestedSet = new Set(requested);
  const source = role === "custom" ? custom : ROLE_SCOPES[role];
  return parseScopes(source.filter((scope) => requestedSet.has(scope)));
}

/**
 * Normalize a client-submitted role against the exact scope selection.
 * A preset role is only kept when the scopes match its preset exactly —
 * anything else collapses to `custom` so the stored role never overstates
 * (or understates) what the credential can do. With no submitted role the
 * role is derived from the scopes.
 */
export function normalizeRole(
  role: AgentRole | null | undefined,
  scopes: readonly Scope[],
): AgentRole {
  if (!role) return roleForScopes(scopes);
  if (role === "custom") return "custom";
  const preset = ROLE_SCOPES[role];
  const matches =
    preset.length === scopes.length &&
    preset.every((scope) => scopes.includes(scope));
  return matches ? role : "custom";
}

export function roleForScopes(scopes: readonly Scope[]): AgentRole {
  if (scopes.includes("chat:run") || scopes.includes("skills:execute")) return "operator";
  if (scopes.includes("nodes:write") || scopes.includes("agents:write")) return "collaborator";
  if (scopes.every((scope) => ROLE_SCOPES.observer.includes(scope))) return "observer";
  return "custom";
}

export function providerLabel(provider: AgentProvider, custom?: string | null): string {
  if (provider === "claude_code") return "Claude Code";
  if (provider === "openclaw") return "OpenClaw";
  if (provider === "codex") return "Codex";
  if (provider === "hermes") return "Hermes";
  return custom?.trim() || "Other";
}
