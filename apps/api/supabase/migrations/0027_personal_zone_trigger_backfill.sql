-- 0027_personal_zone_trigger_backfill.sql
--
-- Auto-provision a private "personal zone" workspace for every user, plus a
-- base account-plan row. The personal zone behaves like any workspace but is
-- flagged is_personal=true and is never shareable (see 0028).
--
-- Primary mechanism: a security-definer trigger on auth.users (same signal
-- as 0019's waitlist trigger). The trigger body is defensive — a throw here
-- would break signup — so it swallows errors and relies on the app-code
-- safety net (registry.ensurePersonalZone) to retry on next login.

create or replace function provision_personal_zone()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org   uuid;
  v_ws    uuid;
  v_short text := substr(replace(new.id::text, '-', ''), 1, 12);
begin
  -- Always ensure a base account-plan row exists.
  insert into user_account_plans (user_id, plan)
    values (new.id, 'account_free')
    on conflict (user_id) do nothing;

  -- Idempotent: skip if this user already has a personal workspace.
  if exists (
    select 1 from workspaces w
    join memberships m on m.workspace_id = w.id
    where m.user_id = new.id and w.is_personal
  ) then
    return new;
  end if;

  insert into organizations (slug, name)
    values ('personal-' || v_short, 'Personal')
    returning id into v_org;

  insert into workspaces (organization_id, slug, name, description, is_personal, plan)
    values (v_org, 'personal-' || v_short, 'Personal',
            'Your private zone — never shared.', true, 'ws_free')
    returning id into v_ws;

  insert into memberships (user_id, workspace_id, role)
    values (new.id, v_ws, 'owner') on conflict do nothing;
  insert into organization_memberships (user_id, organization_id, role)
    values (new.id, v_org, 'owner') on conflict do nothing;

  -- Seed the 8 canonical category folders (mirror CATEGORY_FOLDERS in
  -- src/lib/workspaces/registry.ts).
  insert into nodes (workspace_id, parent_id, kind, category, slug, title, content_md, position)
  select v_ws, null, 'folder', c.cat, c.cat, c.title,
         '# ' || c.title || E'\n\n' || c.descr, c.pos
  from (values
    ('business',  'Business',  'Vision, market, customers, GTM.', 1),
    ('product',   'Product',   'PRDs, roadmap, specs.',           2),
    ('tech',      'Tech',      'Architecture, infra, conventions.', 3),
    ('decisions', 'Decisions', 'ADRs and recorded calls.',        4),
    ('meetings',  'Meetings',  'Notes and minutes.',              5),
    ('tasks',     'Tasks',     'Work items, backlog, sprints.',   6),
    ('bugs',      'Bugs',      'Incidents and known issues.',     7),
    ('ai',        'AI',        'Agent prompts, workflows, evals.', 8)
  ) as c(cat, title, descr, pos);

  return new;
exception when others then
  -- Never break the auth transaction; app code provisions lazily on login.
  return new;
end;
$$;

drop trigger if exists provision_personal_zone_on_password on auth.users;
create trigger provision_personal_zone_on_password
  after update of encrypted_password on auth.users
  for each row
  when (
    (old.encrypted_password is null or old.encrypted_password = '')
    and new.encrypted_password is not null and new.encrypted_password <> ''
  )
  execute function provision_personal_zone();

-- Users created already-confirmed (admin.createUser with a password) arrive
-- as an INSERT, not an UPDATE — cover that path too.
drop trigger if exists provision_personal_zone_on_insert on auth.users;
create trigger provision_personal_zone_on_insert
  after insert on auth.users
  for each row
  when (new.encrypted_password is not null and new.encrypted_password <> '')
  execute function provision_personal_zone();

-- ============================================================
-- Backfill existing users
-- ============================================================
insert into user_account_plans (user_id, plan)
  select id, 'account_free' from auth.users
  on conflict (user_id) do nothing;

do $$
declare
  u       record;
  v_org   uuid;
  v_ws    uuid;
  v_short text;
begin
  for u in select id from auth.users where encrypted_password is not null and encrypted_password <> '' loop
    if exists (
      select 1 from workspaces w
      join memberships m on m.workspace_id = w.id
      where m.user_id = u.id and w.is_personal
    ) then
      continue;
    end if;

    v_short := substr(replace(u.id::text, '-', ''), 1, 12);

    insert into organizations (slug, name)
      values ('personal-' || v_short, 'Personal')
      returning id into v_org;
    insert into workspaces (organization_id, slug, name, description, is_personal, plan)
      values (v_org, 'personal-' || v_short, 'Personal',
              'Your private zone — never shared.', true, 'ws_free')
      returning id into v_ws;
    insert into memberships (user_id, workspace_id, role)
      values (u.id, v_ws, 'owner');
    insert into organization_memberships (user_id, organization_id, role)
      values (u.id, v_org, 'owner');

    insert into nodes (workspace_id, parent_id, kind, category, slug, title, content_md, position)
    select v_ws, null, 'folder', c.cat, c.cat, c.title,
           '# ' || c.title || E'\n\n' || c.descr, c.pos
    from (values
      ('business',  'Business',  'Vision, market, customers, GTM.', 1),
      ('product',   'Product',   'PRDs, roadmap, specs.',           2),
      ('tech',      'Tech',      'Architecture, infra, conventions.', 3),
      ('decisions', 'Decisions', 'ADRs and recorded calls.',        4),
      ('meetings',  'Meetings',  'Notes and minutes.',              5),
      ('tasks',     'Tasks',     'Work items, backlog, sprints.',   6),
      ('bugs',      'Bugs',      'Incidents and known issues.',     7),
      ('ai',        'AI',        'Agent prompts, workflows, evals.', 8)
    ) as c(cat, title, descr, pos);
  end loop;
end $$;
