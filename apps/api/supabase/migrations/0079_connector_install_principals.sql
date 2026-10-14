-- 0079_connector_install_principals.sql
--
-- QUÉ
--   Cada instalación de Slack pasa a ser un principal propio, para que un
--   administrador pueda acotar lo que el bot ve («solo finanzas», «solo lo
--   etiquetado como público») igual que acota a una persona o a un agente.
--
-- POR QUÉ
--   `/bcontext search` corre autenticado por el HMAC de la instalación, sin
--   persona detrás, y cualquiera en el canal lo dispara. Hasta ahora eso se
--   resolvía con `systemGrant("slack install <id>")`: explícito y auditable,
--   pero acceso total sin sitio donde guardar otra cosa. Auditoría de accesos
--   de F02, punto 5 — el último de los diez fuera del seam sin cerrar.
--
-- CÓMO
--   La instalación se modela como `capability_principals` (kind
--   `service_account`, source_type `connector_install`, source_id el id del
--   install), que ya representa principales que no son personas ni agentes de
--   token. Su permiso vive en `workspace_grants` como cualquier otro par
--   (principal, workspace): principal_kind `service_account`, principal_id el
--   id del principal. Solo `read`: el bot busca, no escribe.
--
-- REACH POR DEFECTO — decisión consciente, no herencia silenciosa
--   `{"type":"all"}`: la instalación ve todo el workspace hasta que un
--   administrador la acote. Es exactamente lo que hacía el `systemGrant`, así
--   que ninguna integración existente cambia de comportamiento; la diferencia
--   es que ahora hay una fila que estrechar y la respuesta de instalación lo
--   dice en voz alta (ver src/lib/auth/install-principal.ts).

begin;

alter table public.capability_principals
  drop constraint if exists capability_principals_source_type_check;
alter table public.capability_principals
  add constraint capability_principals_source_type_check
  check (source_type in (
    'user', 'agent', 'agent_token', 'team', 'service_account', 'connector_install'
  ));

alter table public.workspace_grants
  drop constraint if exists workspace_grants_principal_kind_check;
alter table public.workspace_grants
  add constraint workspace_grants_principal_kind_check
  check (principal_kind in ('user', 'agent', 'service_account'));

comment on column public.workspace_grants.principal_kind is
  'user | agent | service_account. service_account apunta a capability_principals.id (p. ej. una instalación de Slack).';

-- ── Backfill de las instalaciones que ya existen ───────────────────────────
-- Quien ya tenía Slack conectado recibe su principal y su grant con reach
-- `all`, es decir, sigue exactamente como estaba, pero desde hoy es acotable
-- sin reinstalar. `on conflict do nothing` porque el código escribe estas
-- mismas filas al instalar y esta migración puede correr después de un
-- deploy que ya lo hizo.
insert into public.capability_principals (
  workspace_id, kind, source_type, source_id, display_name
)
select
  ci.workspace_id,
  'service_account',
  'connector_install',
  ci.id::text,
  'Slack bot' || coalesce(' (' || (ci.config->>'team_name') || ')', '')
from public.connector_installs ci
where ci.connector_id = 'slack'
  and ci.status <> 'uninstalled'
on conflict (workspace_id, source_type, source_id) do nothing;

insert into public.workspace_grants (
  workspace_id, principal_kind, principal_id, verbs, reach
)
select
  cp.workspace_id,
  'service_account',
  cp.id,
  array['read']::text[],
  '{"type":"all"}'::jsonb
from public.capability_principals cp
join public.connector_installs ci
  on ci.id::text = cp.source_id and ci.workspace_id = cp.workspace_id
where cp.source_type = 'connector_install'
  and ci.connector_id = 'slack'
  and ci.status <> 'uninstalled'
on conflict (workspace_id, principal_kind, principal_id) do nothing;

commit;

-- ── Qué NO hace esta migración ─────────────────────────────────────────────
--   No toca RLS: `workspace_grants_self_read` ya deja leer a los admins del
--   workspace y `capability_principals_admin_all` ya es solo-admin; un
--   service_account no inicia sesión, así que no necesita política propia.
--   No crea principales para otros conectores: solo Slack recupera contenido
--   en nombre de un canal; GitHub, Linear y Notion ingieren como sistema.
