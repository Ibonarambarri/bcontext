-- 0088_plan_catalog.sql
--
-- QUÉ
--   Los planes dejan de ser una constante del código y pasan a ser un
--   catálogo en la base: `plans`. Cada fila dice qué incluye un plan, si se
--   enseña, si se puede asignar y si es de una organización concreta. Con
--   ello llegan los tres planes de early users —$20, $30 y $40 de crédito— y
--   la contabilidad de ese crédito: `organization_credits` (el saldo) y
--   `organization_credit_grants` (de dónde salió cada dólar).
--
-- POR QUÉ SACARLOS DEL CÓDIGO
--   `packages/contract/src/billing/org-plans.ts` era el sitio correcto
--   mientras los planes eran cuatro ideas provisionales que sólo el producto
--   cambiaba. Ya no: hay que poder tener un plan a medida para UNA empresa
--   con la que se ha hablado, apagar un plan sin borrarlo porque todavía hay
--   quien lo usa, y enseñar unos sí y otros no. Nada de eso cabe en una
--   constante: sería un despliegue por cada conversación comercial, y un plan
--   a medida de un cliente viviría en el repositorio de todos.
--
--   Lo que NO se mueve: los medidores (`ai_queries`, `mcp_calls`, `nodes`,
--   `meeting_minutes`) siguen siendo vocabulario del producto y siguen en el
--   contrato. Aquí se guardan sus números, no sus nombres.
--
-- POR QUÉ EL CRÉDITO NO ES MENSUAL
--   Un plan de early user no es una suscripción: es una cantidad de dinero
--   que alguien puede gastar en el producto. Si se gasta en cinco días, se
--   gastó; si dura un año, dura un año. Modelarlo como un techo mensual
--   diría lo contrario —que el mes que viene vuelve a haber— y obligaría a
--   inventar una fecha de renovación que nadie ha prometido. Por eso el saldo
--   es un par de números que sólo suben: lo concedido y lo gastado. La resta
--   es lo que queda.
--
-- POR QUÉ EL GASTO LO LLEVA UN TRIGGER
--   El coste real de cada llamada ya se escribe fila a fila en
--   `ai_usage_events.cost_usd` (0047). El saldo es esa suma, y mantenerla al
--   vuelo es lo único que permite decidir en una petición si queda crédito
--   sin sumar la tabla entera. Se hace en la base y no en TypeScript porque
--   hay tres procesos escribiendo ahí (api, worker, errors) y porque el
--   `upsert ... ignoreDuplicates` del emisor ya garantiza que un reintento no
--   inserta dos veces: el trigger cuenta inserciones reales, así que no puede
--   cobrar dos veces por la misma llamada.
--
-- POR QUÉ `plans.id` ES TEXTO Y NO UUID
--   Un id de plan se escribe en un correo, en una conversación y en un log
--   (`early_30`), y `organizations.plan` ya era texto con esos valores. Un
--   uuid obligaría a migrar los datos existentes para no ganar nada.

begin;

-- ============================================================
-- 1. plans — el catálogo
-- ============================================================

