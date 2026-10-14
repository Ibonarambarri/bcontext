-- 0089_agent_scopes_credentials_use.sql
--
-- QUÉ
--   `agent_workspace_access_scopes_check` vuelve a contener el vocabulario
--   entero de scopes. Le faltaba `credentials:use`.
--
-- QUÉ SE ROMPIÓ
--   Crear un workspace desde el onboarding. `/api/onboarding/create` acuña un
--   token `claude-code` con TODOS los scopes (`[...SCOPES]`) y, al registrar
--   la conexión del agente, la fila de `agent_workspace_access` violaba este
--   CHECK. La ruta devolvía 500 y no se creaba nada: el alta estaba muerta en
--   producción, no degradada. En la tabla de errores es el grupo
--   `7887905bcf258e63cc5faa3bfdad3dbf`, `rest:POST /api/onboarding/create`.
--
-- POR QUÉ PASÓ
--   El CHECK enumera a mano una lista que vive en
--   `packages/contract/src/auth/scopes.ts`. `credentials:use` se añadió allí
--   con las credenciales tipadas y aquí no: dos copias del mismo vocabulario,
--   una se movió. Nada falla al desplegar —la restricción solo se evalúa al
--   escribir— así que el primer aviso fue un cliente que no pudo entrar.
--
-- POR QUÉ SE MANTIENE EL CHECK EN VEZ DE BORRARLO
--   Porque hace un trabajo que el código no hace: `scopes` es un `text[]` y
--   sin restricción cualquier cadena entra en la tabla que decide qué puede
--   hacer un agente. Lo que se arregla es la deriva, no la restricción: el
--   test `scopes-vocabulary-matches-db.test.ts` compara esta lista con la del
--   contrato y falla en local si vuelven a separarse.

begin;

alter table public.agent_workspace_access
  drop constraint if exists agent_workspace_access_scopes_check;

alter table public.agent_workspace_access
  add constraint agent_workspace_access_scopes_check
  check (scopes <@ array[
    'nodes:read','nodes:write','chat:run','skills:execute',
    'agents:read','agents:write','credentials:use','admin:*'
  ]::text[]);

comment on column public.agent_workspace_access.scopes is
  'Scopes concedidos a este agente en este workspace. El vocabulario lo define packages/contract/src/auth/scopes.ts; el CHECK de esta columna es su copia y un test los mantiene iguales.';

commit;
