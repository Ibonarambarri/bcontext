-- 0081_api_tokens_last_brief_at.sql
--
-- QUÉ
--   `api_tokens.last_brief_at`: cuándo pidió este token su último `brief`.
--
-- POR QUÉ
--   La tool `brief` (MCP, solo lectura) devuelve "qué ha cambiado desde la
--   última vez" sin que el agente tenga que guardar un `since` entre sesiones:
--   lo recuerda el servidor, por token. Es la pieza que hace útil la primera
--   llamada de una sesión al día 30, no solo el día 1.
--
-- CÓMO
--   Columna nullable, sin índice: se lee y se escribe por id de token, una vez
--   por brief. Nulo hasta el primer brief, y entonces `brief` devuelve los
--   últimos cambios sin acotar. Los tokens OAuth y los de usuario viven en
--   otras tablas y no la tienen: para ellos `brief` acepta `since` explícito.

begin;

alter table api_tokens add column if not exists last_brief_at timestamptz;

comment on column api_tokens.last_brief_at is
  'Momento del último brief pedido con este token; brief lo usa como since del feed de cambios.';

commit;
