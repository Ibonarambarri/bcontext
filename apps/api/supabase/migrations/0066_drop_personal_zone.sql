-- 0066_drop_personal_zone.sql
--
-- QUÉ
--   Retira por completo la "zona personal": el flag `workspaces.is_personal`,
--   el trigger que provisionaba una org + un workspace privados por cada alta
--   en auth.users (0027, reescrito en 0043), el backstop que prohibía invitar
--   a esas orgs (0028) y los datos que quedaron de todo eso.
--
-- POR QUÉ
--   El modelo pasa a ser: una ORGANIZACIÓN contiene MUCHOS workspaces, y un
--   workspace se direcciona como `<org>/<workspace>` (ver 0067). La zona
--   personal era una org de un solo workspace, no invitable y no compartible,
--   creada a espaldas del usuario en el momento del alta. En el modelo nuevo
--   no hay nada que la distinga de un workspace normal salvo el hecho de
--   estar aislada, así que el concepto entero desaparece en vez de quedarse
--   como un caso especial que hay que recordar en cada consulta.
--
-- POR QUÉ NADA SUSTITUYE AL TRIGGER
--   `provision_personal_zone()` hacía dos cosas: crear la zona personal y
--   sembrar una fila en `public.user_account_plans` (plan por usuario, eje 1
--   del rediseño de billing de 0026). Las dos se retiran:
--     * La zona personal, por lo dicho arriba. El alta ya no crea nada; el
--       usuario entra a una organización (invitado o creándola) y desde ahí
--       crea workspaces. Provisionar en un trigger sobre auth.users siempre
--       fue frágil — el cuerpo tragaba TODAS las excepciones para no romper
--       el signup, así que un fallo era invisible y dependía de un reintento
--       perezoso en código de aplicación.
--     * El eje "plan por usuario" se retira: la facturación pasa a ser por
--       organización / workspace. `user_account_plans` NO se borra en esta
--       migración (todavía hay lecturas en src/lib/billing) pero deja de
--       escribirse en el alta y queda marcada como retirada con un
--       `comment on table`. Su borrado va en la migración que cierre billing.
--
--   Es decir: tras esta migración auth.users no tiene NINGÚN trigger de
--   provisión. Es intencional.
--
-- DESTRUCTIVA. Borra workspaces, sus nodos y las orgs que los contenían.
-- Léela entera antes de ejecutarla.

begin;

-- ============================================================
-- 1. Triggers y funciones — primero los triggers, luego las funciones
--    (una función no se puede borrar mientras un trigger la referencia).
-- ============================================================

drop trigger if exists provision_personal_zone_on_insert   on auth.users;
drop trigger if exists provision_personal_zone_on_password on auth.users;
drop function if exists public.provision_personal_zone();

drop trigger if exists reject_personal_zone_invite on public.workspace_invites;
drop function if exists public.reject_personal_zone_invite();

-- ============================================================
-- 2. user_account_plans — se queda, pero ya nadie la escribe
-- ============================================================

comment on table public.user_account_plans is
  'RETIRADA (0066): eje "plan por usuario" del rediseño de billing 0026. Ya no se siembra en el alta — el trigger que lo hacía (provision_personal_zone) se ha borrado y nada lo sustituye, porque la facturación pasa a ser por organización/workspace. Las filas existentes son histórico; no crear ninguna nueva. Se eliminará con la migración que cierre billing.';

-- ============================================================
-- 3. Datos — borrar las zonas personales
--
--    Orden y alcance, explícitos porque esto no se deshace:
--
--    a) Se anotan las orgs que contienen algún workspace personal ANTES de
--       borrar nada; una vez borrado el workspace ya no hay forma de saber
--       qué org era.
--
--    b) `delete from public.workspaces where is_personal` arrastra en
--       cascada (todas las FKs a workspaces(id) del esquema son
--       `on delete cascade`, verificado tabla a tabla): nodes — y con ellos
--       edges, embeddings, node_tags, node_read_activity —, memberships,
--       workspace_grants, tags, saved_views, api_tokens, webhooks y sus
--       entregas, connectors y sus jobs, capability_*, agent_connections,
--       audit_log, ai_usage_events, ingest_candidates, meeting_bots,
--       usage_counters y meeting_usage_counters. No queda huérfano nada que
--       tenga FK. Lo que SÍ sobrevive: los ficheros del bucket de storage
--       `node-images` (Postgres no los conoce) y las filas de
--       `workspace_grants` con principal_kind='agent' apuntando a agentes de
--       otro sitio — no las hay, un agente vive dentro de su workspace.
--
--    c) Las orgs personales se borran solo si cumplen las tres condiciones:
--       ya no les queda ningún workspace, no tienen invitaciones pendientes
--       (una org personal nunca pudo tenerlas: lo impedía el trigger de 0028)
--       y no tienen más miembros que su dueño. Cualquier org que no cumpla
--       las tres se queda: significa que alguien la reutilizó y borrarla
--       destruiría acceso que no es nuestro. `on delete cascade` desde
--       organizations arrastraría organization_memberships y
--       workspace_invites, por eso la condición se comprueba antes.
-- ============================================================

create temporary table _personal_zone_orgs on commit drop as
  select distinct w.organization_id as id
  from public.workspaces w
  where w.is_personal;

delete from public.workspaces where is_personal;

delete from public.organizations o
where o.id in (select id from _personal_zone_orgs)
  and not exists (
    select 1 from public.workspaces w where w.organization_id = o.id
  )
  and not exists (
    select 1 from public.workspace_invites i where i.organization_id = o.id
  )
  and (
    select count(*) from public.organization_memberships om
    where om.organization_id = o.id
  ) <= 1;

-- ============================================================
-- 4. Esquema — el índice antes que la columna sobre la que se define
-- ============================================================

drop index if exists public.workspaces_one_personal_per_org;

-- Sin `cascade` a propósito: si algo (una vista, una policy) todavía depende
-- de la columna, preferimos que esta migración falle y se vea, a que se
-- lleve por delante un objeto que nadie ha revisado.
alter table public.workspaces drop column if exists is_personal;

commit;
