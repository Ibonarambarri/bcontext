#!/usr/bin/env bash
# Prepares .env for `docker compose up -d`: fresh secrets, the domain and the
# first admin. Safe to run again: secrets already in .env are kept, only
# empty ones are generated, and the domain/admin/email you pass are updated.
#
#   ./setup.sh                                   # asks for domain and admin email
#   ./setup.sh --domain ctx.example.com --admin-email you@example.com -y
#   ./setup.sh --domain localhost --admin-email you@example.com -y
#
# Options:
#   --domain <host>          public hostname (`localhost` for a local try-out)
#   --admin-email <email>    ADMIN_EMAILS (may open /admin)
#   --http-port <port>       Caddy's HTTP port (default 80; only for localhost)
#   --https-port <port>      Caddy's HTTPS port (default 443; a public domain needs 443)
#   --resend-key <key>       Resend API key: turns on email (needs --email-from)
#   --email-from <from>      sender, e.g. "Bcontext <no-reply@example.com>"
#   --org-creation open|admin
#   --rotate                 regenerate every secret except POSTGRES_PASSWORD (signs everyone out)
#   -y, --yes                never prompt; use flags and defaults
#
# Needs: bash, openssl, awk. Nothing else.
set -euo pipefail
cd "$(dirname "$0")"

ENV_FILE=.env
DOMAIN="" ADMIN="" HTTP_PORT_ARG="" HTTPS_PORT_ARG="" RESEND="" FROM="" ORG="" ROTATE=0 YES=0

while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN=$2; shift 2 ;;
    --admin-email) ADMIN=$2; shift 2 ;;
    --http-port) HTTP_PORT_ARG=$2; shift 2 ;;
    --https-port) HTTPS_PORT_ARG=$2; shift 2 ;;
    --resend-key) RESEND=$2; shift 2 ;;
    --email-from) FROM=$2; shift 2 ;;
    --org-creation) ORG=$2; shift 2 ;;
    --rotate) ROTATE=1; shift ;;
    -y|--yes) YES=1; shift ;;
    -h|--help) awk 'NR > 1 && !/^#/ { exit } NR > 1 { sub(/^# ?/, ""); print }' "$0"; exit 0 ;;
    *) echo "unknown option: $1 (see --help)" >&2; exit 1 ;;
  esac
done

command -v openssl >/dev/null || { echo "setup.sh needs openssl" >&2; exit 1; }

say() { printf '%s\n' "$*"; }
bold() { printf '\033[1m%s\033[0m\n' "$*"; }

# --- .env helpers: KEY=value lines; a commented `# KEY=` line is replaced in place.
get() {
  awk -v k="$1" 'index($0, k "=") == 1 { print substr($0, length(k) + 2); exit }' "$ENV_FILE"
}
set_var() {
  local key=$1 value=$2 tmp
  tmp=$(mktemp)
  KEY="$key" VALUE="$value" awk '
    BEGIN { k = ENVIRON["KEY"]; v = ENVIRON["VALUE"]; done = 0 }
    !done && (index($0, k "=") == 1 || index($0, "# " k "=") == 1) { print k "=" v; done = 1; next }
    { print }
    END { if (!done) print k "=" v }
  ' "$ENV_FILE" > "$tmp"
  cat "$tmp" > "$ENV_FILE"
  rm -f "$tmp"
}
ensure_secret() { # key, generator
  if [ "$ROTATE" = 1 ] || [ -z "$(get "$1")" ]; then
    set_var "$1" "$($2)"
    return 0
  fi
  return 1
}

hex32() { openssl rand -hex 32; }
hex24() { openssl rand -hex 24; }
b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }
jwt() { # role, secret
  local now exp header payload sig
  now=$(date +%s)
  exp=$((now + 10 * 365 * 24 * 3600))
  header=$(printf '{"alg":"HS256","typ":"JWT"}' | b64url)
  payload=$(printf '{"role":"%s","iss":"supabase","iat":%s,"exp":%s}' "$1" "$now" "$exp" | b64url)
  sig=$(printf '%s.%s' "$header" "$payload" | openssl dgst -sha256 -hmac "$2" -binary | b64url)
  printf '%s.%s.%s' "$header" "$payload" "$sig"
}

ask() { # var, prompt, default
  local answer
  if [ "$YES" = 1 ] || [ ! -t 0 ]; then printf -v "$1" '%s' "$3"; return; fi
  read -r -p "$2 [${3}]: " answer || true
  printf -v "$1" '%s' "${answer:-$3}"
}

# --- 1. .env from the template ------------------------------------------------
if [ ! -f "$ENV_FILE" ]; then
  cp .env.example "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  say "created $ENV_FILE from .env.example"
fi

# --- 2. Secrets -----------------------------------------------------------------
# Never rotated: the database roles take this password once, when the data
# volume is first initialised (deploy/supabase/db/roles.sql), so a new value
# would lock Auth, PostgREST and Storage out of an existing database.
[ -n "$(get POSTGRES_PASSWORD)" ] || set_var POSTGRES_PASSWORD "$(hex32)"
jwt_rotated=0
ensure_secret JWT_SECRET hex32 && jwt_rotated=1 || true
secret=$(get JWT_SECRET)
if [ "$jwt_rotated" = 1 ] || [ -z "$(get ANON_KEY)" ] || [ -z "$(get SERVICE_ROLE_KEY)" ]; then
  set_var ANON_KEY "$(jwt anon "$secret")"
  set_var SERVICE_ROLE_KEY "$(jwt service_role "$secret")"
