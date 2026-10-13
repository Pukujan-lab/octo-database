import type { UseQueryResult } from "@tanstack/react-query";

/** Narrowed query shape passed into each section of a view. */
export type QueryLike<T> = Pick<UseQueryResult<T>, "data" | "isPending" | "isError" | "error" | "refetch">;
