begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pg_catalog;
select plan(53);

select has_table('public', 'tags', 'tags table exists');
select has_table('public', 'tag_aliases', 'tag aliases table exists');
select has_table('public', 'node_tags', 'node_tags table exists');
select ok((select relrowsecurity from pg_class where oid = 'public.tags'::regclass), 'tags RLS enabled');
select ok((select relrowsecurity from pg_class where oid = 'public.tag_aliases'::regclass), 'tag_aliases RLS enabled');
select ok((select relrowsecurity from pg_class where oid = 'public.node_tags'::regclass), 'node_tags RLS enabled');
select ok(exists(select 1 from pg_policies where schemaname='public' and tablename='tags' and policyname='tags_admin_insert' and with_check like '%is_workspace_admin%'), 'tag creation is admin scoped');
select ok(exists(select 1 from pg_policies where schemaname='public' and tablename='tags' and policyname='tags_member_read' and qual like '%is_workspace_member%'), 'tag reads are member scoped');
select ok(exists(select 1 from pg_policies where schemaname='public' and tablename='node_tags' and policyname='node_tags_contributor_insert' and with_check like '%memberships%'), 'assignment writes require a contributor membership');
select ok(not has_function_privilege('authenticated', 'public.assign_node_tags(uuid,uuid,uuid[])', 'EXECUTE'), 'authenticated clients cannot bypass assignment RLS through the service RPC');
select ok(not has_function_privilege('authenticated', 'public.sync_node_legacy_tag_fields(uuid)', 'EXECUTE'), 'authenticated clients cannot invoke the compatibility sync definer across tenants');
select ok(has_function_privilege('service_role', 'public.assign_node_tags(uuid,uuid,uuid[])', 'EXECUTE'), 'service role can execute the workspace-scoped assignment RPC');
select ok(not has_function_privilege('anon', 'public.seed_workspace_domain_tags_trigger()', 'EXECUTE'), 'anon cannot invoke the workspace seed trigger function');
select ok(not has_function_privilege('authenticated', 'public.seed_workspace_domain_tags_trigger()', 'EXECUTE'), 'authenticated clients cannot invoke the workspace seed trigger function');
select ok((select proconfig @> array['search_path=pg_catalog'] from pg_proc where oid='public.normalize_tag_name(text)'::regprocedure), 'tag normalization pins its search path');
select ok((select proconfig @> array['search_path=pg_catalog'] from pg_proc where oid='public.tag_slug_base(text)'::regprocedure), 'tag slug generation pins its search path');
select is((select count(*) from pg_policies where schemaname='public' and tablename='tag_aliases' and cmd='ALL'), 0::bigint, 'tag alias writes do not overlap member SELECT through an ALL policy');
select is((select count(*) from pg_policies where schemaname='public' and tablename='tag_aliases' and policyname like 'tag_aliases_admin_%'), 3::bigint, 'tag alias admin writes use separate insert, update and delete policies');
select ok((select with_check like '%SELECT auth.uid()%' from pg_policies where schemaname='public' and tablename='node_tags' and policyname='node_tags_contributor_insert'), 'assignment insert initializes auth.uid once per statement');
select ok((select qual like '%SELECT auth.uid()%' from pg_policies where schemaname='public' and tablename='node_tags' and policyname='node_tags_contributor_delete'), 'assignment delete initializes auth.uid once per statement');

insert into public.organizations(id, slug, name)
values ('36000000-0000-4000-8000-000000000001', 'uix-01-test', 'UIX-01 test');
insert into public.workspaces(id, organization_id, slug, name)
values (
  '36000000-0000-4000-8000-000000000002',
  '36000000-0000-4000-8000-000000000001',
  'uix-01-test',
  'UIX-01 test'
);

select is(
  (select array_agg(normalized_name order by normalized_name) from public.tags where workspace_id='36000000-0000-4000-8000-000000000002' and deleted_at is null),
  array['ai','business','product','tech']::text[],
  'new workspaces seed only domain tags'
);

insert into public.organizations(id, slug, name)
values ('36000000-0000-4000-8000-000000000020', 'uix-01-other', 'UIX-01 other');
insert into public.workspaces(id, organization_id, slug, name)
values (
  '36000000-0000-4000-8000-000000000021',
  '36000000-0000-4000-8000-000000000020',
  'uix-01-other',
  'UIX-01 other'
);

insert into auth.users(id, email, encrypted_password, created_at, updated_at)
values
  ('36000000-0000-4000-8000-000000000010', 'uix-owner@example.test', null, now(), now()),
  ('36000000-0000-4000-8000-000000000011', 'uix-editor@example.test', null, now(), now()),
  ('36000000-0000-4000-8000-000000000012', 'uix-viewer@example.test', null, now(), now()),
  ('36000000-0000-4000-8000-000000000013', 'uix-outsider@example.test', null, now(), now());
