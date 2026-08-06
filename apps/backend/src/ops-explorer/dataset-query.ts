import { BadRequestException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import {
  columnSql,
  getColumn,
  type ColumnType,
  type DatasetColumn,
  type DatasetDefinition,
} from './dataset-registry';

/**
 * The Operations Data Explorer query builder (#217 AC-7/AC-8).
 *
 * **Pure** — it takes a dataset definition and a request and returns `Prisma.Sql` fragments. It touches
 * no database, no Nest DI and no clock, which is deliberate: the injection-safety property is the whole
 * point of this file, and a property you can only test through a live Postgres is a property you will
 * eventually stop testing (see #156 — the local suite is not a reliable signal).
 *
 * The safety argument, in full:
 *
 *  - Identifiers: a request names a column by `key`. `getColumn` resolves that key against the registry
 *    and this module throws `UNKNOWN_COLUMN` if it does not resolve. The SQL that reaches the database
 *    is `column.sql` — a string literal written in `dataset-registry.ts`. There is **no branch** where
 *    caller text becomes an identifier.
 *  - Values: every value goes through `Prisma.sql`'s template interpolation, i.e. a bound parameter.
 *    The two operators that have no value (`isNull`/`isNotNull`) emit no parameter at all.
 *  - `in`: the list is expanded with `Prisma.join`, which binds each element separately. The list is
 *    length-capped so a caller cannot turn one request into a 100k-parameter statement.
 *  - `contains`/`startsWith`: the bound value is escaped for LIKE metacharacters, so a search for `%`
 *    matches a literal percent sign instead of everything. This is correctness as much as safety — an
 *    operator searching a device id containing `_` should not get a wildcard.
 */

export const FILTER_OPERATORS = [
  'eq',
  'neq',
  'contains',
  'startsWith',
  'in',
  'gt',
  'gte',
  'lt',
  'lte',
  'between',
  'isNull',
  'isNotNull',
] as const;

export type FilterOperator = (typeof FILTER_OPERATORS)[number];

export interface DatasetFilter {
  column: string;
  operator: FilterOperator;
  /** Absent for `isNull`/`isNotNull`; a 2-tuple for `between`; an array for `in`; scalar otherwise. */
  value?: unknown;
}

export interface DatasetSort {
  column: string;
  direction: 'asc' | 'desc';
}

export interface DatasetQueryRequest {
  /** Registry column keys to select. Empty/absent ⇒ the dataset's `defaultVisible` set. */
  columns?: string[];
  filters?: DatasetFilter[];
  /** Free-text term scanned across the dataset's declared `searchColumns`. */
  search?: string;
  sort?: DatasetSort[];
  page?: number;
  pageSize?: number;
}

export const MAX_PAGE_SIZE = 500;
export const DEFAULT_PAGE_SIZE = 50;
/** Cap on an `in` list. Well above any real filter; low enough that one request cannot bind 100k params. */
export const MAX_IN_VALUES = 1_000;
/** Cap on multi-column sort. Beyond this it is not a sort, it is a way to make Postgres think. */
export const MAX_SORT_COLUMNS = 3;

export interface ResolvedQuery {
  /** The columns actually selected, in order — drives both the SELECT list and the response's column order. */
  columns: DatasetColumn[];
  /** `SELECT ... FROM ... WHERE ... ORDER BY ... LIMIT ... OFFSET ...` */
  rows: Prisma.Sql;
  /** `SELECT COUNT(*) ... FROM ... WHERE ...` — the same predicate, no sort, no pagination. */
  total: Prisma.Sql;
  page: number;
  pageSize: number;
}

// ---------------------------------------------------------------------------------------------
// Value coercion
// ---------------------------------------------------------------------------------------------

/**
 * Coerce a JSON value to the column's declared type before binding it.
 *
 * This exists because a bound parameter is safe but not necessarily *right*: binding the string
 * `"true"` against a boolean column, or `"12"` against a numeric one, makes Postgres raise a type
 * error that surfaces as a 500 rather than the 400 the caller deserves. Coercing here turns every
 * such case into an explicit, named rejection.
 */
function coerce(column: DatasetColumn, raw: unknown): string | number | boolean | Date | null {
  if (raw === null) return null;
  const type: ColumnType = column.type;

  if (type === 'number') {
    const n = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isFinite(n)) {
      throw new BadRequestException({
        code: 'INVALID_FILTER_VALUE',
        message: `Column "${column.key}" is numeric; received ${JSON.stringify(raw)}.`,
      });
    }
    return n;
  }

  if (type === 'boolean') {
    if (typeof raw === 'boolean') return raw;
    const s = String(raw).trim().toLowerCase();
    if (s === 'true') return true;
    if (s === 'false') return false;
    throw new BadRequestException({
      code: 'INVALID_FILTER_VALUE',
      message: `Column "${column.key}" is boolean; received ${JSON.stringify(raw)}.`,
    });
  }

  if (type === 'date') {
    const d = raw instanceof Date ? raw : new Date(String(raw));
    if (Number.isNaN(d.getTime())) {
      throw new BadRequestException({
        code: 'INVALID_FILTER_VALUE',
        message: `Column "${column.key}" is a timestamp; received ${JSON.stringify(raw)}.`,
      });
    }
    return d;
  }

  if (type === 'enum' && column.enumValues) {
    const s = String(raw);
    if (!column.enumValues.includes(s)) {
      throw new BadRequestException({
        code: 'INVALID_FILTER_VALUE',
        message: `Column "${column.key}" accepts one of: ${column.enumValues.join(', ')}. Received ${JSON.stringify(raw)}.`,
      });
    }
    return s;
  }

  return String(raw);
}

