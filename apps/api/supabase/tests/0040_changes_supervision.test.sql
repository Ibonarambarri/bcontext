begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pg_catalog;
select plan(9);

select has_column('public', 'activity', 'expires_at', 'changes feed has explicit retention timestamp');
select col_not_null('public', 'activity', 'expires_at', 'retention timestamp cannot be omitted');
select ok(obj_description('public.activity'::regclass) like '%180 days%', 'retention policy is documented on the table');
select ok(not has_function_privilege('authenticated', 'public.prune_expired_activity()', 'EXECUTE'), 'clients cannot invoke retention definer');
select ok((select relrowsecurity from pg_class where oid='public.activity'::regclass), 'activity RLS stays enabled');

insert into public.organizations(id,slug,name) values
  ('40000000-0000-4000-8000-000000000001','uix08-a','UIX08 A'),
  ('40000000-0000-4000-8000-000000000002','uix08-b','UIX08 B');
insert into public.workspaces(id,organization_id,slug,name) values
  ('40000000-0000-4000-8000-000000000003','40000000-0000-4000-8000-000000000001','uix08-a','UIX08 A'),
  ('40000000-0000-4000-8000-000000000004','40000000-0000-4000-8000-000000000002','uix08-b','UIX08 B');
insert into auth.users(id,email,created_at,updated_at) values
  ('40000000-0000-4000-8000-000000000010','uix08-member@example.test',now(),now()),
  ('40000000-0000-4000-8000-000000000011','uix08-outsider@example.test',now(),now());
insert into public.memberships(user_id,workspace_id,role) values
  ('40000000-0000-4000-8000-000000000010','40000000-0000-4000-8000-000000000003','viewer'),
  ('40000000-0000-4000-8000-000000000011','40000000-0000-4000-8000-000000000004','viewer');
insert into public.activity(id,workspace_id,actor_id,actor_kind,verb,payload,created_at,expires_at) values
  ('40000000-0000-4000-8000-000000000020','40000000-0000-4000-8000-000000000003','40000000-0000-4000-8000-000000000010','human','updated','{"node_kind":"doc"}',now(),now()+interval '180 days'),
  ('40000000-0000-4000-8000-000000000021','40000000-0000-4000-8000-000000000004','40000000-0000-4000-8000-000000000011','human','updated','{"node_kind":"doc"}',now(),now()+interval '180 days');

set local role authenticated;
select set_config('request.jwt.claim.sub','40000000-0000-4000-8000-000000000010',true);
select is((select count(*) from public.activity), 1::bigint, 'member reads only own workspace feed');
select is((select count(*) from public.activity where workspace_id='40000000-0000-4000-8000-000000000004'), 0::bigint, 'cross-workspace activity cannot leak');
select throws_ok($$insert into public.activity(workspace_id,actor_kind,verb) values ('40000000-0000-4000-8000-000000000003','human','updated')$$, '42501', null, 'members cannot forge activity rows');
reset role;

update public.activity set expires_at=now()-interval '1 second' where id='40000000-0000-4000-8000-000000000020';
insert into public.activity(workspace_id,actor_kind,verb) values ('40000000-0000-4000-8000-000000000003','system','workspace');
select is((select count(*) from public.activity where id='40000000-0000-4000-8000-000000000020'), 0::bigint, 'insert trigger prunes expired operational history');

select * from finish();
rollback;
