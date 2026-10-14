-- OAuth-issued user-scoped access tokens remember the client they were issued
-- to, so RFC 7009 revocation can find them.
--
-- Found by the OAuth end-to-end check on the local stack: the consent flow
-- writes user-scoped access tokens into user_api_tokens, revokeToken() looked
-- only in oauth_access_tokens, and — because §2.2 requires 200 for an unknown
-- token — a revocation that did nothing was indistinguishable from one that
-- worked. The token kept answering /mcp after "revoke" returned 200.
--
-- Nullable: tokens a person creates from Settings have no client. The column
-- is text, like oauth_clients.client_id (the public identifier), not the row
-- uuid, because that is what the revoking client authenticates as.
begin;

alter table public.user_api_tokens
  add column if not exists client_id text
  references public.oauth_clients(client_id) on delete set null;

create index if not exists user_api_tokens_client_id_idx
  on public.user_api_tokens (client_id)
  where client_id is not null;

comment on column public.user_api_tokens.client_id is
  'OAuth client this token was issued to; null for tokens created by the person in Settings. Lets RFC 7009 revocation find user-scoped tokens.';

commit;