insert into public.memberships(user_id, workspace_id, role)
values
  ('36000000-0000-4000-8000-000000000010', '36000000-0000-4000-8000-000000000002', 'owner'),
  ('36000000-0000-4000-8000-000000000011', '36000000-0000-4000-8000-000000000002', 'editor'),
  ('36000000-0000-4000-8000-000000000012', '36000000-0000-4000-8000-000000000002', 'viewer'),
  ('36000000-0000-4000-8000-000000000013', '36000000-0000-4000-8000-000000000021', 'viewer');

-- This historical suite exercises the pre-cutover compatibility synchronizer.
-- The folderless guard rejects these category writes in normal operation, so
-- legacy fixtures use the same transaction-local bypass as the audited
-- migration engine.
select set_config('bcontext.folderless_migration_bypass', 'on', true);

insert into public.nodes(
  id, workspace_id, parent_id, kind, category, slug, title, content_md, data
) values (
  '36000000-0000-4000-8000-000000000003',
  '36000000-0000-4000-8000-000000000002',
  null, 'doc', 'business', 'plan', 'Plan', '', '{}'::jsonb
), (
  '36000000-0000-4000-8000-000000000004',
  '36000000-0000-4000-8000-000000000002',
  null, 'decision', 'decisions', 'decision', 'Decision', '', '{}'::jsonb
), (
  '36000000-0000-4000-8000-000000000005',
  '36000000-0000-4000-8000-000000000002',
  null, 'doc', 'business', 'legacy-category', 'Legacy category', '', '{}'::jsonb
);

select is((select count(*) from public.node_tags nt join public.tags t on t.id=nt.tag_id where nt.node_id='36000000-0000-4000-8000-000000000003' and t.normalized_name='business'), 1::bigint, 'category dual-write assigns its domain tag');
select is((select data->'tags' from public.nodes where id='36000000-0000-4000-8000-000000000003'), '["business"]'::jsonb, 'category backfills legacy data.tags');
select is((select count(*) from public.node_tags where node_id='36000000-0000-4000-8000-000000000004'), 0::bigint, 'decision category is represented by kind, not a duplicate tag');
update public.nodes set category='product' where id='36000000-0000-4000-8000-000000000005';
select is((select data->'tags' from public.nodes where id='36000000-0000-4000-8000-000000000005'), '["product"]'::jsonb, 'legacy category-only update replaces the prior domain tag');
update public.nodes set category=null where id='36000000-0000-4000-8000-000000000005';
select is((select count(*) from public.node_tags where node_id='36000000-0000-4000-8000-000000000005'), 0::bigint, 'legacy category clear removes the mirrored domain assignment');

select public.create_workspace_tag(
  '36000000-0000-4000-8000-000000000002', 'Operations', null, null
);
update public.nodes
set data = jsonb_build_object('tags', jsonb_build_array('operations'))
where id='36000000-0000-4000-8000-000000000003';
select is((select count(*) from public.node_tags where node_id='36000000-0000-4000-8000-000000000003'), 2::bigint, 'legacy data.tags dual-write joins existing tags and retains category tag');

set local role authenticated;
select set_config('request.jwt.claim.sub', '36000000-0000-4000-8000-000000000010', true);
select is((select count(*) from public.tags where workspace_id='36000000-0000-4000-8000-000000000002'), 5::bigint, 'member RLS can read its workspace taxonomy');
select is((select count(*) from public.tags where workspace_id='36000000-0000-4000-8000-000000000021'), 0::bigint, 'member RLS hides another workspace taxonomy');
select lives_ok(
  $$insert into public.tags(workspace_id,name,normalized_name,slug) values ('36000000-0000-4000-8000-000000000002','RLS owner tag','','')$$,
  'owner can create a taxonomy tag through RLS'
);

select set_config('request.jwt.claim.sub', '36000000-0000-4000-8000-000000000011', true);
select throws_ok(
  $$insert into public.tags(workspace_id,name,normalized_name,slug) values ('36000000-0000-4000-8000-000000000002','RLS editor tag','','')$$,
  '42501',
  'new row violates row-level security policy for table "tags"',
  'editor cannot create taxonomy definitions'
);
select lives_ok(
  $$insert into public.node_tags(workspace_id,node_id,tag_id) values (
    '36000000-0000-4000-8000-000000000002',
    '36000000-0000-4000-8000-000000000004',
    (select id from public.tags where workspace_id='36000000-0000-4000-8000-000000000002' and normalized_name='operations')
  )$$,
  'editor can assign an existing active tag'
);

select set_config('request.jwt.claim.sub', '36000000-0000-4000-8000-000000000012', true);
select ok((select count(*) from public.node_tags where node_id='36000000-0000-4000-8000-000000000004') > 0, 'viewer can read assignments in its workspace');
select throws_ok(
  $$insert into public.node_tags(workspace_id,node_id,tag_id) values (
    '36000000-0000-4000-8000-000000000002',
    '36000000-0000-4000-8000-000000000004',
    (select id from public.tags where workspace_id='36000000-0000-4000-8000-000000000002' and normalized_name='ai')
  )$$,
  '42501',
  'new row violates row-level security policy for table "node_tags"',
  'viewer cannot mutate tag assignments'
);

