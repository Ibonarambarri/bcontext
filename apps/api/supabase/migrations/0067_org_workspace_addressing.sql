-- 0067_org_workspace_addressing.sql
--
-- QUÉ
--   Fija el direccionamiento del modelo nuevo, el que queda después de
--   retirar la zona personal (0066): una ORGANIZACIÓN contiene MUCHOS
--   workspaces, y un workspace se nombra siempre como `<org>/<workspace>`.
--
-- POR QUÉ ESTA MIGRACIÓN CASI NO HACE NADA
--   Porque el esquema ya lo soportaba desde 0001_init.sql y se ha verificado
--   antes de escribir esto:
--     * `organizations.slug text unique not null` — el slug de organización
--       ya es único globalmente (constraint `organizations_slug_key`).
--     * `workspaces ... unique (organization_id, slug)` — el slug de
--       workspace ya es único DENTRO de su organización, no globalmente
--       (constraint `workspaces_organization_id_slug_key`).
--   Las dos juntas son exactamente lo que hace que `<org>/<workspace>`
--   identifique a un workspace y solo a uno. Lo que faltaba no era la
--   restricción, era que estuviera escrita en algún sitio: quien lea la tabla
--   dentro de seis meses no puede tener que deducir la regla de direccionado
--   a partir de dos `unique` sueltos.
--
--   Los dos bloques `do` de abajo son cinturón y tirantes: comprueban que la
--   unicidad existe y la crean si en alguna base se hubiera perdido. En una
--   base sana no hacen nada.
--
-- LA REGLA, PARA QUE NO HAYA DUDA
--   * El slug se genera a partir del nombre (minúsculas, guiones) y, si ya
--     existe uno igual en su ámbito, se le añade un sufijo numérico:
--     `roadmap`, `roadmap-2`, `roadmap-3`. El ámbito del slug de workspace es
--     su organización; el del slug de org, toda la instalación.
--   * El slug es INMUTABLE una vez creado. Es la parte estable de la URL y de
--     todo lo que un agente haya memorizado (`<org>/<workspace>` aparece en
--     tokens, en invitaciones y en las instrucciones del MCP). Renombrar el
--     workspace cambia `name`, nunca `slug`.
--
-- No borra ni reescribe ninguna fila.

begin;

-- ============================================================
-- Unicidad — solo se crea si falta
-- ============================================================

-- Slug de organización: único globalmente.
do $$
begin
  if not exists (
    select 1
    from pg_index i
    join pg_class t on t.oid = i.indrelid
    join pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'public'
      and t.relname = 'organizations'
      and i.indisunique
      and i.indnatts = 1
      and i.indkey[0] = (
        select attnum from pg_attribute
        where attrelid = t.oid and attname = 'slug' and not attisdropped
      )
  ) then
    alter table public.organizations
      add constraint organizations_slug_key unique (slug);
  end if;
end $$;

-- Slug de workspace: único dentro de su organización, no fuera.
do $$
begin
  if not exists (
    select 1
    from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'public'
      and t.relname = 'workspaces'
      and c.contype = 'u'
      and c.conkey @> array[
        (select attnum from pg_attribute
          where attrelid = t.oid and attname = 'organization_id' and not attisdropped),
        (select attnum from pg_attribute
          where attrelid = t.oid and attname = 'slug' and not attisdropped)
      ]::int2[]
      and array_length(c.conkey, 1) = 2
  ) then
    alter table public.workspaces
      add constraint workspaces_organization_id_slug_key unique (organization_id, slug);
  end if;
end $$;

-- ============================================================
-- La regla, escrita donde se lee la tabla
-- ============================================================

comment on table public.organizations is
  'Una organización agrupa MUCHOS workspaces; es la unidad de pertenencia (organization_memberships), de invitación (workspace_invites) y de facturación. Su slug es único en toda la instalación y es el primer segmento de la dirección de cualquier workspace: <org>/<workspace>.';

comment on column public.organizations.slug is
  'Identificador estable de la organización, único globalmente. Se genera del nombre (minúsculas + guiones) con sufijo numérico si colisiona (acme, acme-2). Inmutable una vez creado: forma parte de la dirección <org>/<workspace> que viven en URLs, tokens e invitaciones.';

comment on table public.workspaces is
  'Un workspace (proyecto) dentro de una organización. Una organización tiene muchos. Se direcciona como <org>/<workspace>; nunca por slug a secas.';

comment on column public.workspaces.slug is
  'Identificador estable del workspace, único DENTRO de su organización (no globalmente): la dirección completa es <org>/<workspace>. Se genera del nombre (minúsculas + guiones) con sufijo numérico si colisiona dentro de la misma org (roadmap, roadmap-2). Inmutable una vez creado; renombrar cambia name, nunca slug.';

commit;
