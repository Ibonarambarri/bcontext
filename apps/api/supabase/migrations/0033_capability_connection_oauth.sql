-- MCP providers may use an OAuth access token stored as a server-side secret
-- reference. At runtime OAuth access tokens are sent using Bearer auth; the
-- distinct type keeps the control plane honest about how the credential was
-- issued and lets the UI explain rotation separately from static API tokens.

alter table capability_connections
  drop constraint if exists capability_connections_auth_type_check;

-- 0031 created this unnamed auth-field consistency check. PostgreSQL named
-- it capability_connections_check; replace it as well or OAuth rows would
-- still be rejected even after widening the auth_type enum-like check.
alter table capability_connections
  drop constraint if exists capability_connections_check;
alter table capability_connections
  drop constraint if exists capability_connections_auth_fields_check;

alter table capability_connections
  add constraint capability_connections_auth_type_check
  check (auth_type in ('none', 'oauth', 'bearer', 'header'));

alter table capability_connections
  add constraint capability_connections_check
  check (
    (auth_type = 'none' and secret_ref is null and auth_header_name is null)
    or (auth_type in ('oauth', 'bearer') and secret_ref is not null and auth_header_name is null)
    or (auth_type = 'header' and secret_ref is not null and auth_header_name is not null)
  );
