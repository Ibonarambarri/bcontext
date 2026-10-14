-- 0096_nexos.sql
--
-- QUÉ
--   Nexo deja de ser un asistente único y pasa a ser un equipo: cada workspace
--   tiene un Nexo general (siempre presente, no se borra, recoge lo que nadie
--   más reclama) y cuantos Nexos especialistas quiera («Soporte»,
--   «Marketing»…). Cada uno tiene su prompt, sus herramientas, sus
--   integraciones (bindings), su latido (heartbeat), su bandeja y su historial
--   de chat.
--
-- IDENTIDAD — por qué cada Nexo es una fila de `agents`
--   Un Nexo actúa sobre el grafo y sobre capacidades externas. Respaldándolo con
--   una fila de `agents` (provider `nexo`) todo lo que ya existe funciona sin
--   tocarlo: su permiso es un `workspace_grants` (principal_kind `agent`) cuyos
--   verbos salen de `brain_tools`, las capacidades externas se le conceden a su
--   `capability_principals` (source_type `agent`), y auditoría y actividad lo
--   nombran por `agents.name`. No se crea `agent_workspace_access`: esa tabla
--   es la de las conexiones de agentes externos (Claude Code, Cursor…), y un
--   Nexo no debe aparecer en «agentes conectados» ni heredar su flujo de
--   tokens. Sin fila de acceso el fallback legacy de `resolveGrant` niega, así
--   que el grant es la única puerta y falla cerrada.
--
-- INTEGRACIONES — cómo se referencia una instalación
--   `nexo_bindings.install_id` apunta a `connector_installs(id)`. Esa tabla ya
--   cubre las dos familias: las nativas (slack, github, linear, notion; su
--   `connector_id`) y las de Nango (0076: `connector_id` = unique_key de la
--   integración, `config.provider = 'nango'`, `config.nango_connection_id`).
--   La FK compuesta (install_id, workspace_id) garantiza en la base que un
--   Nexo nunca escucha una instalación de otro tenant; `on delete cascade`
--   porque desinstalar borra la escucha, no la deja colgando. `connector_id`
--   se copia al binding para enrutar sin un join en la ruta caliente.
--   Un binding es UNA clave de alcance (`scope_key`: `*` = toda la instalación,
--   `channel:<id>` = un canal de Slack…). `unique (install_id, scope_key)` es
--   la regla «un dueño por canal»: dos Nexos no pueden escuchar el mismo canal.
--
-- VENTANAS — mensajes en bloque, no uno a uno
--   Los mensajes entrantes se acumulan en `nexo_windows` por hilo y se vacían
--   tras un rato de silencio o al llegar a un tope. Las dos RPC del final hacen
--   atómico lo que con PostgREST sería leer-modificar-escribir con carreras:
--   añadir un evento a la ventana abierta (o abrirla) y reclamar las vencidas
--   para un único worker.
--
-- RLS
--   Igual que las vecinas (skill_schedules, saved_views): los miembros leen,
--   la escritura va por service_role y la autorización real son los grants en
--   código. `organization_ai_keys` no tiene política alguna y se revoca a
--   anon/authenticated: ni siquiera su `secret_ref` sale al navegador.

begin;

-- ── agents.provider admite 'nexo' ──────────────────────────────────────────
alter table public.agents drop constraint if exists agents_provider_check;
alter table public.agents add constraint agents_provider_check
  check (provider in ('codex','claude_code','hermes','openclaw','other','nexo'));

-- Necesario para la FK compuesta de los bindings (ver cabecera).
alter table public.connector_installs
  drop constraint if exists connector_installs_id_workspace_key;
alter table public.connector_installs
  add constraint connector_installs_id_workspace_key unique (id, workspace_id);

