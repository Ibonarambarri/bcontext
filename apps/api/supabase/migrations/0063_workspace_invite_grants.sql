-- 0063_workspace_invite_grants.sql
--
-- QUÉ
--   Una invitación deja de ser sólo "email + rol de organización" y pasa a
--   poder llevar el permiso completo que tendrá el invitado al aceptar: los
--   verbos, el reach y el workspace concreto. Es el hermano de `grantAccess`
--   (0062) para alguien que todavía no existe como principal.
--
-- POR QUÉ EL PERMISO VIVE EN LA INVITACIÓN Y NO EN UN GRANT
--   Una invitación NO crea una fila en `workspace_grants`. Si lo hiciera,
--   habría acceso concedido a nadie: no aparece en "quién tiene acceso" con
--   una cara detrás, nadie lo revisa y nadie lo revoca. El grant nace en el
--   momento de aceptar, y sólo entonces, con la revalidación que hace
--   `acceptInvitation` en src/lib/auth/invitations.ts.
--
-- POR QUÉ NULLABLE
--   `verbs` y `reach` son NULL en toda invitación existente y en las que sigue
--   creando la pantalla de miembros (`createInvite` en orgs.ts), que sólo
--   conoce el rol de organización. NULL significa exactamente eso: "invitación
--   de rol, sin permiso de workspace adjunto", y `acceptInvitation` delega en
--   el camino de aceptación de siempre. Un default no-nulo habría convertido
--   filas históricas en permisos que nadie concedió.
--
-- EL CORREO ES LA ÚNICA ACCIÓN IRREVERSIBLE DEL SISTEMA
--   Conceder, revocar y borrar se deshacen dentro de la base. Un email no.
--   `delivery_state` existe para que un agente pueda preparar una invitación
--   sin que salga nada de la casa: las que crea un agente nacen en 'held' y
--   necesitan que una persona las libere. Ver la cabecera de invitations.ts.
--
-- Sin backfill: no hay ninguna traducción que hacer, y la que existe (rol →
-- verbos) vive en TypeScript (`verbsForRole`). Duplicarla en SQL fue justo el
-- error que 0062 documenta.

begin;

alter table public.workspace_invites
  -- Qué workspace (proyecto) recibirá el grant. NULL en las invitaciones de
  -- sólo-rol, que actúan sobre la organización entera.
  add column if not exists workspace_id uuid
    references public.workspaces(id) on delete cascade,

  -- El permiso prometido. Mismo vocabulario que workspace_grants.verbs.
  add column if not exists verbs text[],

  -- {"type":"all"} o un ViewQuery v1, igual que workspace_grants.reach.
  add column if not exists reach jsonb,
  add column if not exists reach_version int not null default 1,

  -- Nombre opcional del invitado, para que el email y la pantalla no tengan
  -- que llamarle por su dirección de correo.
  add column if not exists invitee_name text,

  -- Quién invitó, con la misma distinción que la auditoría: persona o agente.
  -- `invited_by` (auth.users) ya existía y sigue siendo el humano responsable;
  -- cuando invita un agente, es el humano que lo conectó.
  add column if not exists invited_by_kind text not null default 'user',
  add column if not exists invited_by_agent_id uuid
    references public.agents(id) on delete set null,

  -- pending: lista para enviarse. held: creada por un agente, retenida hasta
  -- que una persona la libere. sent/failed: resultado del envío.
  add column if not exists delivery_state text not null default 'pending';

-- Los checks van aparte y con drop previo: `add constraint if not exists` no
-- existe en Postgres, y esta migración tiene que poder reejecutarse.
alter table public.workspace_invites
  drop constraint if exists workspace_invites_invited_by_kind_check;
alter table public.workspace_invites
  add constraint workspace_invites_invited_by_kind_check
  check (invited_by_kind in ('user', 'agent'));

alter table public.workspace_invites
  drop constraint if exists workspace_invites_delivery_state_check;
alter table public.workspace_invites
  add constraint workspace_invites_delivery_state_check
  check (delivery_state in ('pending', 'held', 'sent', 'failed'));

-- Una invitación con permiso adjunto tiene que decir sobre qué workspace, o
-- al aceptar no habría dónde escribir el grant. Las de sólo-rol (verbs null)
-- siguen siendo válidas sin workspace_id.
alter table public.workspace_invites
  drop constraint if exists workspace_invites_verbs_need_workspace;
alter table public.workspace_invites
  add constraint workspace_invites_verbs_need_workspace
  check (verbs is null or workspace_id is not null);

-- El reach se lee con el mismo parser defensivo que el de los grants, pero un
-- valor que ni siquiera es un objeto con `type` no debería llegar a guardarse.
alter table public.workspace_invites
  drop constraint if exists workspace_invites_reach_shape;
alter table public.workspace_invites
  add constraint workspace_invites_reach_shape
  check (reach is null or (jsonb_typeof(reach) = 'object' and reach ? 'type'));

comment on column public.workspace_invites.verbs is
  'Verbos que tendrá el invitado al aceptar. NULL = invitación de sólo-rol. No hay grant vivo hasta que se acepta.';
comment on column public.workspace_invites.reach is
  'Reach prometido: {"type":"all"} o un ViewQuery v1. Se revalida contra lo que el invitador tenga EN EL MOMENTO de aceptar.';
comment on column public.workspace_invites.delivery_state is
  'held = creada por un agente y retenida: enviar un correo es la única acción irreversible del sistema y no la dispara una máquina sola.';

-- La cola de envío: pocas filas, consultada por estado.
create index if not exists workspace_invites_delivery_idx
  on public.workspace_invites (organization_id, delivery_state)
  where accepted_at is null;

-- El límite de frecuencia de los agentes se cuenta desde esta misma tabla, sin
-- una tabla de contadores que mantener: "cuántas ha creado un agente en esta
-- organización en la última hora".
create index if not exists workspace_invites_agent_rate_idx
  on public.workspace_invites (organization_id, created_at)
  where invited_by_kind = 'agent';

commit;

-- ── Qué NO hace esta migración ─────────────────────────────────────────────
--   No toca `workspace_grants`: una invitación pendiente no es acceso. Y no
--   cambia el comportamiento de ninguna invitación existente — todas quedan
--   con verbs NULL, reach NULL y delivery_state 'pending', que es exactamente
--   lo que hacían antes.
