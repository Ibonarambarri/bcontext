-- 0095_billing_single_org_level.sql
--
-- QUÉ
--   Colapsa la facturación a UN solo nivel: la organización. Retira de
--   `workspaces` el plan (`plan`, `plan_updated_at`), los punteros de Stripe
--   (`stripe_customer_id`, `stripe_subscription_id`) y los asientos (`seats`).
--   Conserva `custom_node_limit` y `custom_meeting_hours`, que dejan de ser
--   "los límites del plan ws_custom" y pasan a ser una CUOTA que la
--   organización asigna a un workspace.
--
-- POR QUÉ
--   Había dos suscripciones para el mismo cliente. `organizations` (0070) tiene
--   plan y Stripe porque la unidad de venta es la empresa; `workspaces` (0009,
--   revisado en 0026) seguía teniendo los suyos porque así nació el producto.
--   Con los dos vivos, "¿cuánto paga esta empresa?" no tiene respuesta —hay que
--   sumar una suscripción de organización con N suscripciones de workspace que
--   Stripe factura por separado— y el mismo cliente podía estar a la vez en
--   org_free y en ws_scale, dos techos que se contradicen. El comentario de
--   0070 decía que retirarlo era "otra decisión y otra migración": esta es.
--
--   Lo que un workspace puede tener se DERIVA ahora del plan de la
--   organización en el catálogo `plans` (0088) — `workspaceCapacity` en
--   `packages/contract/src/billing/plan-catalog.ts` — y se resuelve en un
--   único sitio, `getWorkspaceEntitlements` (`src/lib/billing/entitlements.ts`).
--
-- QUÉ SE QUEDA Y POR QUÉ
--   * `custom_node_limit` / `custom_meeting_hours` — siguen teniendo un uso
--     legítimo, pero otro: son la cuota que la organización reparte entre sus
--     proyectos ("este workspace de pruebas no se come el stock de la empresa").
--     Sólo pueden ESTRECHAR lo que concede el plan, nunca ampliarlo: si
--     pudieran ampliarlo serían una forma de comprar capacidad sin pagarla.
--     Por eso se quedan y por eso el código aplica el mínimo de los dos.
--   * `usage_counters`, `mcp_usage_counters`, `meeting_usage_counters` — sin
--     cambios: son el desglose por proyecto de un consumo que se cobra a la
--     organización (`org_usage_counters`). Medir por workspace nunca fue el
--     problema; cobrar por workspace sí.
--
-- QUÉ SE VA Y POR QUÉ
--   * `workspaces.plan` + `plan_updated_at` — no hay plan de workspace.
--   * `workspaces.seats` — asientos de una suscripción por workspace que ya no
--     existe. Ningún código la lee desde 0026 ("seats are gone"): es residuo.
--   * `workspaces.stripe_customer_id` / `stripe_subscription_id` — un
--     workspace no es cliente de Stripe.
--
-- DATOS: PROMOCIÓN ANTES DE BORRAR
--   El paso 1 sube al nivel de organización lo que hubiera abajo, y no da nada
--   por hecho: si una organización sigue en `org_free` pero uno de sus
--   workspaces tenía plan de pago, la empresa PAGÓ por eso y quedarse en free
--   sería quitarle el producto que compró. El mapeo es el mismo que aplica
--   `orgPlanFromPriceId` a los price ids antiguos:
--
--       ws_pro    -> org_team      ws_scale  -> org_scale
--       ws_custom -> org_custom    ws_free   -> nada que promover
--
--   Si dos workspaces de la misma organización tenían planes distintos, gana
--   el mayor: el techo compartido tiene que cubrir al proyecto más grande.
--   Sólo se promueven organizaciones que siguen en uno de los cuatro planes
--   históricos (`org_free|team|scale|custom`): una organización en un plan
--   del catálogo asignado a mano (los `early_*` de crédito, uno a medida) lo
--   tiene porque alguien lo decidió, y pisarlo con un plan de catálogo le
--   quitaría el crédito o el trato. Si hubiera alguna con workspaces de pago,
--   el archivo del paso 0 lo deja escrito para resolverlo a mano.
--   Los destinos (`org_team`, `org_scale`, `org_custom`) existen como filas de
--   `plans` desde 0088, así que la clave ajena `organizations_plan_fkey` se
--   cumple.
--   Los punteros de Stripe se copian sólo si la organización no tenía ya los
--   suyos (una organización no puede tener dos suscripciones activas; si las
--   hubiera, la de la organización es la vigente y la del workspace hay que
--   cancelarla A MANO en Stripe — esta migración no habla con Stripe).
--
--   El paso 2 deja constancia de lo que había en `workspaces_billing_legacy`,
--   una tabla-archivo: sin ella, borrar las columnas destruye la única prueba
--   de qué compró cada quien, y la conciliación posterior con Stripe se hace a
--   ciegas. Se puede borrar cuando la conciliación esté hecha.
--
-- DESTRUCTIVA en esquema (borra cinco columnas de `workspaces`). Volcado
-- antes de ejecutar, como siempre. Comprobar antes de aplicar:
--
--   select plan, count(*) from public.workspaces group by 1;
--   select count(*) from public.workspaces where stripe_subscription_id is not null;
--
-- Si ambas dicen que sólo hay `ws_free` y ninguna suscripción, los pasos 1 y 2
-- no mueven nada y esto es puramente una limpieza de esquema.

