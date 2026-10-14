#!/bin/sh
# Renders kong.yml with the instance's keys and starts Kong in DB-less mode.
# Adapted from supabase/supabase docker/volumes/api/kong-entrypoint.sh
# (Apache-2.0), legacy HS256 keys only: Bcontext signs its anon and
# service-role keys with JWT_SECRET (setup.sh) and needs no opaque keys.
#
# A user session's bearer wins; otherwise the apikey header is forwarded as
# the Authorization, which is what PostgREST and Storage expect.
export LUA_AUTH_EXPR="\$((headers.authorization ~= nil and headers.authorization) or headers.apikey)"

awk '{
  result = ""
  rest = $0
  while (match(rest, /\$[A-Za-z_][A-Za-z_0-9]*/)) {
    varname = substr(rest, RSTART + 1, RLENGTH - 1)
    if (varname in ENVIRON) {
      result = result substr(rest, 1, RSTART - 1) ENVIRON[varname]
    } else {
      result = result substr(rest, 1, RSTART + RLENGTH - 1)
    }
    rest = substr(rest, RSTART + RLENGTH)
  }
  print result rest
}' /home/kong/temp.yml > "$KONG_DECLARATIVE_CONFIG"

exec /docker-entrypoint.sh kong docker-start
