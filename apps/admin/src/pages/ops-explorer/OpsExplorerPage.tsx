import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  DataTable,
  ErrorState,
  FilterSelect,
  PageHeader,
  SearchInput,
  type Column,
} from '../../components/data';
import { Badge, Button, SectionCard } from '../../components/ui';
import { useApiResource } from '../../hooks';
import { useToastOptional } from '../../components/data/Toast';
import {
  apiOpsExplorerQuery,
  downloadOpsExplorerCsv,
  type ExplorerColumn,
  type ExplorerDataset,
  type ExplorerFilter,
  type ExplorerMeta,
  type ExplorerQuery,
} from '../../api/opsExplorer';
import { formatDateTimeWithYear } from '../../lib/datetime';
import { ColumnSource } from './ColumnSource';
import { FilterBuilder } from './FilterBuilder';
import { ReconciliationPanel } from './ReconciliationPanel';
import { useOpsExplorerMeta } from './useOpsExplorerMeta';

/**
 * Operations Data Explorer (#217) — `/ops-explorer`, Operations Head only, behind `OPS_EXPLORER_ENABLED`.
 *
 * A read-only investigation surface. There is no mutation anywhere on this page and there is no
 * `EditableCell` — every affordance either narrows what you are looking at or explains where it came
 * from.
 *
 * Three decisions worth naming, because each is a departure from how the rest of the admin app works:
 *
 *  1. **Server-side pagination.** Every other table in this app loads its whole result set and pages in
 *     the browser. That is right for a zone's open tickets and wrong for 24,000 device rows, so this one
 *     is the app's only server-paged table (`DataTable`'s `snoOffset` exists for exactly this case).
 *  2. **The download is NOT the table's download.** `DataTable`'s built-in export reads the rendered
 *     DOM — the correct guarantee for an operational table — but here it would silently export page 1
 *     of 480. `downloadable={false}` turns it off and the page's own button re-runs the query
 *     server-side, unpaginated. Getting the rows you have not looked at is the entire feature.
 *  3. **Sorting round-trips.** Clicking a header cannot sort locally when the local view is one page of
 *     the result, so the table's own sort is bypassed and the sort is part of the query.
 *
 * Filters are staged and applied explicitly rather than firing on every keystroke: a query here can scan
 * the whole fleet, and an operator building a five-clause filter should not fire five scans on the way.
 */
export function OpsExplorerPage() {
  const availability = useOpsExplorerMeta();

  if (availability.state === 'loading') {
    return <p className="p-6 text-sm text-ink-muted">Loading…</p>;
  }
  if (availability.state === 'disabled') {
    return (
      <SectionCard title="Operations Data Explorer">
        <p className="text-sm text-ink">
          The Operations Data Explorer is not enabled on this environment. It is a diagnostic tool and is
          off by default; an administrator turns it on with <code className="font-mono">OPS_EXPLORER_ENABLED</code>.
        </p>
      </SectionCard>
    );
  }
  if (availability.state === 'forbidden') {
    return <ErrorState message="The Operations Data Explorer is restricted to Operations Head." />;
  }
  if (availability.state === 'error') {
    return <ErrorState message={availability.message} />;
  }

  return <Explorer meta={availability.meta} />;
}

