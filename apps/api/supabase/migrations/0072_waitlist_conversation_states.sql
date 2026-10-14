-- 0072_waitlist_conversation_states.sql
--
-- QUÉ
--   El vocabulario de `waitlist.status` pasa a
--   `new | talking | onboarding | active | declined`. Las filas que ya
--   existen se reescriben una a una antes de tocar el CHECK:
--
--     reviewing  -> talking      (alguien está hablando con esa persona)
--     invited    -> onboarding   (su organización está montándose)
--     accepted   -> active       (está dentro y usando el producto)
--     rejected   -> declined     (la conversación no siguió)
--     new        -> new          (nadie la ha tocado todavía)
--
--   El orden importa: el CHECK viejo sigue vigente mientras corre el UPDATE,
--   así que reescribir los datos primero es la única forma de que el UPDATE
--   pase. Si se cambiara la restricción antes, ninguna fila cabría en ella.
--
-- POR QUÉ
--   Los nombres viejos contaban lo que el sistema había hecho —revisada,
--   invitada, aceptada— porque la cola misma emitía la invitación. Ya no la
--   emite: la invitación nace cuando se crea la organización para esa
--   persona, y ese acto ya entrega el enlace. Lo único que la cola tiene que
--   recordar es quién está interesado y por dónde va la conversación, así que
--   los estados nombran lo que sabe el operador y no lo que hizo la máquina.
--
-- POR QUÉ SE LIMPIA `utm`
--   Las claves `invite_*` las escribía el camino de invitación de la cola.
--   Nadie las escribe ni las lee, y dejarlas dentro de la columna de
--   atribución de la landing es dejar el estado de una máquina que ya no
--   existe donde se busca de dónde vino la persona. La atribución en sí
--   —campaña, referer— se conserva intacta.

begin;

-- La restricción sale primero. Reescribir las filas con ella puesta es
-- imposible: la vieja no conoce ninguno de los nombres nuevos, así que el
-- primer `update` viola el check y se lleva la migración entera por delante.
alter table public.waitlist
  drop constraint if exists waitlist_status_check;

update public.waitlist
   set status = case status
                  when 'reviewing' then 'talking'
                  when 'invited'   then 'onboarding'
                  when 'accepted'  then 'active'
                  when 'rejected'  then 'declined'
                  else status
                end
 where status in ('reviewing', 'invited', 'accepted', 'rejected');

alter table public.waitlist
  add constraint waitlist_status_check
  check (status in ('new', 'talking', 'onboarding', 'active', 'declined'));

update public.waitlist
   set utm = utm
             - 'invite_email_status'
             - 'invite_email_error'
             - 'invite_sent_at'
             - 'invite_expires_at'
             - 'invite_ttl_hours'
 where utm ? 'invite_sent_at'
    or utm ? 'invite_email_status';

comment on column public.waitlist.status is
  'Por dónde va la conversación: new (nadie la ha tocado), talking (se está hablando), onboarding (su organización está montándose), active (dentro y usando el producto), declined (no siguió).';

comment on column public.waitlist.utm is
  'Atribución de la landing: campaña, referer, de dónde salió esta persona.';

commit;
