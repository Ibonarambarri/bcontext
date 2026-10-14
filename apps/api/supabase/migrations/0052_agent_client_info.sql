-- 0052_agent_client_info.sql
--
-- Persist the MCP `initialize` clientInfo on the durable agent identity so
-- the Agents page can attribute a connection to its real runtime (Claude
-- Code, Cursor, Windsurf, …) instead of guessing from the display name.
--
-- The /mcp route already writes these columns best-effort (silently a no-op
-- until this migration is applied). src/lib/agent-providers.tsx matches
-- client_name against its registry to pick the provider logo.
--
-- NOTE: created as a file only — apply through the normal migration flow,
-- not ad hoc against the remote DB.

alter table public.agents
  add column if not exists client_name text,
  add column if not exists client_version text;

comment on column public.agents.client_name is
  'Last MCP initialize clientInfo.name seen for this agent (e.g. claude-code, cursor-vscode). Best-effort, informational only.';
comment on column public.agents.client_version is
  'Last MCP initialize clientInfo.version seen for this agent. Best-effort, informational only.';
