-- 0070_org_billing.sql
--
-- QUÉ
--   Pone el plan y el consumo en la ORGANIZACIÓN: `organizations.plan` con sus
--   punteros de Stripe, un contador `org_usage_counters` por (organización,
--   persona, periodo, medidor) y un techo opcional por persona
--   `organization_member_limits`. Y retira el modelo anterior: `billing_accounts`,
--   `company_member_entitlements`, `user_account_plans`, `account_usage_counters`
--   y `organizations.billing_account_id`.
--
-- POR QUÉ
--   La unidad de venta es la organización, porque es lo que una empresa es: un
--   comprador, un techo, varias personas y varios agentes bebiendo de él. El
--   modelo de 0026 partía el gasto en dos ejes que no se cruzaban — el
--   presupuesto de IA colgaba de la PERSONA (`user_account_plans`) y la
--   capacidad del PROYECTO (`workspaces.plan`) — más una indirección de
--   "empresa" (`billing_accounts`) que centralizaba Stripe. Con eso no había
--   forma de responder "cuánto gasta esta empresa", que es la primera pregunta
--   de cualquier conversación B2B: había que sumar planes de personas que se
--   gastan fuera de la organización y capacidades de workspaces que no se
--   suman entre sí.
--
--   Los cuatro medidores (`ai_queries`, `mcp_calls`, `nodes`,
--   `meeting_minutes`) y sus números viven en
--   `packages/contract/src/billing/org-plans.ts`. Aquí sólo se guarda el id del
--   plan: los límites son producto y cambian con la conversación de pricing,
--   que todavía no ha ocurrido; la base de datos no debe tener que migrarse
--   cada vez que se mueve un número.
--
-- POR QUÉ SE PUEDE BORRAR SIN MIGRAR DATOS
--   Comprobado en producción antes de escribir esto: `billing_accounts` y
--   `company_member_entitlements` están VACÍAS y ninguna fila de
--   `organizations` tiene `billing_account_id`. La indirección de "empresa"
--   nunca llegó a usarse: son conceptos que retirar, no datos que mover.
--   `user_account_plans` ya estaba marcada como retirada en 0066 (nadie la
--   siembra desde que desapareció el trigger de alta) y `account_usage_counters`
--   es su contador: lo que midieran es histórico de un eje que deja de existir,
--   y su sustituto empieza el mes en curso desde cero.
--
-- QUÉ SE QUEDA Y POR QUÉ
--   * `workspaces.plan` (+ `custom_node_limit`, `custom_meeting_hours`) — la
--     capacidad POR PROYECTO sigue siendo real: una organización con veinte
--     workspaces no quiere que uno solo se coma el stock. El plan de
--     organización es el techo de la empresa; el del workspace, el reparto
--     dentro. Retirarlo es otra decisión y otra migración.
--   * `meeting_usage_counters` — minutos por workspace y mes. Sigue siendo el
--     desglose por proyecto; `org_usage_counters` guarda el mismo consumo
--     agregado a la organización y a la persona, que es contra lo que se cobra.
--   * `usage_counters` y `mcp_usage_counters` — contadores por workspace, sin
--     cambios.
--
-- DESTRUCTIVA en cuanto a esquema (borra cuatro tablas y una columna), no en
-- cuanto a datos: las tablas se verificaron vacías o históricas. Volcado antes
-- de ejecutar, como siempre.

begin;

-- ============================================================
-- 1. organizations — el plan, y dónde aterrizará Stripe
-- ============================================================

alter table public.organizations
  add column if not exists plan text not null default 'org_free',
  add column if not exists stripe_customer_id text,
  add column if not exists stripe_subscription_id text,
  add column if not exists plan_updated_at timestamptz not null default now();

-- El check enumera los cuatro ids de org-plans.ts. Es a propósito: un plan que
-- el código no conoce no puede resolver ningún límite, así que una fila con un
-- id inventado sería una organización sin techo — falla al escribir, no al leer.
alter table public.organizations drop constraint if exists organizations_plan_check;
alter table public.organizations add constraint organizations_plan_check
  check (plan in ('org_free', 'org_team', 'org_scale', 'org_custom'));

-- Únicos donde hay valor, libres donde no: la inmensa mayoría de las
-- organizaciones no tienen suscripción y un unique normal las haría colisionar
-- entre sí por el null. Misma forma que los índices de Stripe en 0026.
create unique index if not exists organizations_stripe_customer_idx
  on public.organizations(stripe_customer_id) where stripe_customer_id is not null;