function Explorer({ meta }: { meta: ExplorerMeta }) {
  const toast = useToastOptional();
  const [datasetKey, setDatasetKey] = useState(meta.datasets[0]?.key ?? '');
  const dataset = meta.datasets.find((d) => d.key === datasetKey) ?? meta.datasets[0];

  // Staged (being edited) vs applied (in the last request). Only `applied` is in the fetch deps.
  const [draftSearch, setDraftSearch] = useState('');
  const [draftFilters, setDraftFilters] = useState<ExplorerFilter[]>([]);
  const [applied, setApplied] = useState<{ search: string; filters: ExplorerFilter[] }>({
    search: '',
    filters: [],
  });

  const [visible, setVisible] = useState<string[]>(() => defaultColumns(dataset));
  const [sort, setSort] = useState<{ column: string; direction: 'asc' | 'desc' }>(() => dataset.defaultSort);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [showColumns, setShowColumns] = useState(false);
  const [exporting, setExporting] = useState(false);

  const query: ExplorerQuery = useMemo(
    () => ({
      columns: visible,
      filters: applied.filters,
      search: applied.search || undefined,
      sort: [sort],
      page,
      pageSize,
    }),
    [visible, applied, sort, page, pageSize],
  );

  const { data, loading, error, refetch } = useApiResource(
    () => apiOpsExplorerQuery(dataset.key, query),
    [dataset.key, JSON.stringify(query)],
    'Query failed',
  );

  const switchDataset = (key: string) => {
    const next = meta.datasets.find((d) => d.key === key);
    if (!next) return;
    // A filter naming a column of the previous dataset would 400 on the next request, so everything
    // that is dataset-shaped resets together rather than leaking across the switch.
    setDatasetKey(key);
    setVisible(defaultColumns(next));
    setSort(next.defaultSort);
    setDraftFilters([]);
    setDraftSearch('');
    setApplied({ search: '', filters: [] });
    setPage(1);
  };

  const apply = () => {
    setApplied({ search: draftSearch, filters: draftFilters });
    setPage(1);
  };

  const clear = () => {
    setDraftSearch('');
    setDraftFilters([]);
    setApplied({ search: '', filters: [] });
    setPage(1);
  };

  const byKey = new Map(dataset.columns.map((c) => [c.key, c]));

  const toggleSort = (key: string) => {
    const column = byKey.get(key);
    if (!column?.sortable) return;
    setSort((s) => (s.column === key ? { column: key, direction: s.direction === 'asc' ? 'desc' : 'asc' } : { column: key, direction: 'asc' }));
    setPage(1);
  };

  const columns: Column<Record<string, unknown>>[] = (data?.columns ?? []).map((meta$) => {
    const definition = byKey.get(meta$.key);
    return {
      key: meta$.key,
      align: meta$.type === 'number' ? 'right' : 'left',
      header: (
        <span className="inline-flex items-center">
          <button
            type="button"
            onClick={() => toggleSort(meta$.key)}
            disabled={!definition?.sortable}
            aria-label={`Sort by ${meta$.label}`}
            className="uppercase tracking-wider disabled:cursor-default"
          >
            {meta$.label}
            {sort.column === meta$.key && <span aria-hidden>{sort.direction === 'asc' ? ' ▲' : ' ▼'}</span>}
          </button>
          {definition && <ColumnSource column={definition} />}
        </span>
      ),
      render: (row) => renderCell(row, definition, meta$.type),
    };
  });

  const exportAll = async () => {
    setExporting(true);
    try {
      const rows = await downloadOpsExplorerCsv(dataset.key, { ...query, page: undefined, pageSize: undefined });
      toast?.success(`Exported ${rows.toLocaleString()} rows.`);
    } catch (e) {
      toast?.error(e instanceof Error ? e.message : 'Export failed');
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title="Operations Data Explorer"
        subtitle="Read-only investigation surface — trace any number back to its rows."
      />

      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="neutral">Read-only</Badge>
        {meta.developerMode && <Badge tone="brand">Developer mode</Badge>}
        <span className="text-xs text-ink-muted">{dataset.grain}</span>
      </div>

      <SectionCard
        title="Query"
        action={
          <FilterSelect
            aria-label="Dataset"
            value={dataset.key}
            onChange={(e) => switchDataset(e.target.value)}
            data-testid="ops-explorer-dataset"
          >
            {meta.datasets.map((d) => (
              <option key={d.key} value={d.key}>
                {d.name}
              </option>
            ))}
          </FilterSelect>
        }
      >
        <div className="space-y-3">
          <p className="text-xs text-ink-muted">{dataset.description}</p>
          {dataset.baseWhere && (
            <p className="text-xs text-warning">Rows structurally excluded: {dataset.baseWhere.reason}</p>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <SearchInput
              aria-label="Global search"
              placeholder={`Search ${dataset.searchColumns.length} columns…`}
              value={draftSearch}
              onChange={(e) => setDraftSearch(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && apply()}
              className="w-72"
              data-testid="ops-explorer-search"
            />
            <Button size="sm" onClick={apply} data-testid="ops-explorer-apply">
              Apply
            </Button>
            <Button variant="ghost" size="sm" onClick={clear}>
              Clear
            </Button>
            <Button variant="secondary" size="sm" onClick={() => setShowColumns((s) => !s)}>
              Columns ({visible.length}/{dataset.columns.length})
            </Button>
            <Button
              variant="secondary"
              size="sm"
              loading={exporting}
              onClick={exportAll}
              data-testid="ops-explorer-export"
            >
              Export all rows (CSV)
            </Button>
          </div>

          {showColumns && (
            <div className="grid gap-1 rounded-card border border-line bg-surface-sunken/40 p-3 sm:grid-cols-3">
              {dataset.columns.map((c) => (
                <label key={c.key} className="flex items-center gap-2 text-xs text-ink">
                  <input
                    type="checkbox"
                    checked={visible.includes(c.key)}
                    onChange={(e) =>
                      setVisible((v) =>
                        e.target.checked ? [...v, c.key] : v.filter((k) => k !== c.key),
                      )
                    }
                  />
                  {c.label}
                </label>
              ))}
            </div>
          )}

          <FilterBuilder columns={dataset.columns} filters={draftFilters} onChange={setDraftFilters} />
        </div>
      </SectionCard>

      <DataTable
        ariaLabel={`${dataset.name} rows`}
        columns={columns}
        rows={data?.rows ?? []}
        rowKey={(row) => String(row[dataset.columns[0].key] ?? JSON.stringify(row))}
        loading={loading}
        error={error}
        onRetry={refetch}
        snoOffset={data ? (data.page - 1) * data.pageSize : 0}
        // See the file docstring: the DOM export cannot see past the current page, and this table is
        // server-paged. The page-level "Export all rows" button is the honest replacement.
        downloadable={false}
        stickyHeader
        toolbarTitle={
          data ? (
            <span className="text-xs text-ink-muted">
              {data.totalRows.toLocaleString()} rows · page {data.page} of {Math.max(1, data.totalPages)}
            </span>
          ) : undefined
        }
        toolbar={
          <div className="flex items-center gap-2">
            <FilterSelect
              aria-label="Rows per page"
              value={String(pageSize)}
              onChange={(e) => {
                setPageSize(Number(e.target.value));
                setPage(1);
              }}
            >
              {[25, 50, 100, 250, 500].map((n) => (
                <option key={n} value={n}>
                  {n} / page
                </option>
              ))}
            </FilterSelect>
            <Button variant="ghost" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
              Prev
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={!data || page >= data.totalPages}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
            </Button>
          </div>
        }
      />

      <ReconciliationPanel />

      {data?.diagnostics && <Diagnostics diagnostics={data.diagnostics} dataset={dataset} />}
    </div>
  );
}

/** Developer Mode's diagnostics block (AC-13). Absent entirely when the server did not send it. */
function Diagnostics({
  diagnostics,
  dataset,
}: {
  diagnostics: NonNullable<Awaited<ReturnType<typeof apiOpsExplorerQuery>>['diagnostics']>;
  dataset: ExplorerDataset;
}) {
  return (
    <SectionCard title="Developer mode — this query">
      <div className="space-y-3 text-xs" data-testid="ops-explorer-diagnostics">
        <div className="flex flex-wrap gap-4">
          <Stat label="Endpoint" value={diagnostics.endpoint} mono />
          <Stat label="Rows query" value={`${diagnostics.rowsQueryMs} ms`} />
          <Stat label="Count query" value={`${diagnostics.countQueryMs} ms`} />
        </div>

        {dataset.from && (
          <Block label="FROM (registry)">
            {dataset.from}
          </Block>
        )}
        <Block label="Rows SQL">{diagnostics.rowsSql}</Block>
        <Block label="Count SQL">{diagnostics.countSql}</Block>
        {/* Parameters are listed SEPARATELY from the statement, never substituted into it — a debugging
            tool that renders interpolated SQL teaches the habit of writing it. */}
        <Block label="Bound parameters">{JSON.stringify(diagnostics.params, null, 2)}</Block>
      </div>
    </SectionCard>
  );
}

function Stat({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-muted">{label}</div>
      <div className={mono ? 'font-mono text-[11px] text-ink-strong' : 'text-sm font-semibold text-ink-strong'}>
        {value}
      </div>
    </div>
  );
}

function Block({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-muted">{label}</div>
      <pre className="mt-1 overflow-x-auto rounded-md bg-surface-sunken p-2 font-mono text-[10.5px] text-ink">
        {children}
      </pre>
    </div>
  );
}

function defaultColumns(dataset: ExplorerDataset): string[] {
  return dataset.columns.filter((c) => c.defaultVisible).map((c) => c.key);
}

/**
 * Render one cell. Blank values render an em-dash rather than nothing, because in a reconciliation tool
 * "this is NULL" is a finding and an empty cell is indistinguishable from a rendering bug.
 */
function renderCell(
  row: Record<string, unknown>,
  column: ExplorerColumn | undefined,
  type: ExplorerColumn['type'],
) {
  const value = row[column?.key ?? ''];
  if (value === null || value === undefined || value === '') {
    return <span className="text-ink-muted">—</span>;
  }
  if (type === 'boolean') {
    return <Badge tone={value ? 'warning' : 'neutral'}>{String(value)}</Badge>;
  }
  const text = type === 'date' ? formatDateTimeWithYear(String(value)) : String(value);

  if (column?.drilldown) {
    // The link target and the displayed value are not always the same field — e.g. the "Plant"
    // column DISPLAYS the plant's name but its route needs the plant's id. When the registry column
    // declared a companion value (`drilldown.valueSql`, server-side), the row carries it as a hidden
    // `__dd_<key>` field alongside the visible one; that is the value the link is built from. Falls
    // back to the cell's own value when no companion was projected (the common case — the display
    // value already IS the id, e.g. a ticket's UUID).
    const linkValue = row[`__dd_${column.key}`] ?? value;
    return (
      <Link
        to={column.drilldown.route.replace(':value', encodeURIComponent(String(linkValue)))}
        className="text-brand-700 underline-offset-2 hover:underline"
        title={column.drilldown.label}
      >
        {text}
      </Link>
    );
  }
  return <span className={type === 'number' ? 'tabular-nums' : undefined}>{text}</span>;
}
