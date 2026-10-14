-- 0074_error_telemetry.sql
--
-- QUÉ
--   Dos tablas —`error_groups` y `error_events`— y la función que las
--   escribe, `record_error_event`. Es el destino del colector de errores
--   (proceso `errors`, src/errors/): la API, el worker, la web y el navegador
--   mandan lo que se ha roto y aquí queda, agrupado, para el panel de admin.
--
-- POR QUÉ AQUÍ Y NO EN UNA PLATAFORMA
--   Porque lo único que se necesita los primeros meses es "qué se ha roto,
--   dónde, a quién y cuántas veces", y eso son dos tablas. Lo que se paga en
--   una plataforma de APM no es el almacenamiento, es el agrupado, la
--   retención y las alertas; el agrupado está en `fingerprint`, la retención
--   en `purge_error_telemetry` y las alertas caben en un webhook. Cuando el
--   volumen justifique lo otro, esta tabla es exactamente el dato que se
--   exporta.
--
-- POR QUÉ DOS TABLAS Y NO UNA
--   Un listado plano de eventos deja de ser legible el segundo día: un bucle
--   en el worker escribe cuatro mil filas de UN problema y entierra los otros
--   once. `error_groups` es la unidad que un operador atiende (un problema,
--   con su estado de triaje) y `error_events` son sus ocurrencias. El panel
--   lista grupos; los eventos se ven al abrir uno.
--
-- POR QUÉ EL FINGERPRINT LO CALCULA EL COLECTOR Y NO EL EMISOR
--   Porque quien emite no puede elegir su propia clave de agrupado sin poder
--   partir un problema en mil. El colector lo deriva de (tipo de error +
--   operación + las primeras frames normalizadas del stack) y aquí llega ya
--   hecho, como texto opaco y único.
--
-- POR QUÉ EL MUESTREO VIVE EN LA BASE
--   El fallo clásico de un colector propio es el bucle: un error por petición
--   en un endpoint caliente llena el disco en una tarde. `record_error_event`
--   guarda como mucho `sample_cap` eventos por grupo y minuto; el resto sólo
--   incrementa `event_count`. Así el CONTADOR nunca miente aunque las filas
--   estén muestreadas, y el coste por grupo está acotado por arriba.
--   Ponerlo en la función y no en el colector es lo que lo hace atómico: dos
--   réplicas del colector no pueden pasarse el tope entre las dos.
--
-- POR QUÉ users_affected ES UN ARRAY ACOTADO
--   La pregunta real es "¿a cuánta gente le pasa?" y su primera respuesta
--   útil es "a uno / a unos pocos / a todos". Un `count(distinct user_id)`
--   sobre los eventos se paga en cada lectura y además miente en cuanto el
--   muestreo tira filas. Un array de como mucho 50 ids resuelve las dos
--   primeras respuestas exactamente, la tercera de sobra, y está acotado.
--
-- SIN RLS CON POLÍTICAS, A PROPÓSITO
--   Nadie lee esto con la clave del usuario. Escribe el colector con
--   `service_role` y lee la API tras `gateAdmin`. RLS activada y sin
--   políticas para que la tabla falle cerrada si algún día alguien la
--   consulta con anon — mismo patrón que `mcp_usage_counters` (0069).

begin;

-- ============================================================
-- Vocabularios
-- ============================================================
-- Como `check` y no como enum: añadir un valor a un enum en Postgres es una
-- migración que no se puede revertir dentro de una transacción, y estas
-- listas van a crecer (un servicio nuevo, un estado de triaje nuevo). El
-- contrato de TypeScript (`packages/contract/src/errors.ts`) es la copia que
-- leen los dos extremos; esto es sólo el suelo.

