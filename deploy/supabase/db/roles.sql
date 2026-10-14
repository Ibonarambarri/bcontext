-- Runs once, on the first boot of an empty data volume (initdb). The image
-- creates Supabase's service roles without passwords; each service logs in
-- with POSTGRES_PASSWORD. From supabase/supabase docker/volumes/db/roles.sql
-- (Apache-2.0).
\set pgpass `echo "$POSTGRES_PASSWORD"`

ALTER USER authenticator WITH PASSWORD :'pgpass';
ALTER USER pgbouncer WITH PASSWORD :'pgpass';
ALTER USER supabase_auth_admin WITH PASSWORD :'pgpass';
ALTER USER supabase_storage_admin WITH PASSWORD :'pgpass';
