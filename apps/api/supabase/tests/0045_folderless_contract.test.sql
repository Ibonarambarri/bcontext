begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pg_catalog;
select plan(37);

select hasnt_column('public', 'nodes', 'category', 'legacy category column is physically retired');
select ok(
  position('folder' in pg_get_constraintdef((
    select oid from pg_constraint where conrelid='public.nodes'::regclass and conname='nodes_kind_check'
  ))) = 0,
  'nodes kind contract no longer admits folder'
);
select has_trigger('public', 'nodes', 'nodes_folderless_hierarchy_guard', 'same-workspace acyclic hierarchy guard remains');
select ok(
  position('pg_advisory_xact_lock' in pg_get_functiondef('public.enforce_folderless_hierarchy()'::regprocedure)) > 0,
  'hierarchy mutations are serialized per workspace'
);
select has_trigger('public', 'nodes', 'nodes_data_contract_guard', 'legacy data.tags writes are rejected');
select is(
  (select tgenabled::text from pg_trigger where tgrelid='public.nodes'::regclass and tgname='nodes_updated'),
  'O',
  'updated_at trigger is re-enabled after representation cleanup'
);
select ok((select relrowsecurity from pg_class where oid='public.nodes'::regclass), 'nodes RLS remains enabled');
select ok(exists(
  select 1 from pg_constraint c
  join pg_attribute a on a.attrelid=c.conrelid and a.attnum=any(c.conkey)
  where c.conrelid='public.nodes'::regclass and c.contype='f' and a.attname='parent_id'
), 'parent_id foreign key remains');
select ok(to_regclass('public.nodes_parent_idx') is not null, 'parent lookup index remains');
select ok(to_regclass('public.nodes_workspace_parent_position_idx') is not null, 'workspace hierarchy ordering index remains');
select ok(to_regprocedure('public.apply_folderless_migration_plan(uuid,text)') is null, 'legacy apply RPC is retired');
select ok(to_regprocedure('public.rollback_folderless_migration_plan(uuid,text)') is null, 'incompatible logical rollback RPC is retired');
select ok(to_regprocedure('public.capture_folderless_workspace(uuid)') is null, 'legacy folder/category capture RPC is retired');
select has_table('public', 'folderless_migration_runs', 'migration evidence remains queryable');
select has_table('public', 'folderless_migration_ledger', 'migration ledger remains queryable');
select has_table('public', 'node_redirects', 'legacy redirects remain resolvable');
select has_function('public', 'resolve_node_redirect', array['uuid','uuid','text'], 'redirect resolver remains available');
select ok(position('PITR' in coalesce(obj_description('public.folderless_migration_runs'::regclass),'')) > 0, 'restore/PITR contract is documented on evidence');
select has_function('public', 'assert_folderless_contract_preflight', '{}'::text[], 'post-contract invariant audit remains available');
select ok(not has_function_privilege('authenticated', 'public.assert_folderless_contract_preflight()', 'EXECUTE'), 'members cannot invoke global preflight');
select ok(position('category' in pg_get_function_result('public.match_nodes(vector,uuid,integer,double precision,text,uuid[])'::regprocedure)) = 0, 'vector RPC no longer returns category');
select ok(position('category' in pg_get_function_result('public.hybrid_search(text,vector,uuid,integer,integer,integer,integer,text,uuid[])'::regprocedure)) = 0, 'hybrid RPC no longer returns category');
select ok(position('category' in pg_get_function_result('public.list_node_summaries(uuid,integer)'::regprocedure)) = 0, 'summary RPC no longer returns category');
select ok(position('category' in pg_get_function_result('public.get_node_context_candidates(uuid,uuid,integer)'::regprocedure)) = 0, 'context RPC no longer returns category');
select ok(to_regprocedure('public.match_nodes(vector,uuid,integer,double precision)') is null, 'legacy vector overload with category is retired');
select ok(to_regprocedure('public.hybrid_search(text,vector,uuid,integer,integer,integer,integer)') is null, 'legacy hybrid overload with category is retired');

insert into public.organizations(id,slug,name) values
  ('45000000-0000-4000-8000-000000000001','uix-24-a','UIX-24 A'),
  ('45000000-0000-4000-8000-000000000002','uix-24-b','UIX-24 B');
insert into public.workspaces(id,organization_id,slug,name) values
  ('45000000-0000-4000-8000-000000000003','45000000-0000-4000-8000-000000000001','uix-24-a','UIX-24 A'),
  ('45000000-0000-4000-8000-000000000004','45000000-0000-4000-8000-000000000002','uix-24-b','UIX-24 B');
