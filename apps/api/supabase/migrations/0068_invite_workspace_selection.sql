-- 0068 — a qué workspaces entra quien acepta una invitación.
--
-- Hasta ahora aceptar una invitación de organización daba de alta a la
-- persona en **todos** los workspaces existentes de esa org, con el mismo
-- rol. Eso funcionaba porque cada workspace tenía su propia organización:
-- "todos" era siempre uno. Con organizaciones de verdad, que agrupan varios
-- proyectos, "todos" es justo lo que no queremos — el caso que el owner pidió
-- explícitamente es "esta persona entra, pero el proyecto de finanzas no lo
-- ve".
--
-- Así que la invitación dice a qué entra. `workspace_ids` es la lista elegida
-- al invitar; vacía o nula significa "solo pertenencia a la organización",
-- que es lo correcto para un owner o admin, cuyo acceso a los workspaces sale
-- de su rol en la org y no de filas por proyecto.
--
-- `workspace_id` (0063) se queda como está: es otra cosa — la invitación que
-- lleva verbos y alcance adjuntos para UN workspace concreto.

begin;

alter table public.workspace_invites
  add column if not exists workspace_ids uuid[];

comment on column public.workspace_invites.workspace_ids is
  'Workspaces the invitee joins on acceptance. Null/empty means organization membership only — which is all an owner or admin needs, since their role reaches every workspace in the org.';

commit;