-- ── nexos ──────────────────────────────────────────────────────────────────
create table if not exists public.nexos (
  id uuid primary key default uuid_generate_v4(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  -- Borrar al dueño de la fila de agents (su cuenta) arrastra el Nexo; el
  -- general se vuelve a crear solo en el siguiente listado.
  agent_id uuid not null unique references public.agents(id) on delete cascade,
  slug text not null check (slug ~ '^[a-z0-9][a-z0-9-]{0,47}$'),
  name text not null check (char_length(btrim(name)) between 1 and 80),
  description text not null default '' check (char_length(description) <= 500),
  is_general boolean not null default false,
  -- Clave del preset (`support`, `marketing`…), `general` o `custom`.
  template text not null default 'custom' check (template ~ '^[a-z][a-z0-9_-]{0,31}$'),
  questionnaire jsonb not null default '{}'::jsonb,
  prompt_md text not null default '' check (char_length(prompt_md) <= 20000),
  -- null = el modelo de chat por defecto (`CHAT_MODEL`).
  model text check (model is null or char_length(model) between 1 and 120),
  autonomy text not null default 'draft' check (autonomy in ('observe','draft','act')),
  -- {"read":bool,"write":bool} → verbos del workspace_grants del agente.
  brain_tools jsonb not null default '{"read":true,"write":true}'::jsonb,
  -- {enabled, every_minutes, active_hours:{start,end,tz}, checklist_md}
  heartbeat jsonb not null default '{"enabled":false,"every_minutes":60,"active_hours":{"start":"09:00","end":"19:00","tz":"UTC"},"checklist_md":""}'::jsonb,
  -- {notify_user_ids:[], via:["inbox","email"]}
  escalation jsonb not null default '{"notify_user_ids":[],"via":["inbox"]}'::jsonb,
  monthly_budget_credits numeric check (monthly_budget_credits is null or monthly_budget_credits >= 0),
  status text not null default 'active' check (status in ('active','paused')),
  last_run_at timestamptz,
  next_heartbeat_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, slug),
  unique (id, workspace_id),
  constraint nexos_questionnaire_object check (jsonb_typeof(questionnaire) = 'object'),
  constraint nexos_brain_tools_object check (jsonb_typeof(brain_tools) = 'object'),
  constraint nexos_heartbeat_object check (jsonb_typeof(heartbeat) = 'object'),
  constraint nexos_escalation_object check (jsonb_typeof(escalation) = 'object')
);

-- Un único general por workspace. `ensureGeneralNexo` crea perezosamente y se
-- apoya en este índice para que dos listados simultáneos no creen dos.
create unique index if not exists nexos_one_general
  on public.nexos(workspace_id) where is_general;
create index if not exists nexos_due_heartbeat
  on public.nexos(next_heartbeat_at)
  where status = 'active' and next_heartbeat_at is not null;

drop trigger if exists nexos_updated on public.nexos;
create trigger nexos_updated before update on public.nexos
  for each row execute function public.set_updated_at();

comment on table public.nexos is
  'Asistentes del workspace. Cada uno respaldado por una fila de agents (provider nexo) + workspace_grants + capability_principals. Uno is_general por workspace.';

