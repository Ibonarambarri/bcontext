/**
 * Pure configuration for the OAuth consent screen — the step where an
 * OAuth-connected agent gets its full configuration (identity, workspaces,
 * role, permissions). Kept free of JSX so the role/scope logic is testable
 * and stays in lockstep with the canonical presets in
 * `@bcontext-dev/contract/agents/connections`.

 */
import { ROLE_SCOPES, type AgentRole } from "@bcontext-dev/contract/agents/connections";
import type { Scope } from "@bcontext-dev/contract/auth/scopes";

export interface ConsentRole {
  value: AgentRole;
  label: string;
  description: string;
  scopes: readonly Scope[];
}

export const CONSENT_ROLES: readonly ConsentRole[] = [
  {
    value: "observer",
    label: "Observer",
    description: "Read and search workspace context.",
    scopes: ROLE_SCOPES.observer,
  },
  {
    value: "collaborator",
    label: "Collaborator",
    description: "Read context and create or update knowledge.",
    scopes: ROLE_SCOPES.collaborator,
  },
  {
    value: "operator",
    label: "Operator",
    description: "Collaborate, run chat and execute approved skills.",
    scopes: ROLE_SCOPES.operator,
  },
  {
    value: "custom",
    label: "Custom",
    description: "Choose individual permissions.",
    scopes: [],
  },
];

/**
 * Scopes a role preset grants on the consent screen: the preset intersected
 * with what the client actually requested. A preset can never re-add a scope
 * the client did not ask for; `custom` starts empty.
 */
export function initialConsentScopes(
  role: AgentRole,
  requested: readonly Scope[],
): Scope[] {
  const requestedSet = new Set(requested);
  const preset = CONSENT_ROLES.find((item) => item.value === role)?.scopes ?? [];
  return preset.filter((scope) => requestedSet.has(scope));
}
