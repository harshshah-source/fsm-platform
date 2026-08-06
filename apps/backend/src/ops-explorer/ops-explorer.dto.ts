import { IsArray, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import type { DatasetFilter, DatasetSort } from './dataset-query';
import { MAX_PAGE_SIZE } from './dataset-query';

/**
 * Request body for the dataset query + export routes (#217).
 *
 * Validation is deliberately **shallow**: shape-only at the pipe, semantics in the builder. The global
 * `ValidationPipe` runs `whitelist + forbidNonWhitelisted`, so this class's job is to reject a body
 * with unknown top-level keys or wrong top-level types before it reaches the handler. It does NOT
 * validate the interiors of `filters`/`sort`.
 *
 * That is a decision, not an omission. `dataset-query.ts` already validates every filter against the
 * registry — column existence, filterability, operator legality, type coercion, enum membership, list
 * length — and returns named codes (`UNKNOWN_COLUMN`, `COLUMN_NOT_FILTERABLE`, `INVALID_FILTER_VALUE`)
 * that the admin client renders directly. Duplicating a weaker version of that in decorators would give
 * an operator "filters.0.value must be a string" instead of "Column slaBucket accepts one of: …", and
 * would put the authoritative rules in two places. The builder is the validator; it is unit-tested
 * without a database precisely so it can carry that weight.
 */
export class OpsExplorerQueryDto {
  /** Registry column keys to select. Absent ⇒ the dataset's default-visible set. */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  columns?: string[];

  /** Validated in full by `dataset-query.ts`; see the class docstring. */
  @IsOptional()
  @IsArray()
  filters?: DatasetFilter[];

  @IsOptional()
  @IsString()
  search?: string;

  /** Validated in full by `dataset-query.ts`; see the class docstring. */
  @IsOptional()
  @IsArray()
  sort?: DatasetSort[];

  @IsOptional()
  @IsInt()
  @Min(1)
  page?: number;

  /** Clamped again in the builder — this bound only turns an absurd value into a 400 at the edge. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_SIZE)
  pageSize?: number;
}
