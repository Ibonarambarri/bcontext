-- UIX-21 production correction after 0043.
--
-- `tags_identity` deliberately derives normalized_name and slug from `name`.
-- The original 0042 apply function supplied the legacy folder title as name,
-- so a reviewed semantic identity such as `graph-views` could be overwritten
-- by a structural title such as `15 — Graph views`. 0042 is corrected for
-- clean installs; this migration surgically replaces the already-installed
-- function body on databases where 0042 is recorded.

do $migration$
declare
  function_definition text;
  legacy_expression constant text :=
    'coalesce(nullif(item_row.entry ->> ''title'', ''''), item_row.entry #>> ''{taxonomy_action,normalized_name}'')';
  semantic_expression constant text :=
    'item_row.entry #>> ''{taxonomy_action,normalized_name}''';
  corrected_identity_pair constant text :=
    'item_row.entry #>> ''{taxonomy_action,normalized_name}'',' || chr(10) ||
    '          item_row.entry #>> ''{taxonomy_action,normalized_name}'',';
  legacy_occurrences integer;
begin
  if to_regprocedure('public.apply_folderless_migration_plan(uuid,text)') is null then
    raise exception using errcode = '42883', message = 'folderless_apply_function_missing';
  end if;

  select pg_get_functiondef('public.apply_folderless_migration_plan(uuid,text)'::regprocedure)
    into function_definition;
  legacy_occurrences := (
    length(function_definition) - length(replace(function_definition, legacy_expression, ''))
  ) / length(legacy_expression);

  if legacy_occurrences = 1 then
    execute replace(function_definition, legacy_expression, semantic_expression);
  elsif legacy_occurrences > 1 then
    raise exception using errcode = '55000', message = 'folderless_apply_identity_patch_ambiguous';
  elsif position(corrected_identity_pair in function_definition) = 0 then
    raise exception using errcode = '55000', message = 'folderless_apply_identity_patch_target_missing';
  end if;
end;
$migration$;

revoke all on function public.apply_folderless_migration_plan(uuid, text)
  from public, anon, authenticated;
grant execute on function public.apply_folderless_migration_plan(uuid, text)
  to service_role;
