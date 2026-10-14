-- 0069_mcp_usage_counters.sql
--
-- QUÉ
--   Un contador de llamadas a tools de MCP por (workspace, periodo, tool).
--   Mismo patrón y mismas claves que `usage_counters` (0001) y
--   `meeting_usage_counters` (0026): periodo `YYYY-MM` en UTC, una fila por
--   cubo, un entero que sólo sube.
--
-- POR QUÉ
--   Hoy no se mide lo que más hacen los agentes. `usage_counters` cuenta
--   `node_create`, `account_usage_counters` cuenta `ai_query` y
--   `meeting_usage_counters` cuenta minutos de reunión. Una recuperación
--   (`nodes(op=search)`) o un listado sobre MCP no deja rastro en ninguno de
--   los tres: `activity` sólo registra ESCRITURAS, así que un agente puede
--   leer el grafo entero de una empresa durante un mes y en la pantalla de
--   consumo no aparece nada. Es justo la operación más frecuente y la que más
--   cuesta servir.
--
--   Sin esta tabla la pestaña de consumo de la organización no puede dar una
--   sola cifra de "esto es lo que se está usando": puede decir cuánto se ha
--   escrito y cuánta IA se ha gastado, pero no cuánto se ha LEÍDO. Lo que
--   falta no es la pantalla, es la medida.
--
-- POR QUÉ POR TOOL Y NO UN TOTAL
--   Porque las tools no cuestan lo mismo ni significan lo mismo: `ping` es
--   ruido, `nodes(op=search)` es una recuperación con embeddings detrás.
--   Guardar el nombre permite responder "¿qué está haciendo este agente?" sin
--   volver a instrumentar nada. El nombre es el de la tool tal y como la
--   invoca el cliente — incluidas las tools externas de capability, que se
--   sirven por el mismo camino y también consumen.
--
-- POR QUÉ NO HAY actor NI agent_id
--   Esto es un CONTADOR, no una traza. Una fila por agente y tool convertiría
--   una tabla acotada (workspaces × meses × tools) en uno de auditoría que
--   crece con el tráfico, y para eso ya está `activity`. Si algún día hace
--   falta el desglose por agente, se añade la columna a la clave; hasta
--   entonces, agregado.
--
-- La función `increment_mcp_usage` existe porque PostgREST no sabe hacer
-- `count = count + n`: sin ella cada incremento serían dos viajes (leer,
-- escribir) y una condición de carrera entre el proceso api y el worker.
-- Un `insert ... on conflict do update` dentro de la base es atómico y es un
-- solo viaje, que es lo que permite medir sin encarecer la lectura.

begin;

create table if not exists public.mcp_usage_counters (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  -- `YYYY-MM` en UTC, la misma convención que el resto de contadores. Texto y
  -- no date para que el cubo sea el propio valor y no haya que truncar al leer.
  period       text  not null,
  tool         text  not null,
  calls        bigint not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (workspace_id, period, tool)
);

-- La lectura real es "todos los workspaces de una organización, en este mes":
-- se resuelve la lista de workspaces y se pide el periodo. La primary key ya
-- sirve para el acceso por workspace; este índice es para el otro orden, que
-- es el que usa la pantalla de consumo.
create index if not exists mcp_usage_counters_period_idx
  on public.mcp_usage_counters(period, workspace_id);

comment on table public.mcp_usage_counters is
  'Llamadas a tools de MCP agregadas por (workspace, periodo YYYY-MM, tool). Contador, no traza: no hay agente ni timestamp por llamada. Es la única medida de LECTURA del grafo — activity sólo registra escrituras.';
comment on column public.mcp_usage_counters.period is
  'Mes natural en UTC, YYYY-MM. Misma convención que usage_counters, account_usage_counters y meeting_usage_counters.';
comment on column public.mcp_usage_counters.tool is
  'Nombre de la tool tal y como la invoca el cliente, incluidas las tools externas de capability.';

-- ============================================================
-- Incremento atómico, un solo viaje
-- ============================================================

create or replace function public.increment_mcp_usage(
  p_workspace_id uuid,
  p_period       text,
  p_tool         text,
  p_calls        bigint default 1
)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.mcp_usage_counters (workspace_id, period, tool, calls)
  values (p_workspace_id, p_period, p_tool, greatest(p_calls, 0))
  on conflict (workspace_id, period, tool) do update
    set calls = public.mcp_usage_counters.calls + greatest(excluded.calls, 0),
        updated_at = now();
$$;

comment on function public.increment_mcp_usage(uuid, text, text, bigint) is
  'Suma llamadas al cubo (workspace, periodo, tool), creándolo si no existe. Atómico: el proceso api y el worker escriben a la vez.';

-- ============================================================
-- RLS
-- ============================================================
--
-- Como el resto de contadores: nadie los lee con la clave de usuario. El
-- servidor los agrega con service_role tras comprobar que quien pregunta
-- administra la organización. Se habilita RLS sin políticas para que la
-- tabla falle cerrada si algún día alguien la consulta con anon.

alter table public.mcp_usage_counters enable row level security;

commit;
