-- 0059_purge_folderless_migration_runs.sql
--
-- WHAT
--   Purga las filas cerradas de `public.folderless_migration_runs` (motor de la
--   migración folderless UIX-21, introducido en 0042 y contraído en 0045).
--
-- WHY
--   Medido en producción el 2026-08-31: 12 filas, todas del 2026-07-18,
--   ocupando 79 MB — el 43 % de la base de datos entera.
--     - 8 `applied`      → 21 MB de rollback_snapshot
--     - 3 `approved`     → 36 MB de rollback_snapshot
--     - 1 `rolled_back`  → 16 MB de rollback_snapshot
--   El peso es casi todo `rollback_snapshot` (73 MB de los 79). Ese snapshot ya
--   no sirve para nada: 0045 retiró el RPC de rollback lógico y dejó escrito en
--   el propio comment de la columna que "rollback_snapshot is restorable only
--   into the pre-0045 schema or by using the managed PITR snapshot". La
--   migración folderless está cerrada; no hay run en curso desde julio.
--
-- DEFENSIVO — qué NO se borra
--   Solo se tocan runs en estado **terminal** (`applied`, `rolled_back`,
--   `failed`) o con una aprobación **caducada** (`approved` con más de 30 días).
--   Nunca se borra un run en vuelo ni pendiente de revisión:
--     `draft`, `needs_review`, `applying`, `rolling_back`
--   (estados definidos en el CHECK de 0042). Además exige `created_at` anterior
--   a hace 30 días, así que un run reciente sobrevive aunque esté en terminal.
--   Si alguien relanzara el motor, esta migración es un no-op para su run.
--
-- CASCADAS
--   `folderless_migration_items` y `folderless_migration_ledger` tienen
--   ON DELETE CASCADE sobre el run: se van con él, que es lo correcto (son la
--   evidencia por-run de esa misma migración).
--   `folderless_workspace_guards.activated_by_run_id` es ON DELETE SET NULL: los
--   guards siguen activos, solo pierden la referencia al run que los activó.
--   `node_redirects.run_id` era NOT NULL + ON DELETE CASCADE, lo que se llevaría
--   por delante los 75 redirects de folders legacy (IDs y slugs antiguos dejarían
--   de resolver). Eso NO es aceptable: los redirects son contrato de lectura
--   público, no evidencia de la migración. Por eso esta migración primero
--   desacopla `node_redirects.run_id` (nullable + SET NULL) y luego borra.
--
-- ESPACIO
--   El DELETE libera el espacio para reutilización pero no devuelve los 79 MB al
--   sistema de ficheros. Autovacuum + el TOAST de la tabla lo harán con el
--   tiempo; para recuperarlo de inmediato hay que ejecutar FUERA de esta
--   migración (no puede ir en una transacción):
--       VACUUM FULL public.folderless_migration_runs;
--   Objetivo tras la purga: base por debajo de 110 MB.

begin;

-- 1) Desacoplar los redirects legacy del run que los creó, para que la purga no
--    se los lleve por cascada.
alter table public.node_redirects
  alter column run_id drop not null;

alter table public.node_redirects
  drop constraint if exists node_redirects_run_id_fkey;

alter table public.node_redirects
  add constraint node_redirects_run_id_fkey
  foreign key (run_id) references public.folderless_migration_runs(id)
  on delete set null;

comment on column public.node_redirects.run_id is
  'Run de folderless_migration_runs que creó el redirect. Nullable desde 0059: los redirects sobreviven a la purga de runs cerrados.';

-- 2) Purgar los runs cerrados y antiguos.
with purged as (
  delete from public.folderless_migration_runs
  where status in ('applied', 'rolled_back', 'failed', 'approved')
    and created_at < now() - interval '30 days'
  returning id, status
)
select count(*) from purged;

commit;