-- ── nexo_bindings ──────────────────────────────────────────────────────────
create table if not exists public.nexo_bindings (
  id uuid primary key default uuid_generate_v4(),
  nexo_id uuid not null,
  workspace_id uuid not null,
  install_id uuid not null,
  connector_id text not null check (connector_id ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  scope_key text not null default '*' check (char_length(scope_key) between 1 and 200),
  scope jsonb not null default '{}'::jsonb check (jsonb_typeof(scope) = 'object'),
  mode text not null default 'listen' check (mode in ('listen','listen_reply')),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  foreign key (nexo_id, workspace_id)
    references public.nexos(id, workspace_id) on delete cascade,
  foreign key (install_id, workspace_id)
    references public.connector_installs(id, workspace_id) on delete cascade,
  -- Un dueño por (instalación, canal): ver cabecera.
  unique (install_id, scope_key)
);
create index if not exists nexo_bindings_nexo_idx on public.nexo_bindings(nexo_id);
create index if not exists nexo_bindings_workspace_idx on public.nexo_bindings(workspace_id);

-- ── nexo_runs ──────────────────────────────────────────────────────────────
create table if not exists public.nexo_runs (
  id uuid primary key default uuid_generate_v4(),
  nexo_id uuid not null,
  workspace_id uuid not null,
  trigger text not null check (trigger in ('chat','heartbeat','event','batch','manual')),
  status text not null default 'running'
    check (status in ('running','succeeded','failed','skipped')),
  input jsonb not null default '{}'::jsonb,
  output_md text,
  -- Resumen de llamadas a herramientas: [{tool, ok, note?}]. Nunca contenido completo.
  steps jsonb not null default '[]'::jsonb check (jsonb_typeof(steps) = 'array'),
  usage jsonb not null default '{}'::jsonb,
  error text,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  unique (id, workspace_id),
  foreign key (nexo_id, workspace_id)
    references public.nexos(id, workspace_id) on delete cascade
);
create index if not exists nexo_runs_nexo_idx on public.nexo_runs(nexo_id, started_at desc);
create index if not exists nexo_runs_workspace_idx on public.nexo_runs(workspace_id, started_at desc);

-- ── nexo_inbox ─────────────────────────────────────────────────────────────
create table if not exists public.nexo_inbox (
  id uuid primary key default uuid_generate_v4(),
  workspace_id uuid not null,
  nexo_id uuid not null,
  run_id uuid references public.nexo_runs(id) on delete set null,
  kind text not null check (kind in ('escalation','draft_reply','approval')),
  title text not null check (char_length(btrim(title)) between 1 and 200),
  body_md text not null default '' check (char_length(body_md) <= 20000),
  -- p. ej. slack {install_id, channel, thread_ts, draft_text}
  payload jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object'),
  status text not null default 'open'
    check (status in ('open','approved','edited','rejected','done')),
  resolved_by uuid references auth.users(id) on delete set null,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (nexo_id, workspace_id)
    references public.nexos(id, workspace_id) on delete cascade
);
create index if not exists nexo_inbox_workspace_idx
  on public.nexo_inbox(workspace_id, status, created_at desc);
create index if not exists nexo_inbox_nexo_idx
  on public.nexo_inbox(nexo_id, status, created_at desc);

drop trigger if exists nexo_inbox_updated on public.nexo_inbox;
create trigger nexo_inbox_updated before update on public.nexo_inbox
  for each row execute function public.set_updated_at();

-- ── nexo_windows ───────────────────────────────────────────────────────────
create table if not exists public.nexo_windows (
  id uuid primary key default uuid_generate_v4(),
  workspace_id uuid not null,
  nexo_id uuid not null,
  binding_id uuid references public.nexo_bindings(id) on delete set null,
  -- p. ej. slack:<team>:<channel>:<thread_ts>
  source_key text not null check (char_length(source_key) between 1 and 300),
  -- [{ts, author, text}] compactos
  events jsonb not null default '[]'::jsonb check (jsonb_typeof(events) = 'array'),
  message_count integer not null default 0 check (message_count >= 0),
  first_at timestamptz not null default now(),
  last_at timestamptz not null default now(),
  flush_after timestamptz not null,
  state text not null default 'collecting' check (state in ('collecting','flushing','flushed')),
  -- Cuándo la reclamó un worker: una ventana en `flushing` demasiado tiempo
  -- es un worker que murió, y `claim_due_nexo_windows` la vuelve a dar.
  claimed_at timestamptz,
  flushed_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (nexo_id, workspace_id)
    references public.nexos(id, workspace_id) on delete cascade
);
-- Una sola ventana abierta por (Nexo, hilo); la RPC de append la usa como
-- objetivo del `on conflict`.
create unique index if not exists nexo_windows_one_collecting
  on public.nexo_windows(nexo_id, source_key) where state = 'collecting';
create index if not exists nexo_windows_due_idx
  on public.nexo_windows(flush_after) where state = 'collecting';
create index if not exists nexo_windows_flushing_idx
  on public.nexo_windows(claimed_at) where state = 'flushing';

-- ── chat_sessions.nexo_id ──────────────────────────────────────────────────
-- null = el Nexo general, así el historial existente sigue siendo suyo.
-- `cascade`: borrar un especialista borra sus conversaciones; con `set null`
-- acabarían colándose en el historial del general.
alter table public.chat_sessions
  add column if not exists nexo_id uuid references public.nexos(id) on delete cascade;
create index if not exists chat_sessions_nexo_idx
  on public.chat_sessions(workspace_id, nexo_id, updated_at desc)
  where nexo_id is not null;

-- ── organization_ai_keys (BYOK) ────────────────────────────────────────────
create table if not exists public.organization_ai_keys (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  provider text not null check (provider in ('anthropic','openai','gateway')),
  -- Solo la referencia a Vault, nunca el texto plano (mismo formato que 0091).
  secret_ref text not null check (
    secret_ref ~ '^vault:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ),
  last4 text not null check (char_length(last4) between 1 and 4),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, provider)
);

drop trigger if exists organization_ai_keys_updated on public.organization_ai_keys;
create trigger organization_ai_keys_updated before update on public.organization_ai_keys
  for each row execute function public.set_updated_at();

-- La entrada de Vault vive lo que vive su referencia: cada escritura guarda
-- una nueva, así que al reemplazar o borrar la fila se va la anterior, en la
-- misma transacción (la función es la de 0034, mira solo old.secret_ref).
drop trigger if exists organization_ai_keys_delete_secret on public.organization_ai_keys;
create trigger organization_ai_keys_delete_secret
  after delete on public.organization_ai_keys
  for each row execute function public.delete_oauth_vault_secret_on_row_delete();
drop trigger if exists organization_ai_keys_replace_secret on public.organization_ai_keys;
create trigger organization_ai_keys_replace_secret
  after update of secret_ref on public.organization_ai_keys
  for each row
  when (old.secret_ref is distinct from new.secret_ref)
  execute function public.delete_oauth_vault_secret_on_row_delete();

-- ── Presupuesto por Nexo ───────────────────────────────────────────────────
-- Las llamadas de un Nexo se apuntan en el ledger con surface `nexo` y
-- `metadata.nexo_id`; sumar el mes de un Nexo no debe recorrer el workspace.
create index if not exists ai_usage_events_nexo_idx
  on public.ai_usage_events((metadata->>'nexo_id'), created_at desc)
  where metadata ? 'nexo_id';

-- ── RLS ────────────────────────────────────────────────────────────────────
alter table public.nexos enable row level security;
alter table public.nexo_bindings enable row level security;
alter table public.nexo_runs enable row level security;
alter table public.nexo_inbox enable row level security;
alter table public.nexo_windows enable row level security;
alter table public.organization_ai_keys enable row level security;

drop policy if exists nexos_member_read on public.nexos;
create policy nexos_member_read on public.nexos
  for select using (public.is_workspace_member(workspace_id));
drop policy if exists nexo_bindings_member_read on public.nexo_bindings;
create policy nexo_bindings_member_read on public.nexo_bindings
  for select using (public.is_workspace_member(workspace_id));
drop policy if exists nexo_runs_member_read on public.nexo_runs;
create policy nexo_runs_member_read on public.nexo_runs
  for select using (public.is_workspace_member(workspace_id));
drop policy if exists nexo_inbox_member_read on public.nexo_inbox;
create policy nexo_inbox_member_read on public.nexo_inbox
  for select using (public.is_workspace_member(workspace_id));
-- nexo_windows: contenido de mensajes en crudo; sin política de lectura.

revoke all on table public.organization_ai_keys from public, anon, authenticated;
grant select, insert, update, delete on table public.organization_ai_keys to service_role;

-- ── RPC: añadir un evento a la ventana abierta ─────────────────────────────
-- Abre la ventana si no hay una `collecting` para (nexo, source_key) o añade
-- el evento a la existente, y recalcula `flush_after`:
--   silencio: last_at + p_quiet_seconds
--   tope:     message_count >= p_max_messages o last_at - first_at >= p_max_span_seconds
--             → flush_after = now (se vacía en el siguiente barrido)
-- Devuelve la fila resultante.
create or replace function public.append_nexo_window_event(
  p_workspace_id uuid,
  p_nexo_id uuid,
  p_binding_id uuid,
  p_source_key text,
  p_event jsonb,
  p_quiet_seconds integer default 600,
  p_max_messages integer default 40,
  p_max_span_seconds integer default 21600
)
returns setof public.nexo_windows
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := pg_catalog.now();
  v_quiet interval := pg_catalog.make_interval(secs => greatest(coalesce(p_quiet_seconds, 600), 1));
  v_span interval := pg_catalog.make_interval(secs => greatest(coalesce(p_max_span_seconds, 21600), 1));
  v_max integer := greatest(coalesce(p_max_messages, 40), 1);
  -- Hard ceiling on stored events. Reaching v_max only makes the window due;
  -- it keeps collecting until the next flush claims it (up to a minute), and a
  -- flooded channel must not grow one row without bound in the meantime.
  -- Past the ceiling the message is counted but its text is dropped.
  v_keep integer := greatest(v_max, 200);
begin
  if p_event is null or pg_catalog.jsonb_typeof(p_event) <> 'object' then
    raise exception using errcode = '22023', message = 'event must be an object';
  end if;

  return query
  insert into public.nexo_windows as w (
    workspace_id, nexo_id, binding_id, source_key, events, message_count,
    first_at, last_at, flush_after, state
  )
  values (
    p_workspace_id, p_nexo_id, p_binding_id, p_source_key,
    pg_catalog.jsonb_build_array(p_event), 1, v_now, v_now,
    case when v_max <= 1 then v_now else v_now + v_quiet end,
    'collecting'
  )
  on conflict (nexo_id, source_key) where state = 'collecting'
  do update set
    events = case
      when pg_catalog.jsonb_array_length(w.events) >= v_keep then w.events
      else w.events || pg_catalog.jsonb_build_array(p_event)
    end,
    message_count = w.message_count + 1,
    last_at = v_now,
    binding_id = coalesce(excluded.binding_id, w.binding_id),
    flush_after = case
      when w.message_count + 1 >= v_max or v_now - w.first_at >= v_span then v_now
      else v_now + v_quiet
    end
  returning w.*;
end;
$$;

-- ── RPC: reclamar ventanas vencidas ────────────────────────────────────────
-- Pasa a `flushing` las ventanas `collecting` con flush_after <= p_now y las
-- `flushing` abandonadas (claimed_at más viejo que p_stale_seconds), con
-- `skip locked` para que dos workers nunca reclamen la misma.
create or replace function public.claim_due_nexo_windows(
  p_now timestamptz default null,
  p_limit integer default 50,
  p_stale_seconds integer default 900
)
returns setof public.nexo_windows
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := coalesce(p_now, pg_catalog.now());
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 500);
  v_stale interval := pg_catalog.make_interval(secs => greatest(coalesce(p_stale_seconds, 900), 60));
begin
  return query
  update public.nexo_windows as w
  set state = 'flushing', claimed_at = v_now
  where w.id in (
    select c.id from public.nexo_windows c
    where (c.state = 'collecting' and c.flush_after <= v_now)
       or (c.state = 'flushing' and c.claimed_at < v_now - v_stale)
    order by c.flush_after
    limit v_limit
    for update skip locked
  )
  returning w.*;
end;
$$;

revoke all on function public.append_nexo_window_event(uuid, uuid, uuid, text, jsonb, integer, integer, integer)
  from public, anon, authenticated;
revoke all on function public.claim_due_nexo_windows(timestamptz, integer, integer)
  from public, anon, authenticated;
grant execute on function public.append_nexo_window_event(uuid, uuid, uuid, text, jsonb, integer, integer, integer)
  to service_role;
grant execute on function public.claim_due_nexo_windows(timestamptz, integer, integer)
  to service_role;

commit;
