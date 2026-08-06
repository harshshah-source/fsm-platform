import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  buildDatasetQuery,
  explainStatement,
  type DatasetQueryRequest,
} from './dataset-query';
import { getDataset, type DatasetColumn, type DatasetDefinition } from './dataset-registry';

/**
 * Executes a registry-built dataset query (#217). Thin by design — all the interesting logic (and all
 * the safety) lives in the pure builder next door, so this file is only "run it, time it, shape it".
 *
 * Row values are normalised for JSON on the way out: Prisma hands back `BigInt` for int8 columns and
 * `Decimal` for numerics, neither of which `JSON.stringify` can serialize. Doing it here rather than in
 * a global interceptor keeps the conversion visible at the one place it matters and keeps `deviceId`
 * (a string with meaningful leading zeros) safely untouched.
 */

export interface DatasetPage {
  dataset: { key: string; name: string };
  /** The selected columns, in order, so the client renders headers without re-deriving them. */
  columns: Array<{ key: string; label: string; type: DatasetColumn['type'] }>;
  rows: Array<Record<string, unknown>>;
  page: number;
  pageSize: number;
  totalRows: number;
  totalPages: number;
  /** Developer Mode only — the diagnostics panel's whole payload. */
  diagnostics?: {
    rowsSql: string;
    countSql: string;
    params: unknown[];
    rowsQueryMs: number;
    countQueryMs: number;
    endpoint: string;
  };
}

@Injectable()
export class DatasetQueryService {
  constructor(private readonly prisma: PrismaService) {}

  /** Registry lookup that 404s rather than 400s — an unknown dataset is a wrong URL, not a bad body. */
  requireDataset(key: string): DatasetDefinition {
    const dataset = getDataset(key);
    if (!dataset) {
      throw new NotFoundException({ code: 'UNKNOWN_DATASET', message: `No dataset "${key}".` });
    }
    return dataset;
  }

  async query(
    datasetKey: string,
    request: DatasetQueryRequest,
    developerMode: boolean,
  ): Promise<DatasetPage> {
    const dataset = this.requireDataset(datasetKey);
    const built = buildDatasetQuery(dataset, request);

    // Timed separately: when a dataset gets slow it is almost always one of the two, and an operator
    // needs to know which. A COUNT over a wide join is a different problem from a slow ORDER BY.
    const rowsStart = Date.now();
    const rows = await this.prisma.$queryRaw<Array<Record<string, unknown>>>(built.rows);
    const rowsQueryMs = Date.now() - rowsStart;

    const countStart = Date.now();
    const countRows = await this.prisma.$queryRaw<Array<{ count: number }>>(built.total);
    const countQueryMs = Date.now() - countStart;

    const totalRows = countRows[0]?.count ?? 0;

    return {
      dataset: { key: dataset.key, name: dataset.name },
      columns: built.columns.map((c) => ({ key: c.key, label: c.label, type: c.type })),
      rows: rows.map(normalizeRow),
      page: built.page,
      pageSize: built.pageSize,
      totalRows,
      totalPages: built.pageSize > 0 ? Math.ceil(totalRows / built.pageSize) : 1,
      ...(developerMode
        ? {
            diagnostics: {
              rowsSql: explainStatement(built.rows).sql,
              countSql: explainStatement(built.total).sql,
              params: explainStatement(built.rows).params,
              rowsQueryMs,
              countQueryMs,
              endpoint: `POST /api/ops-explorer/datasets/${dataset.key}/query`,
            },
          }
        : {}),
    };
  }

  /**
   * Stream the full, unpaginated result for export.
   *
   * Cursor-free and unbounded on purpose: the export must be the same query the operator is looking at,
   * with pagination removed, or the download stops being evidence. `$queryRaw` materialises the result
   * in the process — acceptable at this scale (the widest dataset is ~24k rows of scalars) and honest
   * about its limit; if a future dataset outgrows it the fix is a server-side cursor here, with no
   * change to the registry, the builder, or the client.
   */
  async exportRows(
    datasetKey: string,
    request: DatasetQueryRequest,
  ): Promise<{ dataset: DatasetDefinition; columns: DatasetColumn[]; rows: Array<Record<string, unknown>> }> {
    const dataset = this.requireDataset(datasetKey);
    const built = buildDatasetQuery(dataset, request, { unbounded: true });
    const rows = await this.prisma.$queryRaw<Array<Record<string, unknown>>>(built.rows);
    return { dataset, columns: built.columns, rows: rows.map(normalizeRow) };
  }
}

/** BigInt → string (never Number — int8 outruns float64), Decimal → number, Date → ISO. */
function normalizeRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (typeof value === 'bigint') out[key] = value.toString();
    else if (value instanceof Date) out[key] = value.toISOString();
    else if (value !== null && typeof value === 'object' && typeof (value as { toNumber?: unknown }).toNumber === 'function') {
      out[key] = (value as { toNumber(): number }).toNumber();
    } else out[key] = value;
  }
  return out;
}
