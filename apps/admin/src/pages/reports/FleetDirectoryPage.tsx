import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  apiFleetDirectory,
  type FleetDirectory,
  type FleetDirectoryCompany,
  type FleetDirectoryPlant,
} from '../../api/dashboard';
import {
  ColumnHeader,
  DataTable,
  EmptyState,
  MetricStrip,
  PageHeader,
  SearchInput,
  type Column,
  type Metric,
} from '../../components/data';
import { PlantName, TierBadge } from '../../components/domain';
import { cn } from '../../lib/cn';
import { formatCount, formatPct, formatStamp } from '../../lib/fleetFormat';
import { formatPlantDisplayName } from '../../lib/plantNames';

type Tab = 'companies' | 'plants';

/**
 * Fleet Directory (Issue 122b — the Companies / Plants KPI cards' click-through). Every company and
 * plant in the caller's scope BY NAME, with the full operational breakdown (Mirrored · Operational ·
 * Warehouse · Inactive · Healthy · Inactive %) and two freshness stamps — Last Snapshot (when FSM last
 * re-derived the rows) and Last Activity (when the fleet last pinged). Searchable, sortable, and
 * cross-linked: a company row jumps to its plants; a plant row deep-links into the Device Detail list.
 *
 * The column totals reconcile exactly with the dashboard KPI strip. They previously did not: this page
 * selected a bare device count that included warehouse stock, so it summed to 23,238 against an
 * "Active Fleet" KPI of 17,415 — while the endpoint's own docstring claimed the two always agreed.
 */
