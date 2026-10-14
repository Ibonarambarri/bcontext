# Credentials

A `credential` node is the workspace's vault entry. This document is the whole
contract: what one node is allowed to hold, who can read a value, and how an
agent uses a secret it is never shown.

## One node is one credential

Not one node per service. Not one "keys" node per project. **One node, one
credential.**

- Two platforms → two nodes.
- The same platform in dev and in prod → two nodes, told apart by
  `environment`.
- Two keys for the same platform and environment (a read-only one and a
  write one) → two nodes, told apart by their title.

The rule is not tidiness. A credential is the unit that gets rotated, revoked
and blamed. A node holding six platforms' secrets cannot be shared with one
teammate, cannot say when it was last rotated, and turns "we leaked the Stripe
key" into "we leaked everything". It also cannot be referenced: every
mechanism below addresses a credential by node id.

Classification is the tag taxonomy, like everything else in the graph —
`#billing`, `#infra`, `#nango`. Tags say what a credential is about;
`environment` says where it is valid; the title says which one it is.

## Shape

```jsonc
// node.data
{
  "credential": {
    "schema_version": 1,
    "type": "api_key_pair",          // see the catalogue below
    "environment": "prod",           // local | dev | staging | prod | null
    "service": "Stripe",
    "rotated_at": null,
    "expires_at": null
  },
  "fields": [
    { "key": "public_key", "name": "Public / publishable key", "value": "pk_live_…", "secret": false },
    { "key": "secret_key", "name": "Secret key",               "value": "sk_live_…", "secret": true  }
  ]
}
```

`fields` is the ONLY sanctioned home for credential material. Never
`content_md`, never the title, never another key in `data` — the redaction
drops everything else in `data` precisely because an unstructured key might be
holding a secret nobody classified.

Types (`packages/contract/src/credentials.ts` is the source of truth):
`api_key`, `api_key_pair`, `basic_auth`, `bearer_token`, `oauth2_client`,
`cloud_keys`, `database`, `ssh_key`, `service_account`, `webhook`, `custom`.

Each type is a template of slots, not a straitjacket: a typed credential may
carry extra fields, and a node written before this schema reads as `custom`
with its fields intact. `custom` is the edge case — reach for it when nothing
else fits, not as the default.

## Who can read a value

| Principal | Sees values |
|---|---|
| A person, via the session cookie (the web UI) | yes |
| A bearer token with `credentials:use` | yes, through `/api/credentials/…/materialize` only |
| Any other bearer token — including `admin:*` | **no** |

`admin:*` deliberately does not grant `credentials:use`
(`packages/contract/src/auth/scopes.ts`). A wildcard is a statement about
breadth of authority; handing a machine the plaintext of a secret is a
different decision and should be visible in the token's own scope list.

The masking happens at the door — `scopedStorage({ maskCredentials })`, wired
from `openWorkspace` — not in the routes. Eleven routes serialize a node
today; a redaction each of them has to remember is a redaction the twelfth
will not. A masked node keeps its whole shape (type, environment, service,
field names, `secret` flags, `bx://` refs) and loses every value.

Writing a masked copy back is refused (`redacted_credential_write`), so a
caller cannot destroy a secret it was never shown.

Credentials are also excluded from embeddings (`lib/rag/embed.ts`), from
retrieval (`lib/rag.ts`), from `nodes(op=search)`, and from the changes feed's
persisted snapshots (`contract/changes.ts`).

## How an agent uses one

An agent is never shown a value — not because it cannot be trusted with it,
but because **everything an agent reads is written down**. An MCP tool result
lands verbatim in the client's transcript on disk, is replayed to the model
provider on every following turn, and is often summarised into a session log.
A secret an agent reads is a secret copied to three places nobody rotates.

So it reads the shape and materialises the value into the process that needs
it, in one command whose output it never prints:

```bash
# one field, into the environment of exactly one command
STRIPE_SECRET_KEY=$(curl -sS -H "Authorization: Bearer $BCONTEXT_MCP_TOKEN" \
  "$BCONTEXT_API/api/credentials/<node-id>/materialize?workspace=<ws>&field=secret_key") \
  node scripts/charge.js

# the whole credential, as dotenv, into a gitignored file
curl -sS -H "Authorization: Bearer $BCONTEXT_MCP_TOKEN" \
  "$BCONTEXT_API/api/credentials/<node-id>/materialize?workspace=<ws>&format=env" > .env.local
```

The command line is logged; the substitution's output is not. This is the
`op run` / `doppler run` pattern, and `nodes(op=get)` hands the agent the
exact line to run in `credential_use.shell`.

Rules for whoever runs it:

- Never `echo`, `cat`, `print` or paste a materialised value.
- Never copy one into a node, a commit, a PR, an issue or a message.
- Delete the env file when done; it is gitignored, not gone.

Every materialisation is audited (`credential.materialize`, by node id and
field key). The audit row records **that** a secret was used, never which
bytes — the value is not in the URL, the audit input, the logs or the error
reporter.

## What is still open

Server-side injection — `{{credential:<id>#<field>}}` resolved by the
capability gateway at invocation time, so the value never reaches even the
agent's shell — is the next step, not this one. Today the shell recipe is the
boundary.