select set_config('request.jwt.claim.sub', '36000000-0000-4000-8000-000000000013', true);
select is((select count(*) from public.nodes where workspace_id='36000000-0000-4000-8000-000000000002'), 0::bigint, 'matching taxonomy never grants access to another workspace nodes');
reset role;

select public.assign_node_tags(
  '36000000-0000-4000-8000-000000000002',
  '36000000-0000-4000-8000-000000000003',
  array[
    (select id from public.tags where workspace_id='36000000-0000-4000-8000-000000000002' and normalized_name='business' and deleted_at is null),
    (select id from public.tags where workspace_id='36000000-0000-4000-8000-000000000002' and normalized_name='product' and deleted_at is null)
  ]
);
select is((select count(*) from public.node_tags where node_id='36000000-0000-4000-8000-000000000003'), 2::bigint, 'one node accepts multiple first-class tags');
select is((select jsonb_array_length(data->'tags') from public.nodes where id='36000000-0000-4000-8000-000000000003'), 2, 'first-class assignment dual-writes data.tags');
select is((select category from public.nodes where id='36000000-0000-4000-8000-000000000003'), 'business', 'dual-write preserves a still-assigned legacy category');

create temp table uix_tag_ids as
select normalized_name, id
from public.tags
where workspace_id='36000000-0000-4000-8000-000000000002'
  and normalized_name in ('business','product')
  and deleted_at is null;

select public.rename_workspace_tag(
  '36000000-0000-4000-8000-000000000002',
  (select id from uix_tag_ids where normalized_name='product'),
  'Product Area',
  'Renamed domain tag'
);
select is((select id from public.tags where normalized_name='product area' and workspace_id='36000000-0000-4000-8000-000000000002'), (select id from uix_tag_ids where normalized_name='product'), 'rename preserves stable tag id');
select is((select count(*) from public.tag_aliases where normalized_name='product' and workspace_id='36000000-0000-4000-8000-000000000002'), 1::bigint, 'rename records an alias');
select ok((select data->'tags' ? 'product area' from public.nodes where id='36000000-0000-4000-8000-000000000003'), 'rename refreshes the legacy mirror');
update public.nodes set category='product' where id='36000000-0000-4000-8000-000000000005';
select is((select category from public.nodes where id='36000000-0000-4000-8000-000000000005'), 'product', 'legacy category remains readable after its canonical tag is renamed');
select is((select tag_id from public.node_tags where node_id='36000000-0000-4000-8000-000000000005'), (select id from uix_tag_ids where normalized_name='product'), 'legacy category writes resolve through the rename alias');

select public.merge_workspace_tags(
  '36000000-0000-4000-8000-000000000002',
  (select id from uix_tag_ids where normalized_name='product'),
  (select id from uix_tag_ids where normalized_name='business')
);
select is((select merged_into_id from public.tags where id=(select id from uix_tag_ids where normalized_name='product')), (select id from uix_tag_ids where normalized_name='business'), 'merge keeps source id as a redirect');
select is((select count(*) from public.node_tags where node_id='36000000-0000-4000-8000-000000000003'), 1::bigint, 'merge deduplicates node assignments');
select throws_ok(
  $$insert into public.node_tags(workspace_id,node_id,tag_id) values (
    '36000000-0000-4000-8000-000000000002',
    '36000000-0000-4000-8000-000000000005',
    (select id from uix_tag_ids where normalized_name='product')
  )$$,
  '23503',
  'unknown_or_inactive_tag',
  'inactive merged tags cannot receive new assignments'
);
select is((select count(*) from public.embeddings where node_id='36000000-0000-4000-8000-000000000003'), 0::bigint, 'tag lifecycle does not create separate embeddings');

select ok(public.delete_workspace_tag(
  '36000000-0000-4000-8000-000000000002',
  (select id from uix_tag_ids where normalized_name='business')
), 'delete soft-deletes an active tag');
select is((select count(*) from public.node_tags where node_id='36000000-0000-4000-8000-000000000003'), 0::bigint, 'delete removes assignments');
select is((select data->'tags' from public.nodes where id='36000000-0000-4000-8000-000000000003'), '[]'::jsonb, 'delete clears legacy data.tags');
select is((select category from public.nodes where id='36000000-0000-4000-8000-000000000003'), 'business', 'tag deletion leaves the read-only compatibility category intact');

select throws_ok(
  $$select public.create_workspace_tag('36000000-0000-4000-8000-000000000002', ' AI ', null, null)$$,
  '23505',
  null,
  'normalized active tag names are unique per workspace'
);
select ok(exists(
  select 1 from pg_constraint
  where conrelid='public.node_tags'::regclass
    and conname in ('node_tags_node_same_workspace_fk','node_tags_tag_same_workspace_fk')
), 'composite foreign keys enforce same-workspace assignments');

select set_config('bcontext.folderless_migration_bypass', 'off', true);
select * from finish();
rollback;
