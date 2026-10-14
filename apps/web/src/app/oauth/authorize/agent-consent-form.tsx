"use client";

/**
 * The OAuth consent form, mounted by `/oauth/authorize` once the client and
 * the person are validated.
 *
 * A plain POST form (no fetch): the browser submits straight to
 * `/api/oauth/authorize`, which Next proxies to the API, so every control's
 * `name` is part of that route's contract — the hidden OAuth params travel
 * unchanged and the person's choices ride as ordinary form fields. Visuals
 * follow the app's HeroUI token bridge (--paper/--ink/--line aliases).
 *
 * With `workspaceLocked` the client came in through a workspace endpoint
 * (`resource=…/mcp/<org>/<workspace>`): the page passes that one workspace
 * only and the section shows it as a fact, not a choice — the API requires
 * `workspace_ids` to be exactly that workspace for such a `resource`.
 */


import { useMemo, useState } from "react";
import { Bot, Check, KeyRound, ShieldCheck, Workflow } from "lucide-react";
import { Chip } from "@heroui/react";
import type { Scope } from "@bcontext-dev/contract/auth/scopes";
import type { AgentProvider, AgentRole } from "@bcontext-dev/contract/agents/connections";
import { CONSENT_ROLES, initialConsentScopes } from "./consent-config";

interface WorkspaceOption {
  id: string;
  name: string;
  slug: string;
}

interface Props {
  oauth: {
    clientId: string;
    redirectUri: string;
    scope: string;
    state: string;
    codeChallenge: string;
    codeChallengeMethod: string;
    /** The MCP server URL the client asked for (RFC 8707); forwarded as sent. */
    resource: string | null;
  };
  clientName: string;
  userEmail: string | null;
  workspaces: WorkspaceOption[];
  defaultWorkspaceId: string;
  /** The workspace is decided by the endpoint the client connected through. */
  workspaceLocked: boolean;
  defaultProvider: AgentProvider;
  requestedScopes: Scope[];
}

const PROVIDERS: Array<{ value: AgentProvider; label: string }> = [
  { value: "codex", label: "Codex" },
  { value: "claude_code", label: "Claude Code" },
  { value: "hermes", label: "Hermes" },
  { value: "openclaw", label: "OpenClaw" },
  { value: "other", label: "Other" },
];