/**
 * Escape LIKE metacharacters so a user's `%` or `_` matches itself. Paired with `ESCAPE '\'` at every
 * call site — without that clause Postgres uses backslash by default, but stating it makes the pairing
 * legible rather than folklore.
 */
export function escapeLike(value: string): string {
  return value.replace(/([\\%_])/g, '\\$1');
}

// ---------------------------------------------------------------------------------------------
// Predicate construction
// ---------------------------------------------------------------------------------------------

function requireColumn(dataset: DatasetDefinition, key: string, purpose: string): DatasetColumn {
  const column = getColumn(dataset, key);
  if (!column) {
    throw new BadRequestException({
      code: 'UNKNOWN_COLUMN',
      message: `Unknown ${purpose} column "${key}" for dataset "${dataset.key}".`,
    });
  }
  return column;
}

function filterPredicate(dataset: DatasetDefinition, filter: DatasetFilter): Prisma.Sql {
  const column = requireColumn(dataset, filter.column, 'filter');
  if (!column.filterable) {
    throw new BadRequestException({
      code: 'COLUMN_NOT_FILTERABLE',
      message: `Column "${column.key}" is not filterable.`,
    });
  }
  if (!FILTER_OPERATORS.includes(filter.operator)) {
    throw new BadRequestException({
      code: 'UNKNOWN_OPERATOR',
      message: `Unknown filter operator "${String(filter.operator)}".`,
    });
  }

  const c = columnSql(column);

  switch (filter.operator) {
    case 'isNull':
      return Prisma.sql`${c} IS NULL`;
    case 'isNotNull':
      return Prisma.sql`${c} IS NOT NULL`;

    case 'contains':
    case 'startsWith': {
      if (column.type !== 'string' && column.type !== 'enum') {
        throw new BadRequestException({
          code: 'OPERATOR_TYPE_MISMATCH',
          message: `Operator "${filter.operator}" applies to text columns; "${column.key}" is ${column.type}.`,
        });
      }
      const needle = escapeLike(String(filter.value ?? ''));
      const pattern = filter.operator === 'contains' ? `%${needle}%` : `${needle}%`;
      return Prisma.sql`${c}::text ILIKE ${pattern} ESCAPE '\\'`;
    }

    case 'in': {
      const list = Array.isArray(filter.value) ? filter.value : [filter.value];
      if (list.length === 0) {
        // An empty IN list is a query for nothing. Emitting `IN ()` is a syntax error and emitting
        // `TRUE` would silently ignore the operator's intent, so it becomes an explicit empty result.
        return Prisma.sql`FALSE`;
      }
      if (list.length > MAX_IN_VALUES) {
        throw new BadRequestException({
          code: 'FILTER_LIST_TOO_LONG',
          message: `"in" accepts at most ${MAX_IN_VALUES} values; received ${list.length}.`,
        });
      }
      const bound = list.map((v) => coerce(column, v));
      return Prisma.sql`${c} IN (${Prisma.join(bound)})`;
    }

    case 'between': {
      const pair = filter.value;
      if (!Array.isArray(pair) || pair.length !== 2) {
        throw new BadRequestException({
          code: 'INVALID_FILTER_VALUE',
          message: `"between" requires a two-element [from, to] array for column "${column.key}".`,
        });
      }
      return Prisma.sql`${c} BETWEEN ${coerce(column, pair[0])} AND ${coerce(column, pair[1])}`;
    }

    default: {
      const value = coerce(column, filter.value);
      // `eq`/`neq` against NULL: SQL's `= NULL` is never true, which is a classic silent-empty-result
      // trap in a debugging tool. Route it to IS [NOT] NULL so the filter means what the operator read.
      if (value === null) {
        return filter.operator === 'eq'
          ? Prisma.sql`${c} IS NULL`
          : filter.operator === 'neq'
            ? Prisma.sql`${c} IS NOT NULL`
            : Prisma.sql`FALSE`;
      }
      switch (filter.operator) {
        case 'eq':
          return Prisma.sql`${c} = ${value}`;
        case 'neq':
          // NULL-safe: `col <> x` drops NULL rows, which reads as "the filter also hid the blanks".
          return Prisma.sql`(${c} IS DISTINCT FROM ${value})`;
        case 'gt':
          return Prisma.sql`${c} > ${value}`;
        case 'gte':
          return Prisma.sql`${c} >= ${value}`;
        case 'lt':
          return Prisma.sql`${c} < ${value}`;
        default:
          return Prisma.sql`${c} <= ${value}`;
      }
    }
  }
}

