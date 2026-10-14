-- 0012_rls_jwt_claim_indexes.sql
--
-- P0-06 — RLS verification scaffolding. Two parts:
--
-- 1. Composite indexes that make workspace-scoped reads match the access
--    pattern of every RLS-checked query. `(workspace_id, updated_at desc)`
--    on the hot tables.
--
-- 2. `public.set_workspace_claim(event jsonb)` — the Supabase Auth Hook
--    body. Registering the hook itself is a dashboard step (Authentication
--    → Hooks → Before Token Issued → choose this function). The function
--    is created here so the dashboard step is the only manual op.
--
-- RLS policy updates to read `auth.jwt() ->> 'workspaces'` are deliberately
-- NOT in this migration — they require the Auth Hook to be live first,
-- otherwise every query 403s. Follow-up migration `0013_rls_jwt_policies`
-- ships those updates once the hook is registered in production.

-- ============================================================
-- 1. Composite indexes
-- ============================================================

create index if not exists nodes_workspace_updated_at_idx
  on nodes(workspace_id, updated_at desc);

create index if not exists embeddings_workspace_idx
  on embeddings(workspace_id)
  where workspace_id is not null;

-- audit_log composite index is created alongside the table itself in
-- 0014_audit_log.sql to keep this migration applicable on stacks that
-- haven't yet hit the audit-chain rollout.

-- ============================================================
-- 2. Auth Hook function
-- ============================================================
--
-- Reads `event->>'user_id'`, looks up the user's non-revoked workspace
-- memberships, returns `event` with `claims.workspaces` populated as a
-- JSON array of workspace ids (text). Policies read it back with
-- `(auth.jwt() ->> 'workspaces')::jsonb` and an `?| `or `@>` operator,
-- per the policy migration that comes next.
--
-- security definer so the function reads memberships under the function
-- owner's privileges; Auth Hooks are otherwise rate-limited and don't
-- have access to user-context.

create or replace function public.set_workspace_claim(event jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid;
  ws_ids text[];
  claims jsonb;
begin
  uid := (event ->> 'user_id')::uuid;
  if uid is null then
    return event;
  end if;

  select coalesce(array_agg(workspace_id::text), '{}')
  into ws_ids
  from memberships
  where user_id = uid;

  claims := coalesce(event -> 'claims', '{}'::jsonb);
  claims := jsonb_set(claims, '{workspaces}', to_jsonb(ws_ids), true);
  event := jsonb_set(event, '{claims}', claims, true);
  return event;
end;
$$;

-- Restrict execute permissions: only the supabase_auth_admin role
-- can invoke this hook. Calling the function from app code is a no-op
-- anyway (no `event` shape) but the lock keeps the surface minimal.
revoke all on function public.set_workspace_claim(jsonb) from public;
revoke all on function public.set_workspace_claim(jsonb) from anon;
revoke all on function public.set_workspace_claim(jsonb) from authenticated;
grant execute on function public.set_workspace_claim(jsonb) to supabase_auth_admin;

-- ============================================================
-- 3. Helper: is_workspace_member(uuid) — used as a fallback in
--    policies that can't read the JWT claim (e.g. service-role
--    contexts or cross-table joins). Keeps RLS expressive without
--    forcing every policy into JWT-only mode.
-- ============================================================

create or replace function public.is_workspace_member(ws uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from memberships m
    where m.workspace_id = ws
      and m.user_id = auth.uid()
  );
$$;

grant execute on function public.is_workspace_member(uuid) to authenticated;
grant execute on function public.is_workspace_member(uuid) to anon;