create unique index if not exists organizations_stripe_sub_idx
  on public.organizations(stripe_subscription_id) where stripe_subscription_id is not null;

comment on column public.organizations.plan is
  'Id del plan de organización (org_free|org_team|org_scale|org_custom). Los límites de cada uno viven en packages/contract/src/billing/org-plans.ts, no aquí: son producto y se mueven sin migración.';
comment on column public.organizations.stripe_customer_id is
  'Cliente de Stripe de la organización. La organización es la unidad de venta, así que la suscripción cuelga de ella y no de una persona ni de un workspace.';
comment on column public.organizations.stripe_subscription_id is
  'Suscripción activa de Stripe, si la hay.';
comment on column public.organizations.plan_updated_at is
  'Cuándo cambió el plan por última vez. Sirve para prorratear y para explicar un límite que ayer no estaba.';

-- ============================================================
-- 2. org_usage_counters — el consumo, por organización Y por persona
-- ============================================================
--
-- La persona está en la clave porque el techo por persona
-- (organization_member_limits) necesita saber cuánto lleva gastado ESA
-- persona, y porque la pregunta que sigue a "cuánto gasta esta empresa" es
-- siempre "en qué se lo gasta". Agregar por organización es sumar la
-- columna; el desglose no se puede reconstruir después si no se guardó.

create table if not exists public.org_usage_counters (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  -- Quién consumió. Un token de agente consume por su creador: lo que se mide
  -- es de quién es el gasto, no qué proceso lo emitió.
  user_id         uuid not null references auth.users(id) on delete cascade,
  -- `YYYY-MM` en UTC, la misma convención que el resto de contadores.
  period          text not null,
  -- SÓLO medidores de FLUJO. `nodes` es un STOCK — cuántos nodos tiene la
  -- organización ahora mismo — y se cuenta de la tabla `nodes`, que es la
  -- única que sabe la verdad después de un borrado. Una fila `nodes` aquí
  -- sería un contador que sólo sube mientras el stock baja, y en cuanto
  -- alguien borrara un nodo las dos cifras dejarían de coincidir para
  -- siempre. Es el error que un lector futuro va a querer cometer: no.
  kind            text not null check (kind in ('ai_queries', 'mcp_calls', 'meeting_minutes')),
  count           bigint not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  primary key (organization_id, user_id, period, kind)
);

-- La lectura real es "esta organización, este mes, todos los medidores y todas
-- las personas": la primary key empieza por la organización pero exige el
-- user_id antes del periodo, así que no sirve. Este índice es ese orden.
create index if not exists org_usage_counters_org_period_idx
  on public.org_usage_counters(organization_id, period);

comment on table public.org_usage_counters is
  'Consumo de flujo por (organización, persona, periodo YYYY-MM, medidor). Contador, no traza. NO contiene `nodes`: eso es un stock y se cuenta de la tabla nodes.';
comment on column public.org_usage_counters.user_id is
  'La persona a quien se imputa el consumo. Un agente consume por su creador.';
comment on column public.org_usage_counters.kind is
  'Medidor de flujo: ai_queries | mcp_calls | meeting_minutes. `nodes` no cabe aquí a propósito — es un stock.';
comment on column public.org_usage_counters.period is
  'Mes natural en UTC, YYYY-MM. Misma convención que usage_counters, mcp_usage_counters y meeting_usage_counters.';

-- ============================================================
-- 3. organization_member_limits — el techo opcional de una persona
-- ============================================================
--
-- Opcional a propósito: sin ninguna fila, todo el mundo bebe del techo de la
-- organización, que es lo que quiere un equipo pequeño. El administrador pone
-- un número para el caso que de verdad ocurre — una persona, o más a menudo un
-- agente, consumiendo lo que necesita el resto — sin tener que repartir la
-- cuota entera entre todos y volver a repartirla en cada alta.

create table if not exists public.organization_member_limits (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id         uuid not null references auth.users(id) on delete cascade,
  -- Aquí `nodes` SÍ es un valor válido: es un tope sobre el stock que esa
  -- persona ha creado, no un contador.
  kind            text not null check (kind in ('ai_queries', 'mcp_calls', 'nodes', 'meeting_minutes')),
  -- Positivo: "cero" no es un límite, es una expulsión, y para eso está quitar
  -- a la persona de la organización. Ausencia de fila = sin techo propio.
  monthly_limit   integer not null check (monthly_limit > 0),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  primary key (organization_id, user_id, kind)
);