/** Global search — one ILIKE per declared search column, OR'd. Registry-declared, so never caller-chosen. */
function searchPredicate(dataset: DatasetDefinition, term: string): Prisma.Sql | null {
  const trimmed = term.trim();
  if (trimmed === '') return null;
  const pattern = `%${escapeLike(trimmed)}%`;
  const parts = dataset.searchColumns
    .map((key) => getColumn(dataset, key))
    .filter((c): c is DatasetColumn => c !== undefined)
    .map((c) => Prisma.sql`${columnSql(c)}::text ILIKE ${pattern} ESCAPE '\\'`);
  if (parts.length === 0) return null;
  return Prisma.sql`(${Prisma.join(parts, ' OR ')})`;
}

// ---------------------------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------------------------

export function resolveColumns(dataset: DatasetDefinition, requested?: string[]): DatasetColumn[] {
  if (!requested || requested.length === 0) {
    return dataset.columns.filter((c) => c.defaultVisible);
  }
  // Deduplicated, but in the caller's order — the column picker's ordering is a real preference.
  const seen = new Set<string>();
  const out: DatasetColumn[] = [];
  for (const key of requested) {
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(requireColumn(dataset, key, 'selected'));
  }
  return out;
}

function whereClause(dataset: DatasetDefinition, request: DatasetQueryRequest): Prisma.Sql {
  const parts: Prisma.Sql[] = [];
  if (dataset.baseWhere) parts.push(Prisma.raw(`(${dataset.baseWhere.sql})`));
  for (const filter of request.filters ?? []) parts.push(filterPredicate(dataset, filter));
  if (request.search) {
    const search = searchPredicate(dataset, request.search);
    if (search) parts.push(search);
  }
  if (parts.length === 0) return Prisma.empty;
  return Prisma.sql` WHERE ${Prisma.join(parts, ' AND ')}`;
}