insert into public.nodes(id,workspace_id,parent_id,kind,slug,title,content_md,data) values
  ('45000000-0000-4000-8000-000000000010','45000000-0000-4000-8000-000000000003',null,'doc','root','Root','','{}'),
  ('45000000-0000-4000-8000-000000000011','45000000-0000-4000-8000-000000000003','45000000-0000-4000-8000-000000000010','task','child','Child','','{}'),
  ('45000000-0000-4000-8000-000000000012','45000000-0000-4000-8000-000000000004',null,'doc','other','Other','','{}');
select public.assign_node_tags('45000000-0000-4000-8000-000000000003','45000000-0000-4000-8000-000000000010',array[(select id from public.tags where workspace_id='45000000-0000-4000-8000-000000000003' and normalized_name='tech')]);
select public.assign_node_tags('45000000-0000-4000-8000-000000000003','45000000-0000-4000-8000-000000000011',array[(select id from public.tags where workspace_id='45000000-0000-4000-8000-000000000003' and normalized_name='tech')]);
select public.assign_node_tags('45000000-0000-4000-8000-000000000004','45000000-0000-4000-8000-000000000012',array[(select id from public.tags where workspace_id='45000000-0000-4000-8000-000000000004' and normalized_name='tech')]);

select is((select count(*) from public.nodes where data ? 'tags'), 0::bigint, 'first-class tag writes never recreate data.tags');
select throws_ok(
  $$update public.nodes set data=jsonb_set(data,'{tags}','["tech"]'::jsonb) where id='45000000-0000-4000-8000-000000000010'$$,
  '23514','legacy_data_tags_retired','legacy data.tags writes fail closed'
);
select throws_ok(
  $$update public.nodes set parent_id='45000000-0000-4000-8000-000000000012' where id='45000000-0000-4000-8000-000000000011'$$,
  '23503','invalid_parent','cross-workspace parent is rejected'
);
select throws_ok(
  $$update public.nodes set workspace_id='45000000-0000-4000-8000-000000000004' where id='45000000-0000-4000-8000-000000000010'$$,
  '23514','workspace_id_immutable','nodes cannot move across workspace boundaries'
);
select throws_ok(
  $$update public.nodes set parent_id='45000000-0000-4000-8000-000000000011' where id='45000000-0000-4000-8000-000000000010'$$,
  '23514','parent_cycle','semantic hierarchy remains acyclic'
);
insert into public.nodes(id,workspace_id,parent_id,kind,slug,title,content_md,data)
values ('45000000-0000-4000-8000-000000000013','45000000-0000-4000-8000-000000000003',null,'doc','untagged','Untagged','','{}');
select lives_ok($$select public.assert_folderless_contract_preflight()$$, 'valid final contract allows zero-tag semantic nodes');

select throws_ok($sql$
  do $block$ begin
    alter table public.nodes drop constraint nodes_kind_check;
    insert into public.nodes(id,workspace_id,kind,slug,title,data)
    values ('45000000-0000-4000-8000-000000000020','45000000-0000-4000-8000-000000000003','folder','legacy','Legacy','{}');
    perform public.assert_folderless_contract_preflight();
  end $block$
$sql$,'55000','folderless_contract_preflight_folders_remain','preflight rejects any residual folder');

select throws_ok($sql$
  do $block$ begin
    alter table public.nodes drop constraint nodes_parent_id_fkey;
    alter table public.nodes disable trigger nodes_folderless_hierarchy_guard;
    update public.nodes set parent_id='45000000-0000-4000-8000-000000000099' where id='45000000-0000-4000-8000-000000000011';
    perform public.assert_folderless_contract_preflight();
  end $block$
$sql$,'55000','folderless_contract_preflight_invalid_parent','preflight rejects invalid parent state');

select throws_ok($sql$
  do $block$ begin
    alter table public.nodes add column category text;
    execute $$update public.nodes set category='business' where id='45000000-0000-4000-8000-000000000010'$$;
    perform public.assert_folderless_contract_preflight();
  end $block$
$sql$,'55000','folderless_contract_preflight_category_without_equivalent','preflight rejects category without its equivalent tag');

select throws_ok($sql$
  do $block$ begin
    update public.saved_views set query=jsonb_set(query,'{kinds}','["folder"]'::jsonb)
    where workspace_id='45000000-0000-4000-8000-000000000003' and system_key='graph';
    perform public.assert_folderless_contract_preflight();
  end $block$
$sql$,'55000','folderless_contract_preflight_legacy_view_kind','preflight rejects saved views filtering by folder kind');

select throws_ok($sql$
  do $block$ begin
    update public.saved_views set query=jsonb_set(query,'{root_node_ids}','["45000000-0000-4000-8000-000000000099"]'::jsonb)
    where workspace_id='45000000-0000-4000-8000-000000000003' and system_key='graph';
    perform public.assert_folderless_contract_preflight();
  end $block$
$sql$,'55000','folderless_contract_preflight_legacy_view_root','preflight rejects stale legacy view roots');

select * from finish();
rollback;