create table if not exists public.plans (
  id text primary key,
  name text not null,
  description text,

  -- Lo que paga la empresa. `null` es "hablamos": un plan a medida no tiene
  -- precio de catálogo, y cero es un precio de verdad (gratis).
  price_usd numeric(10, 2),

  -- Crédito de un solo uso, en dólares. `null` = este plan no funciona por
  -- crédito sino por los techos mensuales de `limits`.
  credit_usd numeric(10, 2) check (credit_usd is null or credit_usd >= 0),

  -- `one_off`: se concede una vez y dura hasta gastarse.
  -- `monthly`: los techos de `limits` se reinician cada mes natural.
  billing_kind text not null default 'monthly'
    check (billing_kind in ('one_off', 'monthly')),

  -- Los cuatro medidores, con la misma convención que el contrato: una clave
  -- ausente o a null es "sin techo". Se guarda como jsonb y no como cuatro
  -- columnas porque los medidores son producto y se añaden; una columna por
  -- medidor sería una migración cada vez que aparezca el quinto.
  limits jsonb not null default '{}'::jsonb,

  -- Si se enseña donde se enseñan los planes (pricing, la pantalla de plan de
  -- la organización). Un plan invisible existe y funciona: sólo no se anuncia.
  visible boolean not null default false,
  -- Si se puede asignar a alguien hoy. Apagar esto es la forma de retirar un
  -- plan sin tocar a quien ya lo tiene.
  assignable boolean not null default true,

  -- No null = plan a medida de esa organización, y de nadie más. Es lo que
  -- permite cerrar un trato particular sin ensuciar el catálogo común.
  organization_id uuid references public.organizations(id) on delete cascade,

  sort_order integer not null default 100,
  -- Retirado: ni se enseña ni se asigna, y se queda para que las filas que lo
  -- apuntan sigan significando algo. Borrar un plan que alguien tuvo es
  -- perder la respuesta a "¿en qué estaba esta empresa?".
  retired_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- La lectura del catálogo es siempre "los que puedo asignar, en orden".
create index if not exists plans_assignable_idx
  on public.plans (assignable, sort_order)
  where retired_at is null;

-- Y la otra: "¿tiene esta organización un plan hecho para ella?".
create index if not exists plans_organization_idx
  on public.plans (organization_id)
  where organization_id is not null;

comment on table public.plans is
  'Catálogo de planes. Sustituye a la constante ORG_PLANS del contrato: un plan a medida para una empresa concreta o un plan apagado no caben en un fichero del repositorio.';
comment on column public.plans.credit_usd is
  'Crédito de un solo uso en dólares. No se renueva: cuando se gasta, se gasta. null = el plan va por techos mensuales.';
comment on column public.plans.limits is
  'Techos por medidor, misma convención que el contrato: clave ausente o null = sin techo. jsonb y no columnas porque los medidores son producto.';
comment on column public.plans.visible is
  'Si se anuncia. Un plan invisible sigue siendo asignable y sigue funcionando.';
comment on column public.plans.assignable is
  'Si se le puede dar a alguien hoy. Apagarlo retira el plan sin tocar a quien ya lo tiene.';
comment on column public.plans.organization_id is
  'No null = plan a medida, sólo asignable a esa organización.';

-- ============================================================
-- 2. El catálogo inicial
-- ============================================================
--
-- Los cuatro ids que ya existían se siembran tal cual, con los números que
-- tenían en el contrato: hay organizaciones apuntando a ellos y la clave
-- ajena del paso 3 no puede quedarse sin destino. `org_custom` queda como
-- estaba —sin techos— y es el que usa quien negoció algo que aún no tiene
-- fila propia.
--
-- Encima de ellos, los tres de early user. Sólo cambian el crédito: es el
-- mismo producto entero, con más o menos dinero por delante. No llevan
-- techos por medidor a propósito — el crédito YA es el techo, y poner dos
-- límites sobre lo mismo significa que el cliente se choca con el que nadie
-- le contó.

insert into public.plans
  (id, name, description, price_usd, credit_usd, billing_kind, limits, visible, assignable, sort_order)
values
  ('org_free', 'Free', 'The old free tier.', 0, null, 'monthly',
   '{"ai_queries": 200, "mcp_calls": 5000, "nodes": 1000, "meeting_minutes": 0}'::jsonb,
   false, false, 10),
  ('org_team', 'Team', 'The old team tier.', 49, null, 'monthly',
   '{"ai_queries": 2000, "mcp_calls": 100000, "nodes": 20000, "meeting_minutes": 600}'::jsonb,
   false, false, 20),
  ('org_scale', 'Scale', 'The old scale tier.', 199, null, 'monthly',
   '{"ai_queries": 10000, "mcp_calls": 1000000, "nodes": 200000, "meeting_minutes": 3000}'::jsonb,
   false, false, 30),
  ('org_custom', 'Custom', 'Negotiated, no ceilings.', null, null, 'monthly',
   '{}'::jsonb, false, true, 90),

  ('early_20', 'Early · $20', 'Early access with $20 of credit. It lasts until it is spent.',
   0, 20, 'one_off', '{}'::jsonb, false, true, 1),
  ('early_30', 'Early · $30', 'Early access with $30 of credit. It lasts until it is spent.',
   0, 30, 'one_off', '{}'::jsonb, false, true, 2),
  ('early_40', 'Early · $40', 'Early access with $40 of credit. It lasts until it is spent.',
   0, 40, 'one_off', '{}'::jsonb, false, true, 3)
on conflict (id) do nothing;

-- ============================================================
-- 3. organizations.plan pasa a apuntar al catálogo
-- ============================================================
--
-- El CHECK enumeraba los cuatro ids a mano; con un catálogo eso es la clave
-- ajena, que además impide inventarse un plan que nadie definió. `on delete
-- restrict` es deliberado: un plan con clientes dentro no se borra, se
-- retira (`retired_at`), y esta restricción es lo que convierte esa frase en
-- algo que la base hace cumplir.

alter table public.organizations drop constraint if exists organizations_plan_check;

alter table public.organizations drop constraint if exists organizations_plan_fkey;
alter table public.organizations
  add constraint organizations_plan_fkey
  foreign key (plan) references public.plans(id)
  on update cascade on delete restrict;

comment on column public.organizations.plan is
  'Id del plan en `plans`. Antes era un CHECK con cuatro literales; ahora el catálogo es una tabla y esto es su clave ajena.';

-- ============================================================
-- 4. El saldo de crédito
-- ============================================================

create table if not exists public.organization_credits (
  organization_id uuid primary key
    references public.organizations(id) on delete cascade,
  -- Los dos sólo suben. El saldo es la resta, y guardarlo aparte sería un
  -- tercer número con el que los otros dos pueden dejar de cuadrar.
  granted_usd numeric(12, 6) not null default 0 check (granted_usd >= 0),
  spent_usd   numeric(12, 6) not null default 0 check (spent_usd >= 0),
  updated_at timestamptz not null default now()
);

comment on table public.organization_credits is
  'Saldo de crédito de una organización: concedido y gastado, ambos monótonos. Lo que queda es la resta. El gasto lo mantiene un trigger sobre ai_usage_events.';

-- De dónde salió cada dólar. El saldo responde "cuánto queda"; esto responde
-- "por qué", que es la pregunta que se hace tres meses después.
create table if not exists public.organization_credit_grants (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null
    references public.organizations(id) on delete cascade,
  -- El plan que lo motivó, si lo hubo. Una recarga manual no tiene plan.
  plan_id text references public.plans(id) on update cascade on delete set null,
  amount_usd numeric(12, 6) not null check (amount_usd > 0),
  note text,
  granted_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists organization_credit_grants_org_idx
  on public.organization_credit_grants (organization_id, created_at desc);

comment on table public.organization_credit_grants is
  'Historia de las concesiones de crédito. El saldo dice cuánto queda; esto, de dónde vino.';

-- ============================================================
-- 5. Conceder y gastar
-- ============================================================

create or replace function public.grant_org_credit(
  p_organization_id uuid,
  p_amount_usd numeric,
  p_plan_id text default null,
  p_note text default null,
  p_granted_by uuid default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_amount_usd is null or p_amount_usd <= 0 then
    return;
  end if;

  insert into public.organization_credit_grants
    (organization_id, plan_id, amount_usd, note, granted_by)
  values (p_organization_id, p_plan_id, p_amount_usd, p_note, p_granted_by);

  insert into public.organization_credits (organization_id, granted_usd)
  values (p_organization_id, p_amount_usd)
  on conflict (organization_id) do update
    set granted_usd = public.organization_credits.granted_usd + excluded.granted_usd,
        updated_at = now();
end;
$$;

comment on function public.grant_org_credit(uuid, numeric, text, text, uuid) is
  'Añade crédito a una organización y deja constancia de por qué. Los dos escritos van juntos: un saldo que sube sin fila que lo explique es dinero aparecido de la nada.';

-- El gasto: un trigger por fila insertada en ai_usage_events. La
-- organización se saca del workspace, que es lo único que la fila conoce.
create or replace function public.spend_org_credit_from_usage()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid;
begin
  if new.cost_usd is null or new.cost_usd <= 0 then
    return new;
  end if;

  select w.organization_id into v_org
    from public.workspaces w
   where w.id = new.workspace_id;

  if v_org is null then
    return new;
  end if;

  -- `insert ... on conflict` y no un update: una organización que nunca ha
  -- recibido crédito no tiene fila, y su gasto sigue siendo un dato — es lo
  -- que se mira el día que se le concede el primero.
  insert into public.organization_credits (organization_id, spent_usd)
  values (v_org, new.cost_usd)
  on conflict (organization_id) do update
    set spent_usd = public.organization_credits.spent_usd + excluded.spent_usd,
        updated_at = now();

  return new;
end;
$$;

drop trigger if exists ai_usage_events_spend_credit on public.ai_usage_events;
create trigger ai_usage_events_spend_credit
  after insert on public.ai_usage_events
  for each row execute function public.spend_org_credit_from_usage();

comment on function public.spend_org_credit_from_usage() is
  'Suma el coste de cada llamada de IA al gastado de su organización. AFTER INSERT: el emisor hace upsert con ignoreDuplicates, así que un reintento no dispara el trigger y no se cobra dos veces.';

-- ============================================================
-- 6. RLS
-- ============================================================
--
-- `plans` se lee desde el servidor con service_role, igual que el resto de
-- billing: quién puede ver qué planes lo decide el motor de permisos, no la
-- base. Los planes a medida de una empresa hacen esto obligatorio — una
-- política de lectura para `authenticated` enseñaría a todo el mundo el
-- precio que negoció el vecino.

alter table public.plans enable row level security;
alter table public.organization_credits enable row level security;
alter table public.organization_credit_grants enable row level security;

commit;
