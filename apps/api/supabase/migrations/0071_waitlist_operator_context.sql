-- 0071_waitlist_operator_context.sql
--
-- QUÉ
--   Dos columnas en `waitlist`: `operator_note` (lo que el operador aprendió
--   fuera de pantalla) y `organization_id` (la organización que acabó
--   creándose para esa persona, con `on delete set null`).
--
-- POR QUÉ operator_note Y NO ESCRIBIR EN note
--   `note` es lo que la persona escribió al apuntarse. Es suyo: es la única
--   frase en la que dice con sus palabras para qué quiere el producto, y es
--   el material con el que se prioriza la cola. Si el operador anota encima
--   —la llamada, el contexto, lo que pidió— esa frase se pierde y no hay
--   forma de recuperarla. Son dos textos con dos dueños distintos, así que
--   son dos columnas.
--
--   Y hace falta el segundo: hoy todo lo que ocurre lejos de la pantalla —la
--   llamada, el correo, lo que se prometió— vive en la cabeza de quien la
--   hizo. Una cola que olvida eso es una cola que hay que recordar.
--
-- POR QUÉ organization_id
--   Hoy nada une una fila de la cola con la organización que se creó para esa
--   persona: las dos pantallas comparten un email que alguien vuelve a
--   teclear. Con veinte clientes hechos a mano esa unión es la mitad del
--   trabajo — desde la cola se llega a la organización, y desde la
--   organización se sabe de qué conversación salió.
--
--   `on delete set null` y no `cascade`: borrar una organización es deshacer
--   un alta, no borrar a la persona que la pidió. La fila de la cola
--   sobrevive con su historia y vuelve a estar disponible.
--
-- La columna NO es única a propósito: una misma organización puede haber
-- salido de más de una persona de la cola (dos compañeros que se apuntan por
-- separado y acaban en la misma empresa).

begin;

alter table public.waitlist
  add column if not exists operator_note text;

alter table public.waitlist
  add column if not exists organization_id uuid
    references public.organizations(id) on delete set null;

-- Se lee en el otro sentido — "¿de qué fila salió esta organización?" — al
-- abrir una organización desde el panel.
create index if not exists waitlist_organization_idx
  on public.waitlist (organization_id)
  where organization_id is not null;

comment on column public.waitlist.note is
  'Lo que la persona escribió al apuntarse. Suyo: no se edita nunca desde el panel.';

comment on column public.waitlist.operator_note is
  'Lo que el operador aprendió fuera de pantalla (la llamada, el contexto, lo que pidió). Separado de `note` porque tienen dueños distintos.';

comment on column public.waitlist.organization_id is
  'La organización creada para esta persona, si ya existe. Une la cola con el alta, que hasta ahora sólo compartían un email tecleado dos veces.';

commit;
