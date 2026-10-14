-- 0085_goal_nodes.sql
--
-- QUÉ
--   Un `NodeKind` nuevo, `goal`, y un nodo raíz por workspace — el **North
--   Star** — que guarda la misión de la compañía. Tres cosas: ensanchar el
--   CHECK de kinds, garantizar el singleton con un índice único parcial, e
--   impedir en la propia base de datos que ese nodo se borre. Más el backfill
--   de un North Star por workspace existente.
--
-- POR QUÉ EL SINGLETON VIVE EN UN ÍNDICE
--   "Como mucho un North Star por workspace" es una invariante, no una
--   preferencia. Si la comprueba la API con un select previo, dos escrituras
--   concurrentes la saltan las dos y el segundo North Star no da error: se
--   descubre semanas después mirando el grafo y preguntándose cuál de los dos
--   es el bueno. Un índice único parcial lo convierte en lo que tiene que ser,
--   un error de constraint en el momento exacto de la segunda escritura.
--
-- POR QUÉ EL GUARDIÁN DE BORRADO VIVE EN LA DB Y NO EN LA API
--   `nodes.parent_id` cascadea el delete a los descendientes, y el North Star
--   va a ser el padre de todos los goals de compañía: un solo `delete` sobre
--   él se lleva el árbol de objetivos entero, sin confirmación y sin vuelta
--   atrás. Poner el guardián en la capa REST protegería exactamente una ruta —
--   la que hoy existe. El MCP, un import, un script de mantenimiento o el
--   endpoint que se escriba el mes que viene entran por debajo. En la DB no
--   hay "por debajo": cubre cualquier ruta presente y futura, incluida la que
--   nadie recuerde que existe.
--
--   La única excepción es el borrado del workspace entero. `nodes` cascadea
--   desde `workspaces`, así que sin esa salida el guardián haría imposible
--   dar de baja un workspace. Se detecta comprobando que la fila del
--   workspace ya no está: cuando Postgres ejecuta la acción referencial, el
--   padre ya se borró en el mismo comando.
--
-- Idempotente: se puede aplicar varias veces.

begin;

-- 1) El kind `goal`. Lista completa heredada de 0056 + `goal` al final.
alter table public.nodes drop constraint if exists nodes_kind_check;
alter table public.nodes add constraint nodes_kind_check check (
  kind = any (array['doc','task','decision','meeting','bug','adr','entity','skill','data','credential','goal'])
);

-- 2) Singleton del North Star, garantizado en DB.
--    El predicado compara jsonb contra jsonb en vez de castear a boolean.
--    Un cast se evalúa en CADA escritura de CUALQUIER nodo, no solo de
--    goals: un `data.root` que no fuese un booleano válido — un objeto,
--    una cadena cualquiera — haría fallar ese insert con un error de
--    conversión que no menciona ni goals ni North Star, y que costaría
--    una tarde encontrar. La comparación jsonb no puede lanzar.
create unique index if not exists nodes_root_goal_uniq on public.nodes (workspace_id)
  where data->'root' = 'true'::jsonb;

comment on index public.nodes_root_goal_uniq is
  'Un North Star como mucho por workspace. La invariante se enforcea aquí y no en la API porque dos escrituras concurrentes se saltarían cualquier comprobación previa en el servidor.';

-- 3) El North Star no se borra.
create or replace function public.prevent_root_goal_delete()
returns trigger
language plpgsql
set search_path = public, pg_catalog
as $$
begin
  if old.data->'root' is distinct from 'true'::jsonb then
    return old;
  end if;

  -- Se está borrando el workspace entero: el cascade legítimo se deja pasar.
  if not exists (select 1 from public.workspaces w where w.id = old.workspace_id) then
    return old;
  end if;

  raise exception using
    errcode = '23514',
    message = 'root_goal_undeletable',
    detail  = 'El North Star es el padre de los goals de compañía; borrarlo cascadearía el árbol de objetivos entero.',
    hint    = 'Reescribe su contenido (misión, por qué existimos, cómo sabremos que vamos bien) o mueve los goals que cuelgan de él. Solo desaparece si se borra el workspace.';
end;
$$;

revoke all on function public.prevent_root_goal_delete() from public, anon, authenticated;

drop trigger if exists nodes_root_goal_delete_guard on public.nodes;
create trigger nodes_root_goal_delete_guard
before delete on public.nodes
for each row execute function public.prevent_root_goal_delete();

-- 4) Backfill: un North Star por workspace existente.
--
--    `title` = el nombre del workspace a propósito: el día 1 el grafo se ve
--    igual que antes, con un nodo más que ya se llama como lo que contiene, en
--    vez de un "North Star" genérico que nadie escribió. `status` y `due_date`
--    van a null porque la misión no caduca ni pasa por un tablero.
--
--    El cuerpo son tres H2 vacíos. En este producto un H2 es un bloque
--    direccionable (`/n/<id>#mision`), no decoración: dejarlos escritos aquí
--    significa que un agente puede rellenar la misión sin inventarse la
--    estructura, y que se puede enlazar a una sección que todavía está vacía.
insert into public.nodes (workspace_id, parent_id, kind, slug, title, content_md, data, status, due_date)
select
  w.id,
  null,
  'goal',
  'north-star',
  w.name,
  E'## Misión\n\n## Por qué existimos\n\n## Cómo sabremos que vamos bien\n',
  '{"root": true, "scope": "company"}'::jsonb,
  null,
  null
from public.workspaces w
where not exists (
  select 1 from public.nodes n
  where n.workspace_id = w.id
    and n.data->'root' = 'true'::jsonb
)
on conflict do nothing;

commit;
