-- 0087_organization_requests.sql
--
-- QUÉ
--   `organization_requests`: la puerta de entrada al producto. Una fila por
--   persona que pide una organización desde `/start` — quién es, qué empresa,
--   cuánta gente — y en qué punto está esa petición.
--
-- POR QUÉ UNA TABLA NUEVA Y NO MÁS COLUMNAS EN `waitlist`
--   Son dos cosas distintas con el mismo aspecto. Una fila de `waitlist` es
--   un interesado: un email y un párrafo, sin cuenta, sin nada que crear. Una
--   fila de aquí ya tiene cuenta en `auth.users`, tiene el nombre de la
--   empresa que hay que montar y el tamaño del equipo, y aceptarla es un solo
--   acto —la organización se construye con lo que ya está en la fila— en vez
--   de una llamada seguida de un formulario que alguien rellena a mano.
--   Mezclarlas obligaría a que la mitad de las columnas fueran nulas según de
--   qué tipo de fila se trate, y a que cada lectura preguntara cuál es.
--
--   `waitlist` se queda como está, de solo lectura: la landing ya no la
--   alimenta, pero las filas que hay son la historia de la beta privada.
--
-- POR QUÉ EXISTE EL ESTADO `draft`
--   El formulario tiene dos pasos y la cuenta se crea en el primero. Si la
--   persona cierra la pestaña en el segundo, lo que queda es una dirección
--   real a medio camino: eso es precisamente lo que la cola quiere saber.
--   Sin `draft` habría que elegir entre no escribir nada hasta el final
--   (y perder a quien abandona) o mandar el correo de confirmación al final
--   (y que el primer paso no haga nada). El panel filtra los borradores
--   fuera de la cola por defecto.
--
-- POR QUÉ HAY UN TOKEN
--   Entre el paso uno y el paso dos no hay sesión: la cuenta existe pero su
--   dirección aún no está confirmada, así que no puede iniciar sesión. El
--   token —aleatorio, guardado en hash, de vida corta— es lo que prueba que
--   el segundo POST viene del mismo navegador que hizo el primero. Se borra
--   al completar el formulario; no sirve para nada más.
--
-- POR QUÉ `user_id` ES `on delete set null` Y NO `cascade`
--   Borrar una cuenta no borra la petición que hizo esa persona: la fila
--   cuenta de dónde salió una organización y sigue siendo cierta después.
--   `email` está desnormalizado por lo mismo — es la única forma de saber
--   quién pidió qué cuando la cuenta ya no está.

begin;

