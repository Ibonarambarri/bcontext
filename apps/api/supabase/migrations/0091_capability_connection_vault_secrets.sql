-- 0091_capability_connection_vault_secrets.sql
--
-- Static credentials of capability connections (auth bearer/header) become
-- self-service: the admin pastes the token in the product, the API stores it
-- in Supabase Vault and the row keeps only a `vault:<uuid>` reference — the
-- same shape the managed OAuth tables use since 0034. The environment-variable
-- convention from 0031 (`BCONTEXT_CAP_*`, read from the API process) is
-- retired: it made every new provider an operator task and never worked for a
-- customer. No row in production uses it, so there is nothing to migrate.

alter table capability_connections
  drop constraint if exists capability_connections_secret_ref_check;
alter table capability_connections
  add constraint capability_connections_secret_ref_check
  check (
    secret_ref is null
    or secret_ref ~ '^vault:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  );

-- A Vault entry lives exactly as long as the reference that points at it.
-- Every write stores a fresh entry (so a refused update never overwrites the
-- live credential), which means the previous one has to go when the reference
-- changes — replace, switch to none/oauth — and when the row is deleted
-- (`remove_capability_provider`, workspace cascade). Doing it here keeps the
-- deletion in the same transaction as the row change; the trigger function is
-- the one 0034 wrote for the OAuth tables, it only looks at `old.secret_ref`.
create trigger capability_connections_delete_secret
  after delete on capability_connections
  for each row execute function public.delete_oauth_vault_secret_on_row_delete();
create trigger capability_connections_replace_secret
  after update of secret_ref on capability_connections
  for each row
  when (old.secret_ref is not null and old.secret_ref is distinct from new.secret_ref)
  execute function public.delete_oauth_vault_secret_on_row_delete();
