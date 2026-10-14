-- 0086_dataset_rows.sql
--
-- QUÉ
--   El kind `data` deja de ser un CSV pegado dentro de `content_md` y pasa a
--   ser un dataset de verdad. Tres piezas: la tabla `dataset_rows`, donde vive
--   una fila del dataset por fila de tabla; los índices que hacen que
--   paginarlas y filtrarlas no sea un seq scan; y el bucket `dataset-files`,
--   donde queda el fichero original cuando lo hubo. El nodo se queda con lo
--   único que ES conocimiento —el esquema, el recuento y la descripción, en
--   `data.dataset`— que es también lo único que se embebe.
--
--   El contrato que describe todo esto desde fuera es
--   `packages/contract/src/datasets.ts`: `DatasetSchema`, `DatasetQuery` y las
--   constantes `DATASET_MAX_ROWS` (200.000) y `DATASET_MAX_ROWS_PER_WRITE`
--   (5.000). Los números que aparecen aquí abajo son ese contrato escrito en
--   SQL; si allí cambian, esto es una migración, no un despliegue.
--
-- POR QUÉ UNA TABLA COMPARTIDA Y NO UNA TABLA POR DATASET
--   Una tabla por dataset suena tentadora —columnas de verdad, tipos de
--   verdad, índices por columna— y es una trampa: significa ejecutar DDL en
--   caliente cada vez que alguien sube un CSV, un catálogo con miles de
--   tablas que ningún `pg_dump` ni ninguna migración futura vuelve a tratar
--   como un conjunto, y un modelo de permisos que deja de ser un filtro
--   (`where workspace_id = ...`) para pasar a ser un `grant` por objeto. Una
--   tabla ancha con `jsonb` paga algo en cada consulta y ahorra todo lo demás.
--
-- POR QUÉ `workspace_id` ESTÁ AQUÍ AUNQUE ESTÉ EN `nodes`
--   Es la misma desnormalización que hace `embeddings` desde 0001, y por la
--   misma razón: en este sistema el filtro por workspace no es una comodidad,
--   es LA defensa. Ningún camino de servidor evalúa RLS —`getStorage()` corre
--   sobre `service_role`, ver la cabecera de 0062— así que lo que separa los
--   datos de dos clientes es literalmente el `where` que escriba la capa de
--   aplicación. Obligarla a hacer un join contra `nodes` para poder escribir
--   ese `where` es garantizar que algún día alguien no lo haga.
--
--   Lo que una columna copiada suele costar es que se desincronice, y eso sí
--   se puede quitar de la mesa: la FK no va contra `nodes(id)` sino contra el
--   par `nodes(id, workspace_id)`. Postgres se encarga de que la fila no pueda
--   declarar un workspace distinto del de su nodo — ni por un bug de la capa
--   de aplicación ni por un script. Es el mismo patrón que usa el catálogo de
--   capabilities desde 0031, donde el índice `unique (id, workspace_id)` está
--   puesto exactamente para poder apuntar a él.
--
-- POR QUÉ LA CLAVE PRIMARIA ES `(node_id, idx)` Y NO UN uuid
--   Casi todas las tablas de este esquema tienen un `id uuid`. Estas filas no
--   lo necesitan: nadie las enlaza, no aparecen en el grafo, no tienen ruta
--   propia y no hay ninguna FK que las apunte. Se leen siempre igual —"las
--   filas del nodo X, ordenadas, de la N a la N+100"— y esa lectura ES la
--   clave. Un uuid añadiría 16 bytes y un índice entero sin ningún lector,
--   pagados 200.000 veces por dataset. La misma clave, de paso, es la que
--   impide dos filas con el mismo índice en el mismo dataset.
--
-- POR QUÉ EL TOPE DE FILAS NO SE CUENTA
--   `DATASET_MAX_ROWS` tenía dos sitios posibles y los dos malos. Un trigger
--   que cuente: una escritura son hasta 5.000 filas, así que `for each row`
--   son 5.000 `count(*)` sobre una tabla de cientos de miles, y `for each
--   statement` sigue contando una vez por lote y aun así rechaza el lote
--   entero cuando ya está insertado. Un contador materializado: una fila de
--   contención por dataset y una invariante más que mantener a mano.
--
--   Pero el tope no hace falta contarlo: se deduce del dominio de `idx`. Si
--   el índice de fila es único dentro del dataset (lo garantiza la PK) y está
--   acotado a [0, 200.000) (lo garantiza el CHECK de aquí abajo), entonces un
--   dataset no puede tener más de 200.000 filas. Coste: una comparación de
--   enteros por fila, sin leer nada. La comprobación amable —la que rechaza
--   la escritura entera antes de insertar y explica por qué— la sigue haciendo
--   la capa de aplicación, que además ya conoce el recuento porque lo mantiene
--   en `data.dataset.row_count`. Esto es la red de debajo, la que cubre los
--   caminos que nadie recuerda que existen.
--
-- POR QUÉ EL GIN LLEVA `node_id` DENTRO
--   El índice tiene que servir a `where node_id = $1 and data @> ...`. Un GIN
--   sólo sobre `data` obliga al planner a construir el bitmap de TODAS las
--   filas del sistema que contienen ese valor —las de los otros datasets
--   incluidas— para luego cruzarlo con el del nodo; en una tabla compartida
--   eso empeora justo cuando el producto va bien. Con `btree_gin` el `node_id`
--   entra en el propio índice y la lista invertida ya sale acotada al dataset.
--
-- SIN BACKFILL, A PROPÓSITO
--   Los nodos `data` que hoy guardan su tabla en un bloque ```csv dentro de
--   `content_md` NO se migran aquí. Hacerlo exige parsear CSV de verdad
--   —comillas, comillas escapadas, saltos de línea dentro de una celda,
--   separador ambiguo, BOM— y también inferir los tipos de cada columna con
--   `inferSchema()`, que es código del contrato. Un parser CSV escrito en
--   PL/pgSQL para ejecutarse una vez es la clase de cosa que parece funcionar
--   hasta que se come un fichero con comas dentro de las comillas y deja el
--   dataset silenciosamente mal. La migración de los nodos existentes la hace
--   la capa de aplicación. Que nadie la busque aquí.
--
-- Idempotente: se puede aplicar varias veces.

begin;

-- `btree_gin` da a un índice GIN operator classes para tipos escalares
-- (aquí, uuid), que es lo que permite meter `node_id` en el mismo índice que
-- el jsonb.
--
-- Comprobado contra la base de producción autohospedada el 2026-09-10, para
-- no dejarlo en «viene en la imagen de Supabase, supongo»: está disponible en
-- 1.3 y sin instalar, y es `trusted`, así que la instala un rol con CREATE
-- sobre la base sin necesidad de ser superusuario — que es justo lo que no
-- tenemos ahí. El `create extension` de esta línea, por tanto, va a funcionar
-- cuando se aplique.
--
-- Si algún día se aplica sobre un stack donde no esté, la migración falla
-- entera dentro de la transacción (no deja nada a medias) y la alternativa es
-- un GIN sólo sobre `data`, dejando que el planner cruce bitmaps con la PK:
-- peor, pero funcional.
create extension if not exists btree_gin;

-- Destino de la FK compuesta: no añade unicidad nueva (`id` ya es PK), sólo
-- hace referenciable el par. Mismo truco que `capabilities` en 0031.
create unique index if not exists nodes_id_workspace_uniq
  on public.nodes (id, workspace_id);

-- ============================================================
-- dataset_rows
-- ============================================================
--
-- Deliberadamente estrecha: cada columna se paga hasta 200.000 veces por
-- dataset. No hay `created_at` ni `updated_at` porque una fila de un dataset
-- no se audita individualmente — lo que se versiona y se fecha es el dataset,
-- en `data.dataset.updated_at` del nodo.

create table if not exists public.dataset_rows (
  -- El nodo de kind `data` al que pertenece la fila.
  node_id      uuid not null,

  -- Copiado de `nodes` a propósito (ver cabecera). La FK compuesta de abajo
  -- impide que pueda discrepar.
  workspace_id uuid not null,

  -- Índice de fila estable dentro del dataset, base 0: es el orden original
  -- del fichero y la clave por la que se pagina. Estable significa que no se
  -- renumera al borrar: una referencia a "la fila 4.312" sigue señalando a la
  -- misma fila mañana. Por eso puede haber huecos, y por eso el tope de abajo
  -- acota el índice y no el recuento.
  idx          int not null,

  -- La fila: {"columna": valor}. Los valores van ya TIPADOS según el esquema
  -- inferido en la ingesta (number/boolean/date/text), no como texto crudo:
  -- si "90" y "500" entran como cadenas, `mrr > 500` compara alfabéticamente
  -- y miente. La inferencia es del contrato (`inferColumnType`), aquí sólo se
  -- guarda el resultado.
  data         jsonb not null default '{}'::jsonb,

  -- Ver "POR QUÉ LA CLAVE PRIMARIA ES (node_id, idx)".
  primary key (node_id, idx),

  -- Ver "POR QUÉ EL TOPE DE FILAS NO SE CUENTA". 200000 es `DATASET_MAX_ROWS`
  -- del contrato; subirlo es tocar los dos sitios a la vez.
  constraint dataset_rows_idx_bounds check (idx >= 0 and idx < 200000),

  -- Una fila es un objeto, no un array ni un escalar. El DSL de consulta
  -- direcciona columnas por nombre; cualquier otra forma de jsonb rompe todas
  -- las traducciones a SQL de golpe y es mejor que no llegue a entrar.
  constraint dataset_rows_data_is_object check (jsonb_typeof(data) = 'object'),

  -- Borrar el nodo se lleva sus filas; borrar el workspace se lleva los nodos
  -- y con ellos las filas. `on update cascade` porque si algún día se mueve un
  -- nodo de workspace, lo que se quiere es que sus filas se muevan con él en
  -- la misma sentencia, no un error de FK a medio camino.
  constraint dataset_rows_node_fk foreign key (node_id, workspace_id)
    references public.nodes (id, workspace_id)
    on update cascade on delete cascade
);

comment on table public.dataset_rows is
  'Filas de los nodos de kind `data`. Una tabla compartida, no una por dataset: el permiso es un filtro por workspace, no un grant por objeto. El tope de DATASET_MAX_ROWS se deriva del dominio de `idx`, no se cuenta.';

comment on column public.dataset_rows.workspace_id is
  'Copia de nodes.workspace_id. Existe porque el filtro por workspace es la única defensa (ningún camino de servidor evalúa RLS, ver 0062) y no debe depender de un join; la FK compuesta contra nodes(id, workspace_id) impide que se desincronice.';

comment on column public.dataset_rows.idx is
  'Índice de fila estable, base 0. Puede tener huecos: no se renumera al borrar. Acotado a [0, DATASET_MAX_ROWS), que es como se enforcea el tope del dataset sin contar filas.';

-- Paginación. La PK ya sirve `where node_id = $1 order by idx`, así que no
-- hace falta ningún índice más para el camino caliente.
--
-- Filtros. El GIN cubre igualdad y contención (`data @> '{"col":"val"}'`),
-- que es a lo que traduce el operador `eq` del DSL y lo que de otro modo sería
-- un seq scan del dataset entero. Lo que NO cubre —y conviene saberlo antes de
-- perseguir un plan raro— son los rangos (`gt`/`lt`) y `contains`, que ningún
-- índice genérico sobre jsonb puede acelerar sin un índice por columna, y en
-- una tabla compartida no hay columnas. Esos filtros recorren las filas del
-- nodo, y ese recorrido está acotado por el propio dataset gracias al
-- `node_id` que va dentro del índice.
--
-- `jsonb_path_ops` en vez del opclass por defecto: indexa hashes de caminos
-- completos en vez de cada clave y cada valor por separado, así que ocupa
-- bastante menos —importa a 200.000 filas por dataset— y responde mejor a
-- `@>`. Lo que se pierde es el operador de existencia de clave (`?`), que
-- serviría a `is_null`; se acepta porque ese filtro casi nunca es selectivo:
-- devuelve media tabla y acaba en scan igualmente.
create index if not exists dataset_rows_node_data_idx
  on public.dataset_rows using gin (node_id, data jsonb_path_ops);

-- No hay índice por `workspace_id` solo, y es una decisión, no un olvido:
-- aquí `workspace_id` es un guardia en el `where`, no una clave de búsqueda —
-- toda consulta llega ya con el `node_id`. El cascade tampoco lo necesita
-- (baja por `nodes`). Si algún día hacen falta agregados por workspace
-- (cuota, facturación por volumen), se añade entonces.

-- RLS
--
-- Habilitada y sin políticas, como `mcp_usage_counters` (0069) y la telemetría
-- de errores (0074). Nadie lee esto con la clave del usuario: la web pregunta
-- por HTTP a la API y la API consulta con `service_role` después de resolver
-- el grant del principal sobre el workspace. Sin políticas la tabla falla
-- cerrada el día que alguien la consulte con `anon`, que es exactamente lo que
-- se quiere de la primera tabla del sistema que guarda DATOS del cliente y no
-- metadatos.
alter table public.dataset_rows enable row level security;

-- ============================================================
-- Bucket `dataset-files` — el fichero original
-- ============================================================
--
-- Convención de ruta: ${workspace_id}/${node_id}/${uuid}.${ext}, la misma que
-- `node-images` (0004), y es lo que guarda `DatasetSchema.source_file.path`.
--
-- POR QUÉ PRIVADO, AL CONTRARIO QUE `node-images`
--   Aquel es público porque una imagen incrustada en markdown tiene que
--   renderizar en un `<img>` sin firmar nada en cada pintada. Aquí no hay nada
--   de eso: el original se descarga de vez en cuando, desde una pantalla en la
--   que ya hay sesión, y es el fichero de datos del cliente entero. Una URL
--   pública para eso es un enlace que, una vez filtrado, no caduca nunca. Se
--   sirve con URL firmada emitida por el servidor tras comprobar el grant.
--
-- POR QUÉ 25 MB
--   El límite sale del tope de filas, no de una intuición: 200.000 filas
--   (`DATASET_MAX_ROWS`) con una decena de columnas cortas son unos 20-25 MB
--   de CSV. Aceptar ficheros más grandes sería guardar cosas que la ingesta va
--   a rechazar al parsearlas — pagar almacenamiento por un error diferido.
--   Aceptar bastante menos convertiría el tope real del producto en el del
--   bucket, sin decirlo en ninguna parte. 25 MB además se queda por debajo del
--   límite global del servicio de storage (50 MB por defecto en el self-host),
--   así que esto no obliga a tocar la configuración de storage ni de Kong.
--
-- POR QUÉ ESA LISTA DE MIME TYPES
--   Porque el navegador miente sobre los `.csv`. Un Windows con Excel
--   instalado manda `application/vnd.ms-excel`, otros mandan `text/plain`, y
--   `text/csv` es sólo el caso bonito. La lista existe para descartar lo
--   obviamente ajeno (imágenes, zips, binarios); el filtro que de verdad
--   decide si esto es una tabla es el parser, en la ingesta. No se incluye
--   `application/octet-stream` justamente porque es el comodín de todo.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'dataset-files',
  'dataset-files',
  false,
  26214400,
  array[
    'text/csv',
    'text/tab-separated-values',
    'text/plain',
    'application/csv',
    'application/vnd.ms-excel'
  ]
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- Políticas de storage. Mismo patrón que 0004 MENOS la lectura pública, que es
-- justo la que no queremos. Conviene leerlas por lo que son: hoy no las
-- ejercita nadie, porque tanto la subida como la firma de descargas pasan por
-- el servidor con `service_role`, que salta RLS (cabecera de 0062). Están para
-- que el bucket no quede abierto si algún día se sube desde el cliente con la
-- clave anon, y para que el default sea "cerrado" en vez de "lo que hubiera".
drop policy if exists "dataset_files_auth_insert" on storage.objects;
create policy "dataset_files_auth_insert" on storage.objects
  for insert with check (
    bucket_id = 'dataset-files' and auth.role() = 'authenticated'
  );

drop policy if exists "dataset_files_owner_read" on storage.objects;
create policy "dataset_files_owner_read" on storage.objects
  for select using (
    bucket_id = 'dataset-files' and auth.uid() = owner
  );

drop policy if exists "dataset_files_owner_update" on storage.objects;
create policy "dataset_files_owner_update" on storage.objects
  for update using (
    bucket_id = 'dataset-files' and auth.uid() = owner
  );

drop policy if exists "dataset_files_owner_delete" on storage.objects;
create policy "dataset_files_owner_delete" on storage.objects
  for delete using (
    bucket_id = 'dataset-files' and auth.uid() = owner
  );

commit;
