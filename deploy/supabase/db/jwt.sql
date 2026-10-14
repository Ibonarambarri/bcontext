-- Runs once on initdb: the JWT lifetime PostgREST and the auth helpers read.
-- From supabase/supabase docker/volumes/db/jwt.sql (Apache-2.0).
\set jwt_exp `echo "$JWT_EXP"`

ALTER DATABASE postgres SET "app.settings.jwt_exp" TO :'jwt_exp';
