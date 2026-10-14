/**
 * The zod shapes MCP and REST both parse against.
 *
 * One definition, because two surfaces disagreeing about what a dataset write
 * accepts is how an agent learns that the same call works over one transport
 * and not the other. The runtime rules — which columns exist, which operator a
 * type admits — are enforced further in (`query.ts`, `values.ts`); these are
 * only the shapes.
 */
import { z } from "zod";
import {
  DATASET_AGGREGATES,
  DATASET_MAX_ROWS_PER_WRITE,
  DATASET_OPERATORS,
  DATASET_QUERY_MAX_LIMIT,
} from "@bcontext-dev/contract/datasets";
import { DATASET_MAX_AGGREGATES, DATASET_MAX_FILTERS, DATASET_MAX_GROUP_BY } from "./query";

/** `DatasetQuery` minus `schema_version`, which the server stamps. */
export const DatasetQuerySchema = z.object({
  select: z.array(z.string().min(1)).max(200).optional(),
  where: z.array(z.object({
    column: z.string().min(1),
    op: z.enum(DATASET_OPERATORS),
    value: z.unknown().optional(),
  }).strict()).max(DATASET_MAX_FILTERS).optional(),
  order_by: z.object({
    column: z.string().min(1),
    direction: z.enum(["asc", "desc"]),
  }).strict().optional(),
  group_by: z.array(z.string().min(1)).max(DATASET_MAX_GROUP_BY).optional(),
  aggregate: z.array(z.object({
    fn: z.enum(DATASET_AGGREGATES),
    column: z.string().min(1).optional(),
    as: z.string().min(1).max(60),
  }).strict()).max(DATASET_MAX_AGGREGATES).optional(),
  limit: z.number().int().min(1).max(DATASET_QUERY_MAX_LIMIT).optional(),
  offset: z.number().int().min(0).optional(),
}).strict();

const DatasetColumnOverrideSchema = z.object({
  name: z.string().min(1),
  type: z.enum(["text", "number", "boolean", "date"]),
}).strict();

/** The data half of any write: rows, or the file they came in. */
export const DatasetRowsFields = {
  rows: z.array(z.record(z.unknown())).max(DATASET_MAX_ROWS_PER_WRITE).optional(),
  csv: z.string().optional(),
  columns: z.array(DatasetColumnOverrideSchema).max(200).optional(),
} as const;
