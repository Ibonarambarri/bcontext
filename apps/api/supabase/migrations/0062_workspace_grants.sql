-- 0062_workspace_grants.sql
--
-- QUÉ
--   La unidad de permiso pasa a ser el par (principal, workspace). Una sola
--   tabla, `workspace_grants`, unifica `memberships` (personas) y
--   `agent_workspace_access` (agentes) y les añade lo que les falta: un
--   **reach**, el subconjunto del grafo que ese principal puede ver ahí.
--
-- POR QUÉ "reach" Y NO "scope"
--   `scope` ya significa dos cosas en este sistema: los permisos OAuth
--   (`nodes:read`) y la lente de consulta del RAG. Esa segunda está diseñada
--   para AMPLIARSE — el modo `auto` siempre añade un carril global y
--   `can_expand_to_workspace` es un campo de primera clase. Un tercer
--   significado, y encima de signo contrario (acotar en vez de ampliar), sería
--   una fuente permanente de confusión en un sitio donde equivocarse es una
--   fuga de datos. Ver `auditoria-de-accesos-a-datos-58-puntos-10-fuera-del-seam`.
--
-- CONTEXTO DE SEGURIDAD — léelo antes de tocar esto
--   Ningún camino de servidor de esta app evalúa RLS: `getStorage()` corre
--   sobre `service_role`. Las políticas existen pero no se ejercitan. Es decir:
--   el filtro que se derive de esta tabla **es la única defensa**, sin red
--   debajo. Por eso el reach se compone de forma ADITIVA (IN, nunca NOT IN):
--   una lista de inclusión falla cerrada cuando aparece un caso nuevo; una de
--   exclusión falla abierta.

begin;

create table if not exists public.workspace_grants (
  id             uuid primary key default uuid_generate_v4(),
  workspace_id   uuid not null references public.workspaces(id) on delete cascade,

  -- Personas y agentes comparten tabla a propósito: el modelo de permisos no
  -- distingue entre "quién" es el principal, solo qué puede hacer y dónde.
  principal_kind text not null check (principal_kind in ('user', 'agent')),
  principal_id   uuid not null,

  -- read/write/delete sobre nodos; tags:create/update/delete sobre taxonomía.
  -- `admin` NO vive aquí: conceder y revocar es de organización, no de
  -- workspace (ver la decisión del modelo de permisos).
  verbs          text[] not null default '{}',

  -- {"type":"all"} o un ViewQuery v1. Versionado para poder evolucionar el
  -- lenguaje sin reescribir filas.
  reach          jsonb not null default '{"type":"all"}'::jsonb,
  reach_version  int    not null default 1,

  granted_by     uuid references auth.users(id) on delete set null,
  expires_at     timestamptz,
  revoked_at     timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  -- UN grant por principal y workspace, no una colección que haya que combinar.
  -- Esta restricción es la que evita tener que responder "¿qué gana cuando un
  -- principal tiene dos grants solapados?", que es donde estos sistemas se
  -- vuelven imposibles de razonar a los seis meses.
  unique (workspace_id, principal_kind, principal_id),

  constraint workspace_grants_reach_is_object check (jsonb_typeof(reach) = 'object'),
  constraint workspace_grants_reach_has_type check (reach ? 'type')
);

comment on table public.workspace_grants is
  'Permiso efectivo del par (principal, workspace): qué verbos y sobre qué parte del grafo. Sustituye a memberships y agent_workspace_access.';
comment on column public.workspace_grants.reach is
  'Subconjunto del grafo alcanzable. {"type":"all"} o un ViewQuery v1. Se compone de forma aditiva; nunca como exclusión.';

-- Resolución: siempre por principal + workspace, descartando revocados y
-- caducados. Es la consulta de la ruta caliente.
create index if not exists workspace_grants_lookup
  on public.workspace_grants (principal_kind, principal_id, workspace_id)
  where revoked_at is null;

-- "Quién tiene acceso a este workspace", para la pantalla de administración.
create index if not exists workspace_grants_by_workspace
  on public.workspace_grants (workspace_id)
  where revoked_at is null;

-- Reutiliza el trigger de 0001_init.sql. Con drop previo porque el resto de
-- esta migración es idempotente y volver a ejecutarla no debe abortarla.
drop trigger if exists workspace_grants_set_updated_at on public.workspace_grants;
create trigger workspace_grants_set_updated_at
  before update on public.workspace_grants
  for each row execute function set_updated_at();

alter table public.workspace_grants enable row level security;

-- RLS como defensa en profundidad para el día que algún camino deje de usar
-- service_role. Hoy no se ejercita (ver cabecera), pero un grant nunca debe ser
-- legible por quien no es su dueño ni administrador del workspace.
drop policy if exists workspace_grants_self_read on public.workspace_grants;
create policy workspace_grants_self_read on public.workspace_grants
  for select using (
    (principal_kind = 'user' and principal_id = auth.uid())
    or exists (
      select 1 from public.memberships m
      where m.workspace_id = workspace_grants.workspace_id
        and m.user_id = auth.uid()
        and m.role in ('owner', 'admin')
    )
  );

-- ── Sin backfill, a propósito ──────────────────────────────────────────────
-- La primera versión de esta migración copiaba `memberships` y
-- `agent_workspace_access` a filas de grant, traduciendo roles y scopes a
-- verbos en SQL. Esa traducción ya existe en TypeScript (`verbsForRole` y
-- `verbsForScopes` en src/lib/auth/grants.ts), y las dos copias ya habían
-- divergido antes de aplicarse: el SQL daba a `editor` solo read+write cuando
-- el TS le da también delete, y traducía a cero verbos cualquier conexión
-- cuyos scopes fueran `chat:run` o `agents:read`.
--
-- Como `resolveGrant` intersecta el grant con la respuesta legacy, gana siempre
-- la más estrecha — es decir, la copia SQL. Aplicar la migración habría
-- revocado el borrado a todos los miembros no-owner y dejado sin acceso a los
-- agentes de chat, incumpliendo justo lo que esta migración promete.
--
-- Dos fuentes de verdad para la misma traducción es una clase de bug, no un
-- bug. Así que la tabla nace vacía: `resolveGrant` sigue cayendo a las tablas
-- legacy, el comportamiento no cambia, y la primera fila se escribirá cuando
-- exista el camino de administración que sepa qué verbos poner.

commit;

-- ── Qué NO hace esta migración ─────────────────────────────────────────────
--   No borra `memberships` ni `agent_workspace_access`. Siguen siendo la
--   fuente de verdad hasta que el código lea de `workspace_grants` y se haya
--   verificado en producción. Retirarlas es un segundo paso, igual que con los
--   endpoints de cron en F01: primero convivir, luego cortar.