create table if not exists public.organization_requests (
  id uuid primary key default uuid_generate_v4(),

  -- Quién pide.
  user_id uuid references auth.users(id) on delete set null,
  email text not null,
  contact_name text,
  contact_role text,

  -- Qué pide. Nulo mientras la fila es un borrador: son los campos del
  -- segundo paso, y una fila abandonada no los tiene por definición.
  organization_name text,
  organization_website text,
  organization_info text,
  team_size text check (
    team_size is null
    or team_size in ('1', '2-5', '6-20', '21-50', '51-200', '200+')
  ),
  expected_seats integer check (
    expected_seats is null or (expected_seats > 0 and expected_seats <= 5000)
  ),

  status text not null default 'draft' check (
    status in ('draft', 'pending', 'approved', 'declined')
  ),

  -- El ticket del segundo paso. Se guarda en hash por lo mismo que una
  -- contraseña: quien lea la tabla no debe poder completar peticiones ajenas.
  token_hash text,
  token_expires_at timestamptz,

  -- De dónde vino.
  source text,
  referer text,
  user_agent text,
  utm jsonb,

  -- Cómo acabó.
  organization_id uuid references public.organizations(id) on delete set null,
  decision_note text,
  decided_at timestamptz,
  decided_by uuid references auth.users(id) on delete set null,

  submitted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- La cola se lee siempre igual: lo que espera, lo más nuevo arriba.
create index if not exists organization_requests_status_idx
  on public.organization_requests (status, created_at desc);

create index if not exists organization_requests_user_idx
  on public.organization_requests (user_id)
  where user_id is not null;

create index if not exists organization_requests_organization_idx
  on public.organization_requests (organization_id)
  where organization_id is not null;

-- Una petición viva por dirección. Sin esto, recargar el primer paso deja
-- dos borradores de la misma persona y la cola cuenta dos veces a quien
-- dudó. Las peticiones ya resueltas no cuentan: alguien a quien se le dijo
-- que no puede volver a pedirlo más adelante.
create unique index if not exists organization_requests_open_email_idx
  on public.organization_requests (lower(email))
  where status in ('draft', 'pending');

-- El token no se busca nunca por sí solo: se comprueba contra la fila que ya
-- se ha localizado por id. El índice es para caducarlos en lote.
create index if not exists organization_requests_token_expiry_idx
  on public.organization_requests (token_expires_at)
  where token_hash is not null;

alter table public.organization_requests enable row level security;

-- Sin políticas, como `waitlist`: la única escritora es la service role
-- desde la API, que ya decide quién puede leer qué (el motor de permisos de
-- `src/lib/auth`, no RLS). Una política de lectura aquí sería una segunda
-- respuesta a la misma pregunta.
drop policy if exists organization_requests_no_public on public.organization_requests;
create policy organization_requests_no_public on public.organization_requests
  for select
  using (false);

comment on table public.organization_requests is
  'Peticiones de organización desde /start: quién es la persona, qué empresa quiere montar y en qué punto está la petición. Sustituye a waitlist como puerta de entrada.';

comment on column public.organization_requests.status is
  'draft (creó la cuenta y no terminó el formulario), pending (esperando decisión), approved (organización creada), declined (no siguió).';

comment on column public.organization_requests.token_hash is
  'Hash del ticket que autoriza el segundo paso del formulario. No hay sesión todavía: la cuenta existe pero su dirección no está confirmada. Se borra al completar.';

comment on column public.organization_requests.email is
  'Desnormalizado a propósito: sigue diciendo quién pidió esto cuando la cuenta ya no existe.';

comment on column public.organization_requests.organization_id is
  'La organización que salió de esta petición, una vez aceptada.';

-- ============================================================
-- Dos preguntas sobre `auth.users` que la API no puede hacer sola
-- ============================================================
--
-- PostgREST no expone el esquema `auth`, así que "¿ya hay cuenta con este
-- correo?" y "¿ha confirmado su dirección?" no se pueden responder con un
-- select desde la API. Se responden aquí, `security definer`, y sólo para
-- `service_role`: son las dos preguntas que deciden si alguien puede pedir
-- una organización y si esa petición se puede aceptar.
--
-- No devuelven nada más de la cuenta a propósito. Una función que devolviera
-- la fila entera de `auth.users` sería una puerta al hash de la contraseña
-- abierta para siempre por comodidad de hoy.

create or replace function public.account_state_for_email(p_email text)
returns table (user_id uuid, email_confirmed boolean, has_password boolean)
language sql
security definer
set search_path = public, auth
as $$
  select
    u.id,
    u.email_confirmed_at is not null,
    coalesce(u.encrypted_password, '') <> ''
  from auth.users u
  where lower(u.email) = lower(p_email)
  limit 1;
$$;

revoke all on function public.account_state_for_email(text) from public, anon, authenticated;
grant execute on function public.account_state_for_email(text) to service_role;

-- La misma pregunta para una página entera de la cola, en un viaje. Sin esto
-- el panel haría una llamada por fila para pintar "email sin confirmar", que
-- es la diferencia entre una consulta y cincuenta.
create or replace function public.organization_requests_account_state(p_ids uuid[])
returns table (id uuid, email_confirmed boolean, last_sign_in_at timestamptz)
language sql
security definer
set search_path = public, auth
as $$
  select r.id,
         u.email_confirmed_at is not null,
         u.last_sign_in_at
    from public.organization_requests r
    left join auth.users u on u.id = r.user_id
   where r.id = any(p_ids);
$$;

revoke all on function public.organization_requests_account_state(uuid[]) from public, anon, authenticated;
grant execute on function public.organization_requests_account_state(uuid[]) to service_role;

commit;