comment on table public.organization_member_limits is
  'Techo opcional de una persona dentro de su organización, por medidor. Sin fila, la persona bebe del techo de la organización. Lo pone un owner/admin de la organización y lo puede levantar él mismo.';
comment on column public.organization_member_limits.monthly_limit is
  'Por mes UTC, salvo `nodes`, que es un total. Estrictamente positivo.';

-- ============================================================
-- 3bis. meeting_bots.created_by — a quién se le imputan los minutos
-- ============================================================
--
-- Los minutos de transcripción se conocen cuando la llamada termina, en el
-- webhook del proveedor, donde no hay nadie autenticado: el que llama es
-- Recall, no una persona. Sin esta columna el consumo se puede imputar a la
-- organización pero no a nadie dentro de ella, que es justo lo que hace falta
-- para que un techo por persona signifique algo. Se guarda quien programó el
-- bot, que es quien decidió gastar.
--
-- Nullable y `on delete set null`: los bots que ya existen no tienen autor, y
-- una baja no debe borrar el histórico de reuniones. Un bot sin autor sigue
-- contando para la organización a través de `meeting_usage_counters`; lo que
-- no puede es contar contra el techo de una persona concreta.

alter table public.meeting_bots
  add column if not exists created_by uuid references auth.users(id) on delete set null;

comment on column public.meeting_bots.created_by is
  'Quién programó el bot. Es a quien se imputan los minutos en org_usage_counters: el webhook del proveedor no tiene sesión y no puede saberlo de otra forma.';

-- ============================================================
-- 4. Incremento atómico, un solo viaje
-- ============================================================
--
-- Existe por lo mismo que `increment_mcp_usage` (0069): PostgREST no sabe
-- expresar `count = count + n`, así que sin esto cada incremento serían dos
-- viajes (leer, escribir) y una carrera entre el proceso api y el worker, que
-- escriben a la vez. Un `insert ... on conflict do update` dentro de la base
-- es atómico y es un solo viaje.

create or replace function public.increment_org_usage(
  p_organization_id uuid,
  p_user_id         uuid,
  p_period          text,
  p_kind            text,
  p_count           bigint default 1
)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.org_usage_counters (organization_id, user_id, period, kind, count)
  values (p_organization_id, p_user_id, p_period, p_kind, greatest(p_count, 0))
  on conflict (organization_id, user_id, period, kind) do update
    set count = public.org_usage_counters.count + greatest(excluded.count, 0),
        updated_at = now();
$$;

comment on function public.increment_org_usage(uuid, uuid, text, text, bigint) is
  'Suma consumo al cubo (organización, persona, periodo, medidor), creándolo si no existe. Atómico: el proceso api y el worker escriben a la vez.';

-- ============================================================
-- 5. RLS — sin políticas, como el resto de contadores
-- ============================================================
--
-- Nadie los lee con la clave de usuario. El servidor los agrega con
-- service_role DESPUÉS de comprobar que quien pregunta administra la
-- organización (`gateOrgAdmin`), que es la misma puerta que el resto de
-- lecturas de organización. Se habilita RLS sin políticas para que la tabla
-- falle cerrada si algún día alguien la consulta con anon — igual que
-- `meeting_usage_counters` y `mcp_usage_counters`.

alter table public.org_usage_counters        enable row level security;
alter table public.organization_member_limits enable row level security;

-- ============================================================
-- 6. Retirada del modelo anterior
-- ============================================================
--
-- El orden lo imponen las claves ajenas: primero la columna de
-- `organizations` que apunta a `billing_accounts`, luego las tablas que
-- dependen de ella, y `billing_accounts` al final. `user_account_plans` y
-- `account_usage_counters` no las referencia nadie.

-- Las tablas primero, y con ellas sus políticas RLS: dos de las de
-- `company_member_entitlements` leen `organizations.billing_account_id`, así
-- que borrar la columna antes que la tabla falla por dependencia. El orden es
-- el inverso al de creación, que es el único que no depende de acordarse.
drop table if exists public.company_member_entitlements;
drop table if exists public.billing_accounts cascade;

drop index if exists public.organizations_billing_account_idx;
alter table public.organizations drop column if exists billing_account_id;
drop table if exists public.account_usage_counters;
drop table if exists public.user_account_plans;

commit;
