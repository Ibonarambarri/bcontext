-- 0093_admin_ai_spend.sql
--
-- QUÉ
--   `admin_ai_spend(p_since, p_until, p_organization_ids)`: el gasto de IA
--   por organización, sumado en la base a partir de `ai_usage_events`.
--   Devuelve una fila por organización con el número de llamadas, el coste
--   en USD y cuántas llamadas se registraron a coste cero pese a consumir
--   tokens.
--
-- POR QUÉ
--   El panel de administración necesita dos números por organización —lo
--   gastado en total y lo gastado en los últimos 30 días— y el dashboard
--   necesita el gasto real del mes en vez de multiplicar llamadas por una
--   constante. Los eventos son miles y crecen a razón de miles al mes;
--   leerlos por páginas para sumarlos en TypeScript es exactamente la
--   consulta que empeora con cada cliente nuevo. La suma se hace donde
--   están los datos.
--
--   `organization_credits.spent_usd` NO sirve para esto: el trigger que lo
--   mantiene llegó con 0088 y no tiene el gasto anterior, y sólo suma filas
--   con coste positivo. Es el saldo que decide si se refusa una llamada;
--   la contabilidad la responde la tabla de eventos.
--
--   `unpriced_events` señala un fallo concreto: una llamada tarificada por
--   la tabla de precios del código (`cost_source = 'fallback'`) que consumió
--   tokens y salió a 0 sólo puede ser un modelo que no está en esa tabla.
--   Es la cifra que el operador mira para saber si la contabilidad se ha
--   quedado atrás respecto a la configuración de modelos.
--
--   `security definer` y sólo para `service_role`, como el resto de
--   funciones del panel: quién puede ver el gasto de una organización lo
--   decide `gateAdmin` en la API, no la base.

begin;

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
    count(*) filter (
      where e.cost_usd = 0
        and e.cost_source = 'fallback'
        and (e.tokens_input + e.tokens_output) > 0
    )::bigint
  from public.ai_usage_events e
  join public.workspaces w on w.id = e.workspace_id
  where w.organization_id is not null
    and (p_since is null or e.created_at >= p_since)
    and (p_until is null or e.created_at < p_until)
    and (p_organization_ids is null or w.organization_id = any(p_organization_ids))
  group by w.organization_id;
$$;

comment on function public.admin_ai_spend(timestamptz, timestamptz, uuid[]) is
  'Gasto de IA por organización sumado desde ai_usage_events: llamadas, USD y llamadas a coste cero con tokens (modelo sin precio). Sólo para el panel de administración.';

revoke all on function public.admin_ai_spend(timestamptz, timestamptz, uuid[]) from public, anon, authenticated;
grant execute on function public.admin_ai_spend(timestamptz, timestamptz, uuid[]) to service_role;

commit;
