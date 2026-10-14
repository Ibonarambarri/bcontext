begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pg_catalog;
select plan(35);

select has_table('public', 'saved_views', 'saved views table exists');
select ok((select relrowsecurity from pg_class where oid='public.saved_views'::regclass), 'saved views RLS enabled');
select ok(obj_description('public.saved_views'::regclass) like '%Never stores node copies%', 'table contract forbids node and embedding copies');
select ok(not has_function_privilege('authenticated', 'public.seed_workspace_system_views(uuid)', 'EXECUTE'), 'clients cannot invoke the system seed definer');
select ok(exists(select 1 from pg_policies where schemaname='public' and tablename='saved_views' and policyname='saved_views_member_read'), 'member read policy exists');
select ok(exists(select 1 from pg_policies where schemaname='public' and tablename='saved_views' and policyname='saved_views_owner_update' and qual like '%kind%custom%'), 'system views are excluded from update policy');

insert into public.organizations(id, slug, name) values
  ('38000000-0000-4000-8000-000000000001', 'uix-02-test', 'UIX-02 test'),
  ('38000000-0000-4000-8000-000000000002', 'uix-02-other', 'UIX-02 other');
insert into public.workspaces(id, organization_id, slug, name) values
  ('38000000-0000-4000-8000-000000000003', '38000000-0000-4000-8000-000000000001', 'uix-02-test', 'UIX-02 test'),
  ('38000000-0000-4000-8000-000000000004', '38000000-0000-4000-8000-000000000002', 'uix-02-other', 'UIX-02 other');

select is((select count(*) from public.saved_views where workspace_id='38000000-0000-4000-8000-000000000003' and kind='system'), 8::bigint, 'new workspace gets eight system views');
select is((select array_agg(name order by position) from public.saved_views where workspace_id='38000000-0000-4000-8000-000000000003'), array['Overview','Graph','Tasks','Roadmap','Decisions','Changes','Tags','Agents']::text[], 'system view seed order is canonical');
select lives_ok($$select public.seed_workspace_system_views('38000000-0000-4000-8000-000000000003')$$, 'seed function is idempotent');
select is((select count(*) from public.saved_views where workspace_id='38000000-0000-4000-8000-000000000003'), 8::bigint, 'idempotent reseed does not duplicate views');

insert into auth.users(id, email, encrypted_password, created_at, updated_at) values
  ('38000000-0000-4000-8000-000000000010', 'views-owner@example.test', null, now(), now()),
  ('38000000-0000-4000-8000-000000000011', 'views-admin@example.test', null, now(), now()),
  ('38000000-0000-4000-8000-000000000012', 'views-editor@example.test', null, now(), now()),
  ('38000000-0000-4000-8000-000000000013', 'views-viewer@example.test', null, now(), now()),
  ('38000000-0000-4000-8000-000000000014', 'views-outsider@example.test', null, now(), now());
insert into public.memberships(user_id, workspace_id, role) values
  ('38000000-0000-4000-8000-000000000010', '38000000-0000-4000-8000-000000000003', 'owner'),
  ('38000000-0000-4000-8000-000000000011', '38000000-0000-4000-8000-000000000003', 'admin'),
  ('38000000-0000-4000-8000-000000000012', '38000000-0000-4000-8000-000000000003', 'editor'),
  ('38000000-0000-4000-8000-000000000013', '38000000-0000-4000-8000-000000000003', 'viewer'),
  ('38000000-0000-4000-8000-000000000014', '38000000-0000-4000-8000-000000000004', 'viewer');

create temp table view_counts_before as
select (select count(*) from public.nodes) as nodes, (select count(*) from public.embeddings) as embeddings;

set local role authenticated;
select set_config('request.jwt.claim.sub', '38000000-0000-4000-8000-000000000012', true);
select lives_ok($sql$
  insert into public.saved_views(workspace_id,name,slug,kind,visibility,owner_id,query,presentation)
  values ('38000000-0000-4000-8000-000000000003','Editor private','editor-private','custom','private','38000000-0000-4000-8000-000000000012','{"schema_version":1}'::jsonb,'{"schema_version":1,"renderer":"list"}'::jsonb)
$sql$, 'editor can create an owned custom view');
select is((select count(*) from public.saved_views where slug='editor-private'), 1::bigint, 'editor reads own private view');
select lives_ok($$update public.saved_views set name='Editor private v2' where slug='editor-private'$$, 'editor can update own custom view');
select is((select version from public.saved_views where slug='editor-private'), 2::bigint, 'updates increment optimistic-concurrency version');
select throws_ok($$update public.saved_views set owner_id='38000000-0000-4000-8000-000000000010' where slug='editor-private'$$, '42501', null, 'editor cannot transfer ownership to bypass private-view policy');
select lives_ok($$update public.saved_views set name='No' where system_key='overview'$$, 'system update is safely filtered by RLS');
select is((select name from public.saved_views where system_key='overview'), 'Overview', 'editor cannot mutate system views');

