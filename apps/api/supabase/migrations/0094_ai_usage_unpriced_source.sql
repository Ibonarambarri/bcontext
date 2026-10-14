-- 0094_ai_usage_unpriced_source.sql
--
-- QUÉ
--   Tercer valor de `ai_usage_events.cost_source`: `unpriced`, para la
--   llamada que no trajo coste del proveedor Y cuyo modelo no está en la
--   tabla de precios del código. `admin_ai_spend` pasa a contar ese valor
--   como `unpriced_events`.
--
-- POR QUÉ
--   0093 deducía «modelo sin precio» de «coste 0 con tokens», y en
--   producción eso no señalaba ningún modelo sin precio: los 131 eventos
--   que cumplían la condición eran embeddings de 2 a 24 tokens con
--   text-embedding-3-small, que a $0.02 por millón valen menos de la
--   millonésima de dólar que `numeric(12,6)` puede guardar. El panel
--   pintaba en rojo un redondeo. Quien sabe si el modelo tiene precio es
--   el código que tarifica, en el momento de escribir la fila; la base
--   sólo tiene que contar lo que el código le dijo. Las filas históricas
--   se quedan como `fallback`: ninguna corresponde a un modelo sin precio.

begin;

alter table public.ai_usage_events
  drop constraint if exists ai_usage_events_cost_source_check;
alter table public.ai_usage_events
  add constraint ai_usage_events_cost_source_check
  check (cost_source in ('provider', 'fallback', 'unpriced'));

create or replace function public.admin_ai_spend(
  p_since timestamptz default null,
  p_until timestamptz default null,
  p_organization_ids uuid[] default null
)
returns table (
  organization_id uuid,
  events bigint,
  cost_usd numeric,
  unpriced_events bigint
)
language sql
stable
security definer
set search_path = public
as $$
  select
    w.organization_id,
    count(*)::bigint,
    coalesce(sum(e.cost_usd), 0)::numeric,
    count(*) filter (where e.cost_source = 'unpriced')::bigint
  from public.ai_usage_events e
  join public.workspaces w on w.id = e.workspace_id
  where w.organization_id is not null
    and (p_since is null or e.created_at >= p_since)
    and (p_until is null or e.created_at < p_until)
    and (p_organization_ids is null or w.organization_id = any(p_organization_ids))
  group by w.organization_id;
$$;

comment on function public.admin_ai_spend(timestamptz, timestamptz, uuid[]) is
  'Gasto de IA por organización sumado desde ai_usage_events: llamadas, USD y llamadas registradas con cost_source = unpriced (modelo sin precio en el código). Sólo para el panel de administración.';

commit;
