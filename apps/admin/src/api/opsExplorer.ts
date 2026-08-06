// Typed client for the Operations Data Explorer (#217, `/api/ops-explorer`).
//
// Two things here are unlike the other 29 api modules, and both follow from the feature being
// flag-gated and read-only:
//
//  1. `apiOpsExplorerMeta` resolves to `null` on 404 instead of throwing. A 404 is the backend saying
//     "OPS_EXPLORER_ENABLED is off", which is a normal state, not an error — the nav and the route both
//     read that null to mean "this feature does not exist here".
//  2. The export goes through `fetch` + a blob trigger rather than `DataTable`'s DOM export, because the
//     server re-runs the query unpaginated; the whole point is to get the rows that are not on screen.

import { authHeaders } from './authHeaders';
import { downloadCsv } from '../lib/csv';

const BASE_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000/api';

export type SourceSystem = 'FSM_POSTGRES' | 'AUTOPLANT_MYSQL' | 'DERIVED';
export type ColumnType = 'string' | 'number' | 'boolean' | 'date' | 'enum';

export interface DeveloperLineage {
  column: string | null;
  expression: string;
  formula?: string;
  ownedBy?: string;
}

export interface ColumnLineage {
  definition: string;
  system: SourceSystem;
  table: string;
  refreshTrigger: string;
  excludes?: string[];
  /** Present only when the server is in Developer Mode — it is stripped server-side, not hidden here. */
  developer?: DeveloperLineage;
}

export interface ExplorerColumn {
  key: string;
  label: string;
  type: ColumnType;
  filterable: boolean;
  sortable: boolean;
  enumValues?: string[];
  defaultVisible: boolean;
  drilldown?: { label: string; route: string };
  lineage: ColumnLineage;
}

export interface ExplorerDataset {
  key: string;
  name: string;
  description: string;
  grain: string;
  columns: ExplorerColumn[];
  searchColumns: string[];
  defaultSort: { column: string; direction: 'asc' | 'desc' };
  from?: string;
  baseWhere?: { sql?: string; reason: string };
}

export interface ExplorerMeta {
  enabled: true;
  developerMode: boolean;
  roles: string[];
  datasets: ExplorerDataset[];
}

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

/** Operators that take no value — the filter builder hides the value input for these. */
export const VALUELESS_OPERATORS: FilterOperator[] = ['isNull', 'isNotNull'];

export interface ExplorerFilter {
  column: string;
  operator: FilterOperator;
  value?: unknown;
}

export interface ExplorerQuery {
  columns?: string[];
  filters?: ExplorerFilter[];
  search?: string;
  sort?: Array<{ column: string; direction: 'asc' | 'desc' }>;
  page?: number;
  pageSize?: number;
}

export interface ExplorerPage {
  dataset: { key: string; name: string };
  columns: Array<{ key: string; label: string; type: ColumnType }>;
  rows: Array<Record<string, unknown>>;
  page: number;
  pageSize: number;
  totalRows: number;
  totalPages: number;
  diagnostics?: {
    rowsSql: string;
    countSql: string;
    params: unknown[];
    rowsQueryMs: number;
    countQueryMs: number;
    endpoint: string;
  };
}

export interface ReconciliationIdentity {
  key: string;
  name: string;
  statement: string;
  status: 'PASS' | 'FAIL';
  left: { label: string; value: number; measuredBy: string };
  right: { label: string; value: number; measuredBy: string };
  difference: number;
  likelySources: string[];
  sql?: { left: string; right: string };
}

export interface ReconciliationReport {
  checkedAt: string;
  status: 'PASS' | 'FAIL';
  identities: ReconciliationIdentity[];
  durationMs: number;
}

/** Surfaces the backend's named codes (`UNKNOWN_COLUMN`, `INVALID_FILTER_VALUE`, …) verbatim. */
export class OpsExplorerError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function fail(res: Response): Promise<never> {
  let code = `REQUEST_FAILED_${res.status}`;
  let message = `Request failed (${res.status}).`;
  try {
    const body = (await res.json()) as { code?: string; message?: string | { code?: string; message?: string } };
    // The global exception filter passes through the object thrown by BadRequestException, so the
    // named code can sit at the top level or nested under `message` depending on the throw site.
    const nested = typeof body.message === 'object' && body.message !== null ? body.message : undefined;
    code = body.code ?? nested?.code ?? code;
    message = (typeof body.message === 'string' ? body.message : nested?.message) ?? message;
  } catch {
    /* non-JSON error body — keep the status-derived defaults */
  }
  throw new OpsExplorerError(code, message);
}

/**
 * The catalog. `null` means the feature is disabled on this backend (404 from the flag guard) — callers
 * must treat that as "hide the surface", never as a failure to report.
 */
export async function apiOpsExplorerMeta(): Promise<ExplorerMeta | null> {
  const res = await fetch(`${BASE_URL}/ops-explorer/meta`, { headers: authHeaders() });
  if (res.status === 404) return null;
  if (!res.ok) return fail(res);
  return (await res.json()) as ExplorerMeta;
}

export async function apiOpsExplorerQuery(datasetKey: string, query: ExplorerQuery): Promise<ExplorerPage> {
  const res = await fetch(`${BASE_URL}/ops-explorer/datasets/${datasetKey}/query`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(query),
  });
  if (!res.ok) return fail(res);
  return (await res.json()) as ExplorerPage;
}

export async function apiOpsExplorerReconciliation(): Promise<ReconciliationReport> {
  const res = await fetch(`${BASE_URL}/ops-explorer/reconciliation`, { headers: authHeaders() });
  if (!res.ok) return fail(res);
  return (await res.json()) as ReconciliationReport;
}

/**
 * Server-side export of the FULL filtered result — deliberately not the table's DOM download, which can
 * only ever contain the rendered page. The body is generated server-side, so it is passed straight
 * through to the same download trigger the other exports use.
 */
export async function downloadOpsExplorerCsv(datasetKey: string, query: ExplorerQuery): Promise<number> {
  const res = await fetch(`${BASE_URL}/ops-explorer/datasets/${datasetKey}/export`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(query),
  });
  if (!res.ok) return fail(res);
  const disposition = res.headers.get('content-disposition') ?? '';
  const filename = /filename="([^"]+)"/.exec(disposition)?.[1] ?? `ops-explorer-${datasetKey}.csv`;
  const text = await res.text();
  downloadCsv(filename, text);
  // Row count excluding the header, for the "exported N rows" toast. `-1` because of the trailing newline.
  return Math.max(0, text.split('\n').filter(Boolean).length - 1);
}