select set_config('request.jwt.claim.sub', '38000000-0000-4000-8000-000000000013', true);
select is((select count(*) from public.saved_views where workspace_id='38000000-0000-4000-8000-000000000003'), 8::bigint, 'viewer reads system views but not private custom views');
select throws_ok($sql$
  insert into public.saved_views(workspace_id,name,slug,kind,visibility,owner_id,query,presentation)
  values ('38000000-0000-4000-8000-000000000003','Viewer','viewer','custom','private','38000000-0000-4000-8000-000000000013','{"schema_version":1}'::jsonb,'{"schema_version":1,"renderer":"list"}'::jsonb)
$sql$, '42501', null, 'viewer cannot create custom views');
select lives_ok($$update public.saved_views set name='Viewer edit' where slug='editor-private'$$, 'viewer update is safely filtered by RLS');

select set_config('request.jwt.claim.sub', '38000000-0000-4000-8000-000000000010', true);
select is((select count(*) from public.saved_views where workspace_id='38000000-0000-4000-8000-000000000003'), 9::bigint, 'owner can inspect all workspace views including private custom views');
select is((select name from public.saved_views where slug='editor-private'), 'Editor private v2', 'viewer could not mutate another owner private view');
select lives_ok($$update public.saved_views set description='admin correction' where slug='editor-private'$$, 'owner can update another owner custom view');
select lives_ok($sql$
  insert into public.saved_views(workspace_id,name,slug,kind,visibility,owner_id,query,presentation)
  values ('38000000-0000-4000-8000-000000000003','Shared','shared','custom','workspace','38000000-0000-4000-8000-000000000010','{"schema_version":1}'::jsonb,'{"schema_version":1,"renderer":"table"}'::jsonb)
$sql$, 'owner can create a workspace-visible custom view');

select set_config('request.jwt.claim.sub', '38000000-0000-4000-8000-000000000013', true);
select is((select count(*) from public.saved_views where workspace_id='38000000-0000-4000-8000-000000000003'), 9::bigint, 'viewer reads workspace-visible custom views');

select set_config('request.jwt.claim.sub', '38000000-0000-4000-8000-000000000011', true);
select ok(exists(select 1 from public.saved_views where slug='editor-private'), 'admin can read another owner private view');
select lives_ok($$delete from public.saved_views where slug='editor-private'$$, 'admin can delete another owner custom view');

select set_config('request.jwt.claim.sub', '38000000-0000-4000-8000-000000000014', true);
select is((select count(*) from public.saved_views where workspace_id='38000000-0000-4000-8000-000000000003'), 0::bigint, 'cross-workspace user cannot read target views');
select is((select count(*) from public.saved_views where workspace_id='38000000-0000-4000-8000-000000000004'), 8::bigint, 'cross-workspace user still reads own workspace system views');
reset role;

select throws_ok($sql$
  insert into public.saved_views(workspace_id,name,slug,kind,visibility,owner_id,query,presentation,schema_version)
  values ('38000000-0000-4000-8000-000000000003','Bad schema','bad-schema','custom','private','38000000-0000-4000-8000-000000000010','{"schema_version":2}'::jsonb,'{"schema_version":1,"renderer":"list"}'::jsonb,1)
$sql$, '23514', null, 'query schema version must match the row schema version');
select throws_ok($sql$
  insert into public.saved_views(workspace_id,name,slug,kind,visibility,owner_id,query,presentation)
  values ('38000000-0000-4000-8000-000000000003','Mixed contract','mixed-contract','custom','private','38000000-0000-4000-8000-000000000010','{"schema_version":1,"renderer":"graph"}'::jsonb,'{"schema_version":1,"renderer":"list"}'::jsonb)
$sql$, '23514', null, 'database keeps query and presentation fields strictly separated');
select throws_ok($sql$
  insert into public.saved_views(workspace_id,name,slug,kind,visibility,query,presentation)
  values ('38000000-0000-4000-8000-000000000003','No owner','no-owner','custom','private','{"schema_version":1}'::jsonb,'{"schema_version":1,"renderer":"list"}'::jsonb)
$sql$, '23514', null, 'custom views require exactly one owner');
select is((select count(*) from public.nodes), (select nodes from view_counts_before), 'view CRUD never duplicates nodes');
select is((select count(*) from public.embeddings), (select embeddings from view_counts_before), 'view CRUD never creates embeddings');
select ok((select bool_and(view_count = 8) from (select workspace_id, count(*) filter (where kind='system') as view_count from public.saved_views group by workspace_id) seeded), 'existing and new workspaces each retain eight system views');

select * from finish();
rollback;