create table if not exists public.error_groups (
  id uuid primary key default gen_random_uuid(),

  -- Clave de agrupado. Única: es la identidad del problema.
  fingerprint text not null unique,

  service   text not null check (service in ('api','worker','web','browser','landing')),
  -- El sitio lógico: `mcp.tool:nodes_write`, `rest:POST /api/nodes`,
  -- `job:webhook.drain`, `web.route:/w/[org]/[ws]`. Es la columna por la que
  -- se filtra de verdad; "es de la api" no le ha dicho nunca nada a nadie.
  operation text not null,
  level     text not null default 'error' check (level in ('warning','error','fatal')),
  error_type text,
  -- El mensaje del último evento. Dentro de un grupo los mensajes varían sólo
  -- en sus partes variables, así que el último vale como titular.
  message   text not null,

  status text not null default 'new' check (status in ('new','ack','resolved','ignored')),

  first_seen timestamptz not null default now(),
  last_seen  timestamptz not null default now(),
  -- Cuenta TODAS las ocurrencias, incluidas las que el muestreo no guardó.
  event_count bigint not null default 0,

  -- Hasta 50 usuarios distintos alcanzados; `users_affected` es su cardinal.
  users_seen uuid[] not null default '{}',
  users_affected integer not null default 0,

  first_release text,
  last_release  text,

  resolved_at       timestamptz,
  resolved_release  text,
  -- Lo que el operador aprendió sobre este problema. Suyo, no del emisor.
  note text,

  -- Ventana de muestreo en curso (minuto truncado) y cuántos eventos van
  -- guardados dentro de ella.
  sample_window timestamptz not null default date_trunc('minute', now()),
  sample_count  integer not null default 0,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.error_groups is
  'Un problema, con su estado de triaje y sus contadores. La unidad que atiende un operador; las ocurrencias están en error_events.';
comment on column public.error_groups.fingerprint is
  'Clave de agrupado derivada por el colector de (error_type + operation + frames normalizadas del stack). Opaca: nada la parsea.';
comment on column public.error_groups.event_count is
  'Ocurrencias totales, incluidas las que el muestreo por minuto no llegó a guardar como fila.';
comment on column public.error_groups.users_seen is
  'Hasta 50 usuarios distintos alcanzados. Acotado a propósito: responde "a uno / a unos pocos / a muchos" sin pagar un count(distinct) por lectura.';
comment on column public.error_groups.sample_window is
  'Minuto en curso del muestreo. record_error_event guarda como mucho sample_cap filas por grupo y minuto.';

-- El listado por defecto es "lo que sigue abierto, lo más reciente primero".
create index if not exists error_groups_status_last_seen_idx
  on public.error_groups(status, last_seen desc);
create index if not exists error_groups_last_seen_idx
  on public.error_groups(last_seen desc);
create index if not exists error_groups_service_idx
  on public.error_groups(service, last_seen desc);
create index if not exists error_groups_operation_idx
  on public.error_groups(operation);

-- ============================================================
-- Eventos
-- ============================================================

create table if not exists public.error_events (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.error_groups(id) on delete cascade,

  -- Los dos tiempos, separados siempre: divergen, y la diferencia es en sí
  -- un síntoma (una cola atascada, un navegador que reporta al recargar).
  received_at timestamptz not null default now(),
  occurred_at timestamptz,

  service    text not null,
  operation  text not null,
  level      text not null default 'error',
  error_type text,
  message    text not null,
  stack      text,
  cause      text,

  release     text,
  environment text,
  instance    text,

  -- A quién. Sin FK a auth.users ni a organizations a propósito: un error es
  -- un hecho histórico y borrar una organización no debe borrar la traza de
  -- lo que se le rompió (ni fallar por ella).
  user_id         uuid,
  organization_id uuid,
  workspace_id    uuid,
  actor_type      text check (actor_type is null or actor_type in ('user','agent_token','cron','system','anon')),
  -- El id del token. Nunca el token.
  token_id        text,

  request_id     text,
  correlation_id text,
  method      text,
  path        text,
  status_code integer,
  duration_ms integer,
  user_agent  text,
  url         text,

  job_id   text,
  job_name text,
  attempt  integer,

  -- Lo que valga la pena tener al abrir la fila. Redactado por el emisor y
  -- otra vez por el colector; aquí no entra nunca un cuerpo de petición.
  context jsonb
);

comment on table public.error_events is
  'Una ocurrencia de un error. Muestreada por (grupo, minuto): el contador fiel está en error_groups.event_count.';
comment on column public.error_events.user_id is
  'Sin FK a propósito: un error es un hecho histórico y sobrevive al borrado de la cuenta a la que le pasó.';
comment on column public.error_events.token_id is
  'Identificador del token de agente, nunca el token.';

-- La lectura de la pantalla de detalle: las últimas N de un grupo.
create index if not exists error_events_group_received_idx
  on public.error_events(group_id, received_at desc);
-- La purga y el "cuántos en 24h" del encabezado.
create index if not exists error_events_received_idx
  on public.error_events(received_at desc);
-- "Enséñame todo lo que le ha pasado a esta cuenta", que es la pregunta que
-- se hace cuando alguien escribe quejándose.
create index if not exists error_events_user_idx
  on public.error_events(user_id, received_at desc)
  where user_id is not null;
create index if not exists error_events_request_idx
  on public.error_events(request_id)
  where request_id is not null;

-- ============================================================
-- Escritura: un solo viaje, atómica
-- ============================================================
--
-- Un evento son dos escrituras (upsert del grupo + insert del evento) que
-- tienen que ser una: si se hicieran desde el colector en dos viajes, dos
-- réplicas creando el mismo grupo a la vez se pisarían y el tope de muestreo
-- se repartiría mal. Además, PostgREST no sabe expresar "incrementa" sin
-- leer antes.
--
-- El payload entra como jsonb en vez de como treinta parámetros: la lista de
-- campos crece, y una firma de treinta argumentos es una migración cada vez
-- que se añade uno.

create or replace function public.record_error_event(
  p_fingerprint text,
  p_event jsonb,
  p_sample_cap integer default 5
)
returns table (group_id uuid, stored boolean, event_count bigint)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_group      public.error_groups%rowtype;
  v_now        timestamptz := now();
  v_window     timestamptz := date_trunc('minute', v_now);
  v_user       uuid := nullif(p_event->>'user_id','')::uuid;
  v_service    text := coalesce(p_event->>'service','api');
  v_operation  text := coalesce(p_event->>'operation','unknown');
  v_level      text := coalesce(p_event->>'level','error');
  v_message    text := coalesce(p_event->>'message','(no message)');
  v_release    text := nullif(p_event->>'release','');
  v_stored     boolean := false;
begin
  -- Alta o actualización del grupo. `on conflict` sobre el fingerprint es lo
  -- que hace que dos colectores concurrentes converjan en una sola fila.
  insert into public.error_groups as g (
    fingerprint, service, operation, level, error_type, message,
    first_seen, last_seen, event_count,
    users_seen, users_affected,
    first_release, last_release,
    sample_window, sample_count
  )
  values (
    p_fingerprint, v_service, v_operation, v_level,
    nullif(p_event->>'error_type',''), v_message,
    v_now, v_now, 1,
    case when v_user is null then '{}'::uuid[] else array[v_user] end,
    case when v_user is null then 0 else 1 end,
    v_release, v_release,
    v_window, 1
  )
  on conflict (fingerprint) do update set
    -- El titular es siempre el del último evento: es el que se lee primero.
    message      = v_message,
    level        = v_level,
    last_seen    = v_now,
    last_release = coalesce(v_release, g.last_release),
    event_count  = g.event_count + 1,
    -- Un problema dado por resuelto que vuelve a ocurrir se reabre. Es
    -- justo lo que un listado de "resueltos" no puede ocultar: un arreglo
    -- que no aguantó. `ignored` no se reabre — ignorar es una decisión sobre
    -- el futuro, no sobre el pasado.
    status = case
               when g.status = 'resolved' then 'new'
               else g.status
             end,
    resolved_at = case when g.status = 'resolved' then null else g.resolved_at end,
    users_seen = case
                   when v_user is null or v_user = any(g.users_seen) then g.users_seen
                   when array_length(g.users_seen, 1) >= 50 then g.users_seen
                   else g.users_seen || v_user
                 end,
    users_affected = case
                       when v_user is null or v_user = any(g.users_seen) then g.users_affected
                       when array_length(g.users_seen, 1) >= 50 then g.users_affected
                       else g.users_affected + 1
                     end,
    -- Ventana de muestreo: si cambió el minuto se reinicia el cupo.
    sample_window = case when g.sample_window < v_window then v_window else g.sample_window end,
    sample_count  = case when g.sample_window < v_window then 1 else g.sample_count + 1 end,
    updated_at = v_now
  returning * into v_group;

  -- ¿Cabe la fila? El cupo se mira DESPUÉS del upsert porque el upsert es
  -- quien ya lo ha incrementado: `sample_count <= cap` es "esta ocurrencia
  -- es una de las primeras `cap` del minuto".
  if v_group.sample_count <= greatest(p_sample_cap, 1) then
    insert into public.error_events (
      group_id, received_at, occurred_at,
      service, operation, level, error_type, message, stack, cause,
      release, environment, instance,
      user_id, organization_id, workspace_id, actor_type, token_id,
      request_id, correlation_id, method, path, status_code, duration_ms,
      user_agent, url, job_id, job_name, attempt, context
    )
    values (
      v_group.id, v_now, nullif(p_event->>'occurred_at','')::timestamptz,
      v_service, v_operation, v_level,
      nullif(p_event->>'error_type',''), v_message,
      nullif(p_event->>'stack',''), nullif(p_event->>'cause',''),
      v_release, nullif(p_event->>'environment',''), nullif(p_event->>'instance',''),
      v_user,
      nullif(p_event->>'organization_id','')::uuid,
      nullif(p_event->>'workspace_id','')::uuid,
      nullif(p_event->>'actor_type',''),
      nullif(p_event->>'token_id',''),
      nullif(p_event->>'request_id',''),
      nullif(p_event->>'correlation_id',''),
      nullif(p_event->>'method',''),
      nullif(p_event->>'path',''),
      nullif(p_event->>'status_code','')::integer,
      nullif(p_event->>'duration_ms','')::integer,
      nullif(p_event->>'user_agent',''),
      nullif(p_event->>'url',''),
      nullif(p_event->>'job_id',''),
      nullif(p_event->>'job_name',''),
      nullif(p_event->>'attempt','')::integer,
      case when p_event ? 'context' then p_event->'context' else null end
    );
    v_stored := true;
  end if;

  return query select v_group.id, v_stored, v_group.event_count;
end;
$$;

comment on function public.record_error_event(text, jsonb, integer) is
  'Registra una ocurrencia: upsert del grupo por fingerprint + insert del evento si cabe en el cupo del minuto. Atómica y de un solo viaje; reabre los grupos resueltos que vuelven a ocurrir.';

-- ============================================================
-- Retención
-- ============================================================
--
-- Lo ejecuta el worker una vez al día (cola `errors.retention`). Borra los
-- eventos viejos y, después, los grupos que se quedaron sin ninguno y que
-- nadie ha tocado — un grupo resuelto hace dos meses sin ocurrencias es
-- ruido en el listado, y uno con nota es trabajo de alguien y se queda.

create or replace function public.purge_error_telemetry(
  p_event_days integer default 30,
  p_group_days integer default 90
)
returns table (events_deleted bigint, groups_deleted bigint)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_events bigint;
  v_groups bigint;
begin
  delete from public.error_events
   where received_at < now() - make_interval(days => greatest(p_event_days, 1));
  get diagnostics v_events = row_count;

  delete from public.error_groups g
   where g.last_seen < now() - make_interval(days => greatest(p_group_days, 1))
     and g.note is null
     and not exists (select 1 from public.error_events e where e.group_id = g.id);
  get diagnostics v_groups = row_count;

  return query select v_events, v_groups;
end;
$$;

comment on function public.purge_error_telemetry(integer, integer) is
  'Purga de retención: eventos con más de p_event_days y grupos vacíos, sin nota y sin ocurrencias desde hace p_group_days. La ejecuta la cola errors.retention.';

-- ============================================================
-- RLS
-- ============================================================

alter table public.error_groups enable row level security;
alter table public.error_events enable row level security;

commit;
