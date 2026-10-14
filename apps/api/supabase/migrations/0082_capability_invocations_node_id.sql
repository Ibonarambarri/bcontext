-- F09 / C3: a capability invocation can point at the node that saved its
-- result. Set by nodes_write(op=create, provenance) and by accepting an ingest
-- candidate that carries an invocation id — manual and automatic ingest
-- converge on this one column. The node keeps the mirror in
-- `data.provenance` ({ source: 'capability', capability, tool, invocation_id }).
begin;

alter table public.capability_invocations
  add column if not exists node_id uuid references public.nodes(id) on delete set null;

create index if not exists capability_invocations_node_idx
  on public.capability_invocations(node_id)
  where node_id is not null;

commit;