-- ORDEN DE DESPLIEGUE — EL CÓDIGO VA PRIMERO, NO ESTA MIGRACIÓN
--   Es al revés de lo que sugiere la intuición ("la base de datos primero").
--   El código que corre HOY en producción lee estas columnas:
--
--     src/lib/billing/entitlements.ts
--       .from("workspaces").select("id, plan, organization_id, …")
--
--   PostgREST resuelve ese `select` contra el esquema real, así que en cuanto
--   `plan` desaparece la consulta falla y CADA comprobación de entitlements
--   devuelve error. Aplicar esto antes de desplegar tumba la API.
--
--   Secuencia correcta:
--     1. Desplegar el código que ya no lee estas columnas (deriva el techo del
--        plan de la organización). Funciona con el esquema viejo: no las
--        selecciona, y que sigan existiendo le da igual.
--     2. Aplicar esta migración.
--
--   El riesgo inverso —que un workspace de pago pierda capacidad entre el paso
--   1 y el 2— sólo existe si hay workspaces de pago en organizaciones
--   gratuitas. Las dos consultas de arriba lo dicen; si todo es `ws_free` y no
--   hay suscripciones, la ventana entre 1 y 2 no tiene ningún efecto
--   observable y puede durar lo que haga falta.
--
--   Ensayada sobre los datos reales el 2026-09-07 (transacción + rollback),
--   cuando se escribió como 0075: corría limpia y archivaba 0 filas. Desde
--   entonces `workspaces` ha ganado columnas que esta migración no toca;
--   ninguna migración posterior (0076–0094) lee las cinco que se borran, y
--   ninguna vista ni función de la base depende de ellas. Antes de aplicar,
--   repetir el ensayo (`begin; \i …; rollback;`) contra prod.
--
-- COMPROBACIONES
--   Antes (con el código nuevo ya desplegado):
--     select plan, count(*) from public.workspaces group by 1;
--     select count(*) from public.workspaces where stripe_subscription_id is not null;
--   Después:
--     select column_name from information_schema.columns
--      where table_schema = 'public' and table_name = 'workspaces'
--        and column_name in ('plan','seats','stripe_customer_id','stripe_subscription_id','plan_updated_at');
--     -- 0 filas
--     select count(*) from public.workspaces_billing_legacy;
--     -- igual al número de workspaces que no eran ws_free o tenían Stripe
--     select relrowsecurity from pg_class where oid = 'public.workspaces_billing_legacy'::regclass;
--     -- true
--
-- MARCHA ATRÁS
--   El esquema se puede reponer, el dato de las filas ws_free no: sólo se
--   archivó lo que no era gratis. Recrear las columnas como estaban (0009 +
--   0026: `plan text not null default 'ws_free'` con su CHECK de los cuatro
--   ws_*, `seats integer not null default 1`, los dos `stripe_*` con sus
--   índices únicos parciales, `plan_updated_at timestamptz default now()`) y
--   rellenarlas desde `workspaces_billing_legacy`. Las promociones del paso 1
--   se deshacen con `organization_plan_before` del archivo. Sólo tiene
--   sentido junto con revertir el código: el de después de esta migración no
--   lee ninguna de estas columnas.

begin;

-- ============================================================
-- 0. Archivo: qué tenía cada workspace antes de borrarlo
-- ============================================================

-- Sin clave foránea a `workspaces` a propósito. Con `on delete cascade`,
-- borrar el workspace borraría la prueba de qué se le vendió — que es
-- exactamente lo que esta tabla existe para conservar, y borrar un workspace es
-- mucho más probable que volver a tocar estas columnas. Un hecho histórico
-- sobrevive al borrado de aquello a lo que le pasó.
create table if not exists public.workspaces_billing_legacy (
  workspace_id             uuid primary key,
  organization_id          uuid,
  plan                     text,
  seats                    integer,
  stripe_customer_id       text,
  stripe_subscription_id   text,
  plan_updated_at          timestamptz,
  organization_plan_before text,
  archived_at              timestamptz not null default now()
);

-- RLS obligatoria: `anon` y `authenticated` tienen grants completos sobre todo
-- `public` y PostgREST los expone, así que una tabla sin RLS es legible y
-- escribible con la anon key, que viaja en el bundle del navegador. Las 65
-- tablas de producción la tienen activada; ésta guarda punteros de Stripe.
-- Sin políticas: falla cerrada para todo el mundo, y `service_role` la salta.
alter table public.workspaces_billing_legacy enable row level security;

