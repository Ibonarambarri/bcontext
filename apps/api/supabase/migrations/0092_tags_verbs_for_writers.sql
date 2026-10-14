-- 0092_tags_verbs_for_writers.sql
--
-- QUÉ
--   Todo grant que tenga `write` pasa a tener también `tags:create` y
--   `tags:update`. Lo mismo en las invitaciones aún no aceptadas con verbos
--   explícitos, que al aceptarse copian esa lista a un grant.
--
-- POR QUÉ
--   Dar forma a la taxonomía —crear un tag, describirlo, colgarlo de un
--   padre, relacionarlo con otro— es parte de escribir: los tags nacen de
--   quien archiva el trabajo, y un agente que crea una task bajo un tag que
--   aún no existe tiene que poder crearlo en la misma sesión. Hasta ahora
--   esos verbos solo llegaban con `admin:*`, así que ningún agente normal
--   veía `tags_write` (el lab de agentes lo señaló como su primer tropiezo).
--   `verbsForScopes` y `verbsForRole` ya los reparten así para los grants
--   nuevos; esta migración iguala los que ya existen, porque `resolveGrant`
--   lee la fila tal cual y no vuelve a derivarla de los scopes.
--
--   `tags:delete` (merge y borrado) sigue siendo de administradores: mueve la
--   clasificación de todo lo que colgaba del tag absorbido y, cuando los
--   reaches se expresan en tags, reescribe los reaches de otros principals.
--
--   Se añade solo lo que falta y al final, sin reordenar: `verbs` es un
--   conjunto, pero no hay motivo para tocar filas que ya están bien.

begin;

update public.workspace_grants
set verbs = verbs
      || case when 'tags:create' = any(verbs) then '{}'::text[] else array['tags:create'] end
      || case when 'tags:update' = any(verbs) then '{}'::text[] else array['tags:update'] end,
    updated_at = now()
where 'write' = any(verbs)
  and not ('tags:create' = any(verbs) and 'tags:update' = any(verbs));

update public.workspace_invites
set verbs = verbs
      || case when 'tags:create' = any(verbs) then '{}'::text[] else array['tags:create'] end
      || case when 'tags:update' = any(verbs) then '{}'::text[] else array['tags:update'] end
where verbs is not null
  and accepted_at is null
  and 'write' = any(verbs)
  and not ('tags:create' = any(verbs) and 'tags:update' = any(verbs));

commit;