export function AgentConsentForm(props: Props) {
  const [provider, setProvider] = useState<AgentProvider>(props.defaultProvider);
  const [role, setRole] = useState<AgentRole>("collaborator");
  const initialScopes = useMemo(
    () => initialConsentScopes("collaborator", props.requestedScopes),
    [props.requestedScopes],
  );
  const [scopes, setScopes] = useState<Set<Scope>>(new Set(initialScopes));

  function chooseRole(nextRole: AgentRole) {
    setRole(nextRole);
    if (nextRole === "custom") return;
    setScopes(new Set(initialConsentScopes(nextRole, props.requestedScopes)));
  }

  function toggleScope(scope: Scope) {
    setRole("custom");
    setScopes((current) => {
      const next = new Set(current);
      if (next.has(scope)) next.delete(scope);
      else next.add(scope);
      return next;
    });
  }

  return (
    <form action="/api/oauth/authorize" method="post" className="mt-7 flex flex-col gap-4">
      <input type="hidden" name="client_id" value={props.oauth.clientId} />
      <input type="hidden" name="redirect_uri" value={props.oauth.redirectUri} />
      <input type="hidden" name="scope" value={props.oauth.scope} />
      <input type="hidden" name="state" value={props.oauth.state} />
      <input type="hidden" name="code_challenge" value={props.oauth.codeChallenge} />
      <input type="hidden" name="code_challenge_method" value={props.oauth.codeChallengeMethod} />
      {props.oauth.resource ? <input type="hidden" name="resource" value={props.oauth.resource} /> : null}
      <input type="hidden" name="role" value={role} />

      <ConsentSection number="01" title="Agent identity" icon={Bot}>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Agent name" className="col-span-2">
            <input
              name="agent_name"
              defaultValue={props.clientName}
              required
              maxLength={80}
              placeholder="e.g. Claude Code · backend"
              className="h-9 rounded-[9px] border border-[var(--line)] bg-[var(--paper)] px-3 text-[13px] text-[var(--ink)] outline-none transition-colors focus:border-[var(--line-strong)]"
            />
          </Field>
          <Field label="Provider">
            <select
              name="provider"
              value={provider}
              onChange={(event) => setProvider(event.target.value as AgentProvider)}
              className="h-9 rounded-[9px] border border-[var(--line)] bg-[var(--paper)] px-2.5 text-[13px] text-[var(--ink)] outline-none"
            >
              {PROVIDERS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
            </select>
          </Field>
          <Field label={provider === "other" ? "Provider name" : "Connected account"}>
            <input
              name="provider_label"
              defaultValue={provider === "other" ? props.clientName : props.userEmail ?? ""}
              disabled={provider !== "other"}
              maxLength={80}
              className="h-9 rounded-[9px] border border-[var(--line)] bg-[var(--paper)] px-3 text-[13px] text-[var(--ink)] outline-none disabled:text-[var(--ink-3)]"
            />
          </Field>
          <Field label="Objective · optional" className="col-span-2">
            <input
              name="description"
              maxLength={240}
              placeholder="What this agent is responsible for"
              className="h-9 rounded-[9px] border border-[var(--line)] bg-[var(--paper)] px-3 text-[13px] text-[var(--ink)] outline-none transition-colors focus:border-[var(--line-strong)]"
            />
          </Field>
        </div>
      </ConsentSection>

      <ConsentSection
        number="02"
        title="Workspace access"
        icon={Workflow}
        badge={props.workspaceLocked ? "Set by endpoint" : undefined}
      >
        {props.workspaceLocked ? (
          <LockedWorkspace workspace={props.workspaces[0]!} />
        ) : (
          <>
            <p className="mb-3 text-[11.5px] leading-relaxed text-[var(--ink-3)]">
              Select explicit workspaces. New workspaces are never added automatically.
            </p>
            <div className="grid gap-2 sm:grid-cols-2">
              {props.workspaces.map((workspace) => (
                <label
                  key={workspace.id}
                  className="flex cursor-pointer items-start gap-2.5 rounded-[10px] border border-[var(--line)] bg-[var(--paper)] p-3 text-[13px] transition-colors hover:bg-[var(--paper-2)] has-[:checked]:border-[var(--ink)] has-[:checked]:bg-[var(--paper-2)]"
                >
                  <input
                    type="checkbox"
                    name="workspace_ids"
                    value={workspace.id}
                    defaultChecked={workspace.id === props.defaultWorkspaceId}
                    className="mt-0.5 accent-[var(--accent)]"
                  />
                  <span className="min-w-0">
                    <span className="block truncate font-medium text-[var(--ink)]">{workspace.name}</span>
                    <span className="font-mono text-[10.5px] text-[var(--ink-3)]">/{workspace.slug}</span>
                  </span>
                </label>
              ))}
            </div>
          </>
        )}
      </ConsentSection>

      <ConsentSection number="03" title="Role" icon={ShieldCheck}>
        <div className="grid gap-2 sm:grid-cols-2">
          {CONSENT_ROLES.map((item) => {
            const active = item.value === role;
            return (
              <button
                key={item.value}
                type="button"
                onClick={() => chooseRole(item.value)}
                aria-pressed={active}
                className={`flex min-h-[76px] items-start gap-2.5 rounded-[10px] border p-3 text-left transition-colors ${active ? "border-[var(--ink)] bg-[var(--paper-2)]" : "border-[var(--line)] bg-[var(--paper)] hover:bg-[var(--paper-2)]"}`}
              >
                <span className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${active ? "border-[var(--ink)] bg-[var(--ink)] text-[var(--paper)]" : "border-[var(--line-strong)]"}`}>
                  {active ? <Check size={10} /> : null}
                </span>
                <span>
                  <span className="block text-[12.5px] font-medium text-[var(--ink)]">{item.label}</span>
                  <span className="mt-0.5 block text-[11px] leading-relaxed text-[var(--ink-3)]">{item.description}</span>
                </span>
              </button>
            );
          })}
        </div>
      </ConsentSection>

      <ConsentSection number="04" title="Permissions" icon={KeyRound}>
        <p className="mb-3 text-[11.5px] leading-relaxed text-[var(--ink-3)]">
          {props.clientName} requested {props.requestedScopes.length} scope{props.requestedScopes.length === 1 ? "" : "s"}. Untick anything the agent shouldn&apos;t have — you can change this later from Agents.
        </p>
        <div className="flex flex-wrap gap-2">
          {props.requestedScopes.map((scope) => {
            const active = scopes.has(scope);
            return (
              <label
                key={scope}
                className={`flex cursor-pointer items-center gap-1.5 rounded-full border px-3 py-1.5 font-mono text-[10.5px] transition-colors ${active ? "border-[var(--ink)] bg-[var(--paper-2)] text-[var(--ink)]" : "border-[var(--line)] bg-[var(--paper)] text-[var(--ink-3)] hover:bg-[var(--paper-2)]"}`}
              >
                <input
                  type="checkbox"
                  name="scopes"
                  value={scope}
                  checked={active}
                  onChange={() => toggleScope(scope)}
                  className="sr-only"
                />
                {active ? <Check size={10} /> : null}
                {scope}
              </label>
            );
          })}
        </div>
        <p className="mt-3 text-[11px] leading-relaxed text-[var(--ink-3)]">
          External MCP tools and workflows are granted separately from Tools after the agent is connected.
        </p>
      </ConsentSection>

      <div className="mt-1 flex flex-col gap-2 sm:flex-row">
        <button
          type="submit"
          name="decision"
          value="allow"
          disabled={scopes.size === 0}
          className="inline-flex flex-1 items-center justify-center gap-2 rounded-[10px] bg-[var(--accent)] px-4 py-2.5 text-[13px] font-medium text-[var(--accent-ink)] transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          <ShieldCheck size={14} /> Connect agent
        </button>
        <button
          type="submit"
          name="decision"
          value="deny"
          className="inline-flex items-center justify-center rounded-[10px] border border-[var(--line)] bg-[var(--paper)] px-4 py-2.5 text-[13px] text-[var(--ink-2)] transition-colors hover:bg-[var(--paper-2)] hover:text-[var(--ink)]"
        >
          Cancel
        </button>
      </div>
      {scopes.size === 0 ? (
        <p className="text-center text-[11px] text-[var(--ink-3)]">Select at least one permission to connect the agent.</p>
      ) : null}
    </form>
  );
}

/**
 * The workspace a workspace endpoint decided. A disabled checkbox would not
 * submit, so the id rides in a hidden field and the card is plain display.
 */
function LockedWorkspace({ workspace }: { workspace: WorkspaceOption }) {
  return (
    <>
      <input type="hidden" name="workspace_ids" value={workspace.id} />
      <div className="flex items-start gap-2.5 rounded-[10px] border border-[var(--ink)] bg-[var(--paper)] p-3 text-[13px]">
        <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-[var(--ink)] bg-[var(--ink)] text-[var(--paper)]">
          <Check size={10} />
        </span>
        <span className="min-w-0">
          <span className="block truncate font-medium text-[var(--ink)]">{workspace.name}</span>
          <span className="font-mono text-[10.5px] text-[var(--ink-3)]">/{workspace.slug}</span>
        </span>
      </div>
      <p className="mt-3 text-[11.5px] leading-relaxed text-[var(--ink-3)]">
        This client will be connected to{" "}
        <span className="font-mono text-[var(--ink-2)]">{workspace.slug}</span> only: it came in
        through that workspace&apos;s endpoint and its token is bound to it. Connect through{" "}
        <span className="font-mono">/mcp</span> to grant several workspaces at once.
      </p>
    </>
  );
}

function ConsentSection({
  number,
  title,
  icon: Icon,
  children,
  badge,
}: {
  number: string;
  title: string;
  icon: typeof Bot;
  children: React.ReactNode;
  badge?: string;
}) {
  return (
    <fieldset className="rounded-[14px] border border-[var(--line)] bg-[var(--paper-2)] p-4 sm:p-5">
      <legend className="flex items-center gap-2 px-1 font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--ink-3)]">
        <span>{number}</span>
        <Icon size={11} />
        <span>{title}</span>
        {badge ? (
          <Chip size="sm" variant="soft" color="accent" className="ml-1 text-[9.5px]">
            {badge}
          </Chip>
        ) : null}
      </legend>
      {children}
    </fieldset>
  );
}

function Field({ label, className = "", children }: { label: string; className?: string; children: React.ReactNode }) {
  return (
    <label className={`flex flex-col gap-1.5 text-[11px] text-[var(--ink-3)] ${className}`}>
      {label}
      {children}
    </label>
  );
}