fi
ensure_secret REALTIME_SECRET hex32 || true
ensure_secret ERRORS_INGEST_KEY hex32 || true
ensure_secret PG_META_CRYPTO_KEY hex24 || true

# --- 3. Domain -------------------------------------------------------------------
current_domain=$(get BCONTEXT_DOMAIN)
[ -n "$DOMAIN" ] || ask DOMAIN "Public domain (localhost for a local try-out)" "${current_domain:-localhost}"
DOMAIN=${DOMAIN#http://}; DOMAIN=${DOMAIN#https://}; DOMAIN=${DOMAIN%%/*}
set_var BCONTEXT_DOMAIN "$DOMAIN"
if [ "$DOMAIN" = "localhost" ] || [ "$DOMAIN" = "127.0.0.1" ]; then
  port=${HTTP_PORT_ARG:-$(get HTTP_PORT)}
  port=${port:-80}
  set_var BCONTEXT_SITE_ADDRESS "http://$DOMAIN"
  if [ "$port" = 80 ]; then hostport=$DOMAIN; else hostport="$DOMAIN:$port"; fi
  set_var PUBLIC_URL "http://$hostport"
  set_var REALTIME_PUBLIC_URL "ws://$hostport"
  [ "$port" = 80 ] || set_var HTTP_PORT "$port"
else
  # Automatic HTTPS: the DNS record must point here and ports 80/443 be open.
  set_var BCONTEXT_SITE_ADDRESS "$DOMAIN"
  set_var PUBLIC_URL "https://$DOMAIN"
  set_var REALTIME_PUBLIC_URL "wss://$DOMAIN"
fi

[ -z "$HTTPS_PORT_ARG" ] || set_var HTTPS_PORT "$HTTPS_PORT_ARG"

# --- 4. Admin and access -----------------------------------------------------------
current_admin=$(get ADMIN_EMAILS)
[ -n "$ADMIN" ] || ask ADMIN "Admin email (ADMIN_EMAILS)" "$current_admin"
[ -n "$ADMIN" ] && set_var ADMIN_EMAILS "$ADMIN"
if [ -n "$ORG" ]; then
  case "$ORG" in open|admin) set_var ORG_CREATION "$ORG" ;; *) echo "--org-creation must be open or admin" >&2; exit 1 ;; esac
fi

# --- 5. Email ------------------------------------------------------------------------
if [ -n "$RESEND" ]; then
  [ -n "$FROM" ] || { echo "--resend-key needs --email-from \"Name <address>\"" >&2; exit 1; }
  addr=$(printf '%s' "$FROM" | sed -n 's/.*<\(.*\)>.*/\1/p'); addr=${addr:-$FROM}
  set_var RESEND_API_KEY "$RESEND"
  set_var EMAIL_FROM "$FROM"
  set_var SMTP_HOST smtp.resend.com
  set_var SMTP_PORT 465
  set_var SMTP_USER resend
  set_var SMTP_PASS "$RESEND"
  set_var SMTP_ADMIN_EMAIL "$addr"
  set_var ENABLE_EMAIL_AUTOCONFIRM false
fi
if [ -n "$(get SMTP_HOST)" ] && [ -n "$(get SMTP_PASS)" ]; then
  set_var ENABLE_EMAIL_AUTOCONFIRM false
  email_on=1
else
  set_var ENABLE_EMAIL_AUTOCONFIRM true
  email_on=0
fi

# --- Summary -----------------------------------------------------------------------------
echo
bold "Bcontext is configured ($ENV_FILE)"
say "  URL            $(get PUBLIC_URL)"
say "  admin          $(get ADMIN_EMAILS)"
say "  org creation   $(get ORG_CREATION)"
if [ "$email_on" = 0 ]; then
  echo
  bold "No email configured"
  say "  New accounts are confirmed on creation (no confirmation email), invitations"
  say "  are links you copy and send yourself, and password reset emails are not sent."
  say "  To turn email on: ./setup.sh --resend-key re_... --email-from \"Bcontext <no-reply@your-domain>\""
  say "  (or set SMTP_* and RESEND_API_KEY/EMAIL_FROM in .env by hand)."
fi
if [ -z "$(get AI_GATEWAY_API_KEY)" ] && [ -z "$(get OPENAI_BASE_URL)" ]; then
  echo
  bold "No AI backend configured (optional)"
  say "  Without one, search is keyword-only and ask_nexo answers with retrieval alone."
  say "  In .env, set either AI_GATEWAY_API_KEY (Vercel AI Gateway) or OPENAI_BASE_URL"
  say "  (+ OPENAI_API_KEY) for an OpenAI-compatible server such as Ollama or LiteLLM,"
  say "  and CHAT_MODEL / EXTRACT_MODEL / EMBEDDING_MODEL in that backend's naming."
fi
echo
say "Next: docker compose up -d   then open $(get PUBLIC_URL)"
