/**
 * One error type for the whole dataset surface, so MCP and REST map the same
 * failures to the same words and the same HTTP status without either of them
 * re-deriving what went wrong.
 */
export type DatasetErrorCode =
  | "not_found"
  | "wrong_kind"
  | "no_dataset"
  | "invalid_query"
  | "unknown_column"
  | "too_many_rows"
  | "invalid_csv"
  | "unsupported_backend";

export class DatasetError extends Error {
  constructor(
    public readonly code: DatasetErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DatasetError";
  }
}

/** The HTTP status a REST caller gets. Everything else is a bad request. */
export function datasetErrorStatus(code: DatasetErrorCode): number {
  if (code === "not_found") return 404;
  if (code === "unsupported_backend") return 501;
  return 400;
}