function orderByClause(dataset: DatasetDefinition, sort: DatasetSort[] | undefined): Prisma.Sql {
  const requested = sort && sort.length > 0 ? sort : [dataset.defaultSort];
  if (requested.length > MAX_SORT_COLUMNS) {
    throw new BadRequestException({
      code: 'TOO_MANY_SORT_COLUMNS',
      message: `At most ${MAX_SORT_COLUMNS} sort columns; received ${requested.length}.`,
    });
  }
  const parts = requested.map((s) => {
    const column = requireColumn(dataset, s.column, 'sort');
    if (!column.sortable) {
      throw new BadRequestException({
        code: 'COLUMN_NOT_SORTABLE',
        message: `Column "${column.key}" is not sortable.`,
      });
    }
    // `direction` never reaches SQL as caller text — it selects between two literal fragments. NULLS
    // LAST on both directions so "no last ping" sorts to the bottom rather than dominating page 1,
    // which for a fleet where a third of rows have no fitment is the difference between usable and not.
    const dir = s.direction === 'asc' ? Prisma.raw('ASC NULLS LAST') : Prisma.raw('DESC NULLS LAST');
    return Prisma.sql`${columnSql(column)} ${dir}`;
  });
  return Prisma.sql` ORDER BY ${Prisma.join(parts, ', ')}`;
}

/**
 * Build the row query and its matching count query.
 *
 * `pageSize: 0` is the export path — it means "no LIMIT", and is only reachable from the export
 * handler, never from the paged read (which clamps to `MAX_PAGE_SIZE`).
 */
export function buildDatasetQuery(
  dataset: DatasetDefinition,
  request: DatasetQueryRequest,
  opts: { unbounded?: boolean } = {},
): ResolvedQuery {
  const columns = resolveColumns(dataset, request.columns);
  if (columns.length === 0) {
    throw new BadRequestException({ code: 'NO_COLUMNS_SELECTED', message: 'Select at least one column.' });
  }

  const from = Prisma.raw(dataset.from);
  const where = whereClause(dataset, request);
  const orderBy = orderByClause(dataset, request.sort);

  // Aliased with the registry key so the driver hands back exactly the keys the client asked for.
  // The alias is a registry key, quoted — it is code-authored, like everything else emitted here.
  //
  // A column whose drilldown target needs a DIFFERENT value than the one displayed (e.g. the "Plant"
  // column shows `plants.name` but its link needs `plants.plant_id`) rides its `drilldown.valueSql`
  // along as a second, hidden projection aliased `__dd_<key>`. This keeps the registry entry a SINGLE
  // column definition — one SQL expression for display, one (optional) for the link — rather than
  // forcing a second visible "Plant ID" column into existence just to carry a link target.
  const selectList = Prisma.join(
    columns.flatMap((c) => {
      const primary = Prisma.sql`${columnSql(c)} AS ${Prisma.raw(`"${c.key}"`)}`;
      if (!c.drilldown?.valueSql) return [primary];
      return [primary, Prisma.sql`${Prisma.raw(c.drilldown.valueSql)} AS ${Prisma.raw(`"__dd_${c.key}"`)}`];
    }),
    ', ',
  );

  const page = Math.max(1, Math.floor(request.page ?? 1));
  const pageSize = opts.unbounded
    ? 0
    : Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(request.pageSize ?? DEFAULT_PAGE_SIZE)));

  const limits = opts.unbounded
    ? Prisma.empty
    : Prisma.sql` LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`;

  return {
    columns,
    rows: Prisma.sql`SELECT ${selectList} FROM ${from}${where}${orderBy}${limits}`,
    total: Prisma.sql`SELECT COUNT(*)::int AS "count" FROM ${from}${where}`,
    page,
    pageSize,
  };
}

/**
 * Render a built statement for Developer Mode: the SQL with `$n` placeholders, and the bound values
 * **separately**. Never string-substituted together — a debugging tool that shows you interpolated SQL
 * teaches you to write interpolated SQL, and someone will eventually copy it into a real query.
 */
export function explainStatement(statement: Prisma.Sql): { sql: string; params: unknown[] } {
  return {
    sql: statement.text,
    params: statement.values.map((v) => (v instanceof Date ? v.toISOString() : v)),
  };
}
