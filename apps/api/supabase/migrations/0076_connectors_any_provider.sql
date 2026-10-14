-- 0076_connectors_any_provider.sql
--
-- Integrations hub: the long tail of connectors is Nango-backed, so
-- `connector_id` is no longer a closed list. Native connectors keep their
-- ids; a Nango-backed install uses the Nango integration unique_key
-- (jira, confluence, airtable, freshdesk, ...) and carries
-- `config.provider = 'nango'` + `config.nango_connection_id`.
--
-- The catalog (src/lib/connectors/catalog.ts) is the allow-list now; the
-- install route refuses ids it does not know, so the DB only needs shape.

alter table connector_installs
  drop constraint if exists connector_installs_connector_id_check;
alter table connector_installs
  add constraint connector_installs_connector_id_check
  check (connector_id ~ '^[a-z0-9][a-z0-9_-]{0,63}$');
