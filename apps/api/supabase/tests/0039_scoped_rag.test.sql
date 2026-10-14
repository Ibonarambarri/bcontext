begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pg_catalog;
select plan(13);

select has_function('public', 'match_nodes', array['vector','uuid','integer','double precision','text','uuid[]'], 'scoped vector RPC exists');
select has_function('public', 'hybrid_search', array['text','vector','uuid','integer','integer','integer','integer','text','uuid[]'], 'scoped hybrid RPC exists');
select is((select prosecdef from pg_proc where oid='public.match_nodes(vector,uuid,integer,double precision,text,uuid[])'::regprocedure), false, 'vector RPC is security invoker');
select is((select prosecdef from pg_proc where oid='public.hybrid_search(text,vector,uuid,integer,integer,integer,integer,text,uuid[])'::regprocedure), false, 'hybrid RPC is security invoker');
select ok((select proconfig @> array['search_path=pg_catalog, public'] from pg_proc where oid='public.match_nodes(vector,uuid,integer,double precision,text,uuid[])'::regprocedure), 'vector RPC pins search_path');
select ok((select prosrc like '%match_node_ids is null or e.node_id = any(match_node_ids)%' from pg_proc where oid='public.hybrid_search(text,vector,uuid,integer,integer,integer,integer,text,uuid[])'::regprocedure), 'hybrid candidates are filtered inside both retrieval lanes');

insert into public.organizations(id, slug, name) values
  ('39000000-0000-4000-8000-000000000001', 'uix-09-a', 'UIX-09 A'),
  ('39000000-0000-4000-8000-000000000002', 'uix-09-b', 'UIX-09 B');
insert into public.workspaces(id, organization_id, slug, name) values
  ('39000000-0000-4000-8000-000000000003', '39000000-0000-4000-8000-000000000001', 'uix-09-a', 'UIX-09 A'),
  ('39000000-0000-4000-8000-000000000004', '39000000-0000-4000-8000-000000000002', 'uix-09-b', 'UIX-09 B');
insert into public.nodes(id,workspace_id,kind,slug,title,content_md,data) values
  ('39000000-0000-4000-8000-000000000010','39000000-0000-4000-8000-000000000003','doc','alpha','Alpha','alpha shared term','{}'),
  ('39000000-0000-4000-8000-000000000011','39000000-0000-4000-8000-000000000003','doc','beta','Beta','beta shared term','{}'),
  ('39000000-0000-4000-8000-000000000012','39000000-0000-4000-8000-000000000004','doc','foreign','Foreign','foreign shared term','{}');

create temp table query_vector(v vector(1536));
insert into query_vector values ((('[' || array_to_string(array_prepend(1.0::float8, array_fill(0.0::float8, array[1535])), ',') || ']')::vector));
grant select on query_vector to authenticated;
insert into public.embeddings(workspace_id,node_id,chunk_index,content,embedding,embedding_version) values
  ('39000000-0000-4000-8000-000000000003','39000000-0000-4000-8000-000000000010',0,'alpha shared term',(select v from query_vector),'test'),
  ('39000000-0000-4000-8000-000000000003','39000000-0000-4000-8000-000000000011',0,'beta shared term',(select v from query_vector),'test'),
  ('39000000-0000-4000-8000-000000000004','39000000-0000-4000-8000-000000000012',0,'foreign shared term',(select v from query_vector),'test');

select is((select count(*) from public.match_nodes((select v from query_vector),'39000000-0000-4000-8000-000000000003',20,-1,'test','{}'::uuid[])), 0::bigint, 'empty explicit scope returns no vector candidates');
select is((select array_agg(node_id order by node_id) from public.match_nodes((select v from query_vector),'39000000-0000-4000-8000-000000000003',20,-1,'test',array['39000000-0000-4000-8000-000000000011']::uuid[])), array['39000000-0000-4000-8000-000000000011']::uuid[], 'selection is applied before vector ranking');
select is((select count(*) from public.match_nodes((select v from query_vector),'39000000-0000-4000-8000-000000000003',20,-1,'test',array['39000000-0000-4000-8000-000000000012']::uuid[])), 0::bigint, 'candidate ids cannot cross the workspace join boundary');
select is((select count(*) from public.hybrid_search('shared',(select v from query_vector),'39000000-0000-4000-8000-000000000003',20,100,100,60,'test','{}'::uuid[])), 0::bigint, 'empty explicit scope returns no hybrid candidates');
select is((select array_agg(node_id order by node_id) from public.hybrid_search('shared',(select v from query_vector),'39000000-0000-4000-8000-000000000003',20,100,100,60,'test',array['39000000-0000-4000-8000-000000000010']::uuid[])), array['39000000-0000-4000-8000-000000000010']::uuid[], 'selection is applied before vector and BM25 fusion');
select is(
  (select array_agg(node_id order by rrf_score desc, node_id) from public.hybrid_search('shared',(select v from query_vector),'39000000-0000-4000-8000-000000000003',20,100,100,60,'test',null)),
  (select array_agg(node_id order by rrf_score desc, node_id) from public.hybrid_search('shared',(select v from query_vector),'39000000-0000-4000-8000-000000000003',20,100,100,60,'test',null)),
  'hybrid ordering is deterministic for equal vectors and text ranks'
);

insert into auth.users(id,email,created_at,updated_at) values
  ('39000000-0000-4000-8000-000000000020','uix09-member@example.test',now(),now()),
  ('39000000-0000-4000-8000-000000000021','uix09-outsider@example.test',now(),now());
insert into public.memberships(user_id,workspace_id,role) values
  ('39000000-0000-4000-8000-000000000020','39000000-0000-4000-8000-000000000003','viewer'),
  ('39000000-0000-4000-8000-000000000021','39000000-0000-4000-8000-000000000004','viewer');
set local role authenticated;
select set_config('request.jwt.claim.sub','39000000-0000-4000-8000-000000000021',true);
select is((select count(*) from public.match_nodes((select v from query_vector),'39000000-0000-4000-8000-000000000003',20,-1,'test',null)), 0::bigint, 'security-invoker retrieval preserves node and embedding RLS for outsiders');
reset role;

select * from finish();
rollback;