comment on table public.workspaces_billing_legacy is
  'Archivo de la facturación por workspace retirada en 0095. Existe para poder conciliar con Stripe las suscripciones vendidas por proyecto antes del colapso a un solo nivel. Borrable cuando esa conciliación esté hecha; nada la lee en runtime.';

-- `organization_plan_before` se captura AQUÍ, antes del paso 1, porque después
-- de promover no hay forma de reconstruirlo: `plan_updated_at = now()` es
-- indistinguible de un cambio de plan hecho a mano. Esto es un cambio
-- automático que mueve ingresos; cuando alguien pregunte por qué una empresa
-- está en `org_scale` sin haber pagado nunca a ese nivel, la respuesta está
-- en esta columna.
insert into public.workspaces_billing_legacy (
  workspace_id, organization_id, plan, seats,
  stripe_customer_id, stripe_subscription_id, plan_updated_at,
  organization_plan_before
)
select w.id, w.organization_id, w.plan, w.seats,
       w.stripe_customer_id, w.stripe_subscription_id, w.plan_updated_at,
       o.plan
from public.workspaces w
left join public.organizations o on o.id = w.organization_id
where w.plan is distinct from 'ws_free'
   or w.stripe_customer_id is not null
   or w.stripe_subscription_id is not null
on conflict (workspace_id) do nothing;

-- ============================================================
-- 1. Promoción del plan al nivel que paga
-- ============================================================
--
-- `rank` ordena los planes para poder quedarse con el mayor por organización.
-- org_custom gana a todo: es un acuerdo firmado, y degradarlo a un plan de
-- catálogo es romper un contrato.

with promoted as (
  select
    w.organization_id,
    max(case w.plan
          when 'ws_custom' then 3
          when 'ws_scale'  then 2
          when 'ws_pro'    then 1
          else 0
        end) as rank
  from public.workspaces w
  where w.organization_id is not null
  group by w.organization_id
),
target as (
  select organization_id,
         case rank when 3 then 'org_custom'
                   when 2 then 'org_scale'
                   when 1 then 'org_team'
         end as plan
  from promoted
  where rank > 0
)
update public.organizations o
set plan = t.plan,
    plan_updated_at = now()
from target t
where o.id = t.organization_id
  and o.plan in ('org_free', 'org_team', 'org_scale', 'org_custom')
  -- Sólo se sube, nunca se baja: una organización que ya está en un plan de
  -- pago igual o mayor no se toca.
  and case o.plan
        when 'org_custom' then 3
        when 'org_scale'  then 2
        when 'org_team'   then 1
        else 0
      end
      < case t.plan
          when 'org_custom' then 3
          when 'org_scale'  then 2
          when 'org_team'   then 1
          else 0
        end;

-- Punteros de Stripe: sólo donde la organización no tenía ninguno. `distinct
-- on` elige un workspace por organización de forma determinista (el más
-- reciente en cambiar de plan), porque copiar dos suscripciones a una sola
-- fila no significa nada.
with source as (
  select distinct on (w.organization_id)
         w.organization_id, w.stripe_customer_id, w.stripe_subscription_id
  from public.workspaces w
  where w.organization_id is not null
    and w.stripe_customer_id is not null
  order by w.organization_id, w.plan_updated_at desc nulls last
)
update public.organizations o
set stripe_customer_id     = coalesce(o.stripe_customer_id, s.stripe_customer_id),
    stripe_subscription_id = coalesce(o.stripe_subscription_id, s.stripe_subscription_id)
from source s
where o.id = s.organization_id
  and o.stripe_customer_id is null
  -- Ambos nulos o ninguno: si la organización tuviera suscripción pero no
  -- customer (estado roto pero posible si algo falló a medias), copiar sólo el
  -- customer emparejaría un cliente nuevo con una suscripción vieja.
  and o.stripe_subscription_id is null;

-- ============================================================
-- 2. Retirada de las columnas de facturación de `workspaces`
-- ============================================================

drop index if exists public.workspaces_stripe_customer_idx;
drop index if exists public.workspaces_stripe_subscription_idx;

alter table public.workspaces drop constraint if exists workspaces_plan_check;

alter table public.workspaces
  drop column if exists plan,
  drop column if exists seats,
  drop column if exists stripe_customer_id,
  drop column if exists stripe_subscription_id,
  drop column if exists plan_updated_at;

-- ============================================================
-- 3. Lo que se queda cambia de significado: cuota, no plan
-- ============================================================

comment on column public.workspaces.custom_node_limit is
  'Cuota de nodos que la organización asigna a ESTE workspace. No es un plan: sólo puede estrechar el techo que concede el plan de la organización (el código aplica el mínimo de los dos), nunca ampliarlo. NULL = sin cuota, el workspace bebe del techo de la organización.';
comment on column public.workspaces.custom_meeting_hours is
  'Cuota de horas de reunión al mes para ESTE workspace, con la misma regla que custom_node_limit: estrecha, nunca amplía. NULL = sin cuota.';

commit;