export function FleetDirectoryPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const tab: Tab = searchParams.get('tab') === 'plants' ? 'plants' : 'companies';
  const companyFilter = searchParams.get('companyId') ?? '';

  const [dir, setDir] = useState<FleetDirectory | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  useEffect(() => {
    let alive = true;
    apiFleetDirectory()
      .then((d) => alive && setDir(d))
      .catch(() => alive && setError('Failed to load the fleet directory'));
    return () => {
      alive = false;
    };
  }, []);

  const setTab = (t: Tab, companyId?: string) => {
    const next = new URLSearchParams(searchParams);
    next.set('tab', t);
    if (companyId) next.set('companyId', companyId);
    else next.delete('companyId');
    setSearchParams(next, { replace: true });
  };

  const term = search.trim().toLowerCase();
  const companies = useMemo(
    () =>
      (dir?.companies ?? []).filter(
        (c) => !term || c.name.toLowerCase().includes(term) || c.companyId.includes(term),
      ),
    [dir, term],
  );
  const plants = useMemo(
    () =>
      (dir?.plants ?? []).filter(
        (p) =>
          (!companyFilter || p.companyId === companyFilter) &&
          (!term ||
            formatPlantDisplayName(p.name).toLowerCase().includes(term) ||
            p.plantId.includes(term) ||
            (p.companyName ?? '').toLowerCase().includes(term)),
      ),
    [dir, term, companyFilter],
  );

  // Column totals across the whole directory — these are the same figures the dashboard KPI strip
  // shows, because both are the same server-side aggregate at different group-by levels. Summed from
  // the unfiltered directory so the strip describes the fleet, not the current search.
  const metrics: Metric[] = useMemo(() => {
    const total = (pick: (p: FleetDirectoryPlant) => number) =>
      dir ? formatCount(dir.plants.reduce((s, p) => s + pick(p), 0)) : '—';
    return [
      { label: 'Companies', value: dir ? formatCount(dir.companies.length) : '—', tone: 'info', kpi: 'companies' },
      { label: 'Plants', value: dir ? formatCount(dir.plants.length) : '—', tone: 'info', kpi: 'plants' },
      {
        label: 'Operational Devices',
        value: total((p) => p.operationalDevices),
        hint: 'deployed & tracked',
        tone: 'brand',
        kpi: 'operationalDevices',
        testId: 'directory-operational-total',
      },
      {
        label: 'Warehouse Devices',
        value: total((p) => p.warehouseDevices),
        hint: 'removed from field ops',
        tone: 'neutral',
        kpi: 'warehouseDevices',
        testId: 'directory-warehouse-total',
      },
      {
        label: 'Inactive Operational',
        value: total((p) => p.inactiveOperational),
        hint: 'silent past the threshold',
        tone: 'warning',
        kpi: 'inactiveOperational',
      },
      {
        label: 'Healthy Operational',
        value: total((p) => p.healthyOperational),
        hint: 'reporting normally',
        tone: 'success',
        kpi: 'healthyOperational',
      },
    ];
  }, [dir]);

  /** The count columns shared by both tabs — same order, same definitions, whichever entity is listed. */
  const countColumns = <T extends FleetDirectoryCompany | FleetDirectoryPlant>(): Column<T>[] => [
    {
      key: 'mirrored',
      header: <ColumnHeader label="Mirrored" kpi="mirroredDevices" />,
      align: 'right',
      render: (r) => <span className="tabular-nums text-ink-muted">{formatCount(r.mirroredDevices)}</span>,
      sortable: true,
      sortValue: (r) => r.mirroredDevices,
    },
    {
      key: 'operational',
      header: <ColumnHeader label="Operational" kpi="operationalDevices" />,
      align: 'right',
      render: (r) => <span className="tabular-nums font-semibold text-ink-strong">{formatCount(r.operationalDevices)}</span>,
      sortable: true,
      sortValue: (r) => r.operationalDevices,
    },
    {
      key: 'warehouse',
      header: <ColumnHeader label="Warehouse" kpi="warehouseDevices" />,
      align: 'right',
      render: (r) => <span className="tabular-nums text-ink-muted">{formatCount(r.warehouseDevices)}</span>,
      sortable: true,
      sortValue: (r) => r.warehouseDevices,
    },
    {
      key: 'inactive',
      header: <ColumnHeader label="Inactive" kpi="inactiveOperational" />,
      align: 'right',
      render: (r) => <span className="tabular-nums text-ink">{formatCount(r.inactiveOperational)}</span>,
      sortable: true,
      sortValue: (r) => r.inactiveOperational,
    },
    {
      key: 'healthy',
      header: <ColumnHeader label="Healthy" kpi="healthyOperational" />,
      align: 'right',
      render: (r) => <span className="tabular-nums text-ink">{formatCount(r.healthyOperational)}</span>,
      sortable: true,
      sortValue: (r) => r.healthyOperational,
    },
    {
      key: 'inactivePct',
      header: <ColumnHeader label="Inactive %" kpi="inactivePct" />,
      align: 'right',
      render: (r) => <span className="tabular-nums font-semibold text-ink">{formatPct(r.inactivePct)}</span>,
      sortable: true,
      sortValue: (r) => r.inactivePct ?? -1,
    },
    {
      key: 'lastSnapshot',
      header: <ColumnHeader label="Last Snapshot" kpi="lastSnapshotAt" align="left" />,
      render: (r) => <span className="whitespace-nowrap text-xs tabular-nums text-ink-muted">{formatStamp(r.lastSnapshotAt)}</span>,
      sortable: true,
      sortValue: (r) => r.lastSnapshotAt ?? '',
    },
    {
      key: 'lastActivity',
      header: <ColumnHeader label="Last Activity" kpi="lastActivityAt" align="left" />,
      render: (r) => <span className="whitespace-nowrap text-xs tabular-nums text-ink-muted">{formatStamp(r.lastActivityAt)}</span>,
      sortable: true,
      sortValue: (r) => r.lastActivityAt ?? '',
    },
  ];

  const companyColumns: Column<FleetDirectoryCompany>[] = [
    {
      key: 'name',
      header: 'Company',
      render: (c) => (
        <div className="min-w-0">
          <div className="font-medium text-ink-strong">{c.name}</div>
          <div className="text-xs text-ink-muted">#{c.companyId}</div>
        </div>
      ),
      sortable: true,
      sortValue: (c) => c.name,
    },
    { key: 'tier', header: 'Tier', render: (c) => (c.tier ? <TierBadge tier={c.tier} /> : '—') },
    {
      key: 'plants',
      header: 'Plants',
      align: 'right',
      render: (c) => <span className="tabular-nums">{formatCount(c.plantCount)}</span>,
      sortable: true,
      sortValue: (c) => c.plantCount,
    },
    ...countColumns<FleetDirectoryCompany>(),
  ];

  const plantColumns: Column<FleetDirectoryPlant>[] = [
    {
      key: 'name',
      header: 'Plant',
      render: (p) => (
        <div className="min-w-0">
          <PlantName code={p.name} />
          <div className="text-xs text-ink-muted">#{p.plantId}</div>
        </div>
      ),
      sortable: true,
      sortValue: (p) => formatPlantDisplayName(p.name),
    },
    {
      key: 'company',
      header: 'Company',
      render: (p) => <span className="text-ink">{p.companyName ?? '—'}</span>,
      sortable: true,
      sortValue: (p) => p.companyName ?? '',
    },
    { key: 'zone', header: 'Zone', render: (p) => <span className="text-ink-muted">{p.zoneName ?? '—'}</span> },
    ...countColumns<FleetDirectoryPlant>(),
  ];

  const tabBtn = (t: Tab, label: string, count: number | null) => (
    <button
      type="button"
      role="tab"
      aria-selected={tab === t}
      onClick={() => setTab(t)}
      className={cn(
        'rounded-md px-2.5 py-1 text-[13px] font-medium transition-colors',
        tab === t ? 'bg-surface-card text-ink-strong shadow-sm' : 'text-ink-muted hover:text-ink-strong',
      )}
    >
      {label}
      {count !== null && <span className="ml-1.5 text-xs tabular-nums text-ink-muted">{formatCount(count)}</span>}
    </button>
  );

  // Shared between the two tables below — the tab switch and the search are the same controls
  // whichever tab is showing, and they ride inside that table's card.
  const directoryToolbar = (
    <>
      <div role="tablist" aria-label="Directory tabs" className="flex gap-1 rounded-md bg-surface-sunken p-0.5">
        {tabBtn('companies', 'Companies', dir ? companies.length : null)}
        {tabBtn('plants', 'Plants', dir ? plants.length : null)}
      </div>
      <SearchInput
        aria-label="Search directory"
        placeholder={tab === 'companies' ? 'Search companies…' : 'Search plants or companies…'}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="w-64"
      />
      {companyFilter && tab === 'plants' && (
        <button type="button" className="text-xs text-link underline" onClick={() => setTab('plants')}>
          Clear company filter
        </button>
      )}
    </>
  );

  return (
    <div>
      <PageHeader
        title="Fleet Directory"
        subtitle="Every company and plant in your scope, by name, with tracked-device counts. Click a company to see its plants; click a plant to open its devices."
      />

      {error && (
        <p role="alert" className="mb-4 text-sm text-critical">
          {error}
        </p>
      )}

      <MetricStrip metrics={metrics} cols={3} />

      {/* Tabs + search live in whichever table is showing, so the controls stay attached to the rows
          they act on rather than floating in a card of their own above them. */}
      {tab === 'companies' ? (
        <DataTable
          ariaLabel="Fleet companies"
          rowKey={(c) => c.companyId}
          columns={companyColumns}
          rows={companies}
          loading={!dir && !error}
          onRowClick={(c) => setTab('plants', c.companyId)}
          toolbar={directoryToolbar}
          empty={<EmptyState message="No companies match this search." />}
        />
      ) : (
        <DataTable
          ariaLabel="Fleet plants"
          rowKey={(p) => `${p.plantId}:${p.companyId ?? ''}`}
          columns={plantColumns}
          rows={plants}
          loading={!dir && !error}
          onRowClick={(p) => navigate(`/reports/device?plantId=${p.plantId}`)}
          toolbar={directoryToolbar}
          empty={<EmptyState message="No plants match this search." />}
        />
      )}
    </div>
  );
}
