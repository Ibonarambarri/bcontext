-- 0073_waitlist_repeat_signups.sql
--
-- QUÉ
--   Dos columnas (`last_signup_at`, `signup_count`) y una función
--   `record_waitlist_signup(...)` que pasa a ser la única forma de escribir
--   un alta desde el landing.
--
-- POR QUÉ
--   El alta era un upsert `on conflict (email)` que ESCRIBÍA ENCIMA de la
--   fila anterior con lo que traía la petición de hoy. Dos consecuencias, las
--   dos vistas en producción el 2026-09-07:
--
--   1. La fila seguía diciendo `created_at` de la primera vez. Alguien que se
--      apunta hoy aparece en la cola como "hace 109 días", con el estado que
--      el operador le puso entonces. El alta de hoy es invisible: no hay
--      ninguna columna que la cuente, así que no hay nada que mirar.
--   2. `note`, `referer` y `user_agent` se sobreescribían con los valores
--      nuevos, que muchas veces son NULL — el landing postea por su proxy y
--      manda `user_agent: node` y sin referer. La frase que la persona
--      escribió al apuntarse (el único material con el que se prioriza la
--      cola) se perdía en el segundo alta y no había forma de recuperarla.
--
--   La función arregla las dos: cuenta el alta repetida y sólo pisa un campo
--   cuando la petición nueva trae algo que poner. Lo que NO toca a propósito
--   es `status`, `operator_note` y `organization_id`: el estado es lo que el
--   operador sabe de esa conversación, y volver a apuntarse no lo cambia
--   —quien dijo que no sigue habiendo dicho que no— aunque sí merece que se
--   vea que ha vuelto.
--
-- POR QUÉ UNA FUNCIÓN Y NO UN UPSERT MEJOR
--   `signup_count = signup_count + 1` es una expresión sobre la fila que ya
--   está, y eso PostgREST no lo sabe expresar: su upsert manda valores, no
--   expresiones. La cuenta tiene que vivir en la base de datos.

begin;

alter table public.waitlist
  add column if not exists last_signup_at timestamptz not null default now();

alter table public.waitlist
  add column if not exists signup_count integer not null default 1;

-- Lo que sabemos de las filas que ya están: se apuntaron cuando se creó la
-- fila. `updated_at` no vale de backfill — puede ser una edición del operador.
update public.waitlist
   set last_signup_at = created_at
 where last_signup_at > created_at;

comment on column public.waitlist.last_signup_at is
  'La última vez que esta persona mandó el formulario. Distinta de created_at en cuanto se apunta dos veces.';

comment on column public.waitlist.signup_count is
  'Cuántas veces se ha apuntado. > 1 es señal: ha vuelto.';

create or replace function public.record_waitlist_signup(
  p_email      text,
  p_note       text default null,
  p_referer    text default null,
  p_user_agent text default null,
  p_source     text default 'landing'
) returns void
language sql
as $$
  insert into public.waitlist (email, note, referer, user_agent, source, last_signup_at, signup_count)
  values (
    lower(trim(p_email)),
    nullif(trim(coalesce(p_note, '')), ''),
    p_referer,
    p_user_agent,
    p_source,
    now(),
    1
  )
  on conflict (email) do update set
    -- coalesce y no excluded a secas: un alta que no trae nota no borra la
    -- que había.
    note        = coalesce(excluded.note, public.waitlist.note),
    referer     = coalesce(excluded.referer, public.waitlist.referer),
    user_agent  = coalesce(excluded.user_agent, public.waitlist.user_agent),
    source      = coalesce(excluded.source, public.waitlist.source),
    last_signup_at = now(),
    signup_count   = public.waitlist.signup_count + 1,
    updated_at     = now();
$$;

comment on function public.record_waitlist_signup(text, text, text, text, text) is
  'Alta del landing: inserta o cuenta la repetición. No toca status, operator_note ni organization_id.';

-- La cola es privada: la escribe el service role desde /api/waitlist y nadie
-- más. `anon` llega por HTTP a la ruta, no a la función.
revoke all on function public.record_waitlist_signup(text, text, text, text, text) from public;
grant execute on function public.record_waitlist_signup(text, text, text, text, text) to service_role;

commit;
