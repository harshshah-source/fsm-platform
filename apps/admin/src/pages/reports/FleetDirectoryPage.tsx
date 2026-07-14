import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  apiFleetDirectory,
  type FleetDirectory,
  type FleetDirectoryCompany,
  type FleetDirectoryPlant,
} from '../../api/dashboard';
import {
  DataTable,
  EmptyState,
  ExportMenu,
  FilterBar,
  MetricStrip,
  PageHeader,
  SearchInput,
  type Column,
  type Metric,
} from '../../components/data';
import { PlantName, TierBadge } from '../../components/domain';
import { cn } from '../../lib/cn';
import { exportTable, type ExportFormat } from '../../lib/exportFile';
import { formatPlantDisplayName } from '../../lib/plantNames';

const nf = new Intl.NumberFormat('en-IN');

type Tab = 'companies' | 'plants';

/**
 * Fleet Directory (Issue 122b — the Companies / Plants KPI cards' click-through). Every company and
 * plant in the caller's scope BY NAME with device counts, searchable, exportable, and cross-linked:
 * a company row jumps to its plants; a plant row deep-links into the Device Detail list.
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

  const metrics: Metric[] = useMemo(
    () => [
      { label: 'Companies', value: dir ? nf.format(dir.companies.length) : '—', tone: 'info' },
      { label: 'Plants', value: dir ? nf.format(dir.plants.length) : '—', tone: 'info' },
      {
        label: 'Devices',
        value: dir ? nf.format(dir.plants.reduce((s, p) => s + p.deviceCount, 0)) : '—',
        hint: 'tracked fleet',
        tone: 'brand',
      },
    ],
    [dir],
  );

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
      render: (c) => <span className="tabular-nums">{nf.format(c.plantCount)}</span>,
      sortable: true,
      sortValue: (c) => c.plantCount,
    },
    {
      key: 'devices',
      header: 'Devices',
      align: 'right',
      render: (c) => <span className="tabular-nums">{nf.format(c.deviceCount)}</span>,
      sortable: true,
      sortValue: (c) => c.deviceCount,
    },
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
    {
      key: 'devices',
      header: 'Devices',
      align: 'right',
      render: (p) => <span className="tabular-nums">{nf.format(p.deviceCount)}</span>,
      sortable: true,
      sortValue: (p) => p.deviceCount,
    },
  ];

  const exportDirectory = (format: ExportFormat) => {
    if (tab === 'companies') {
      exportTable(format, 'fleet-companies', 'Fleet Directory — Companies',
        ['Company', 'ID', 'Tier', 'Plants', 'Devices'],
        companies.map((c) => [c.name, c.companyId, c.tier ?? '', c.plantCount, c.deviceCount]));
    } else {
      exportTable(format, 'fleet-plants', 'Fleet Directory — Plants',
        ['Plant', 'ID', 'Company', 'Zone', 'Devices'],
        plants.map((p) => [formatPlantDisplayName(p.name), p.plantId, p.companyName ?? '', p.zoneName ?? '', p.deviceCount]));
    }
  };

  const tabBtn = (t: Tab, label: string, count: number | null) => (
    <button
      type="button"
      role="tab"
      aria-selected={tab === t}
      onClick={() => setTab(t)}
      className={cn(
        'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
        tab === t ? 'bg-surface-card text-ink-strong shadow-sm' : 'text-ink-muted hover:text-ink-strong',
      )}
    >
      {label}
      {count !== null && <span className="ml-1.5 text-xs tabular-nums text-ink-muted">{nf.format(count)}</span>}
    </button>
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

      <FilterBar>
        <div role="tablist" aria-label="Directory tabs" className="flex gap-1 rounded-md bg-surface-sunken p-1">
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
          <button type="button" className="text-xs text-brand-700 underline" onClick={() => setTab('plants')}>
            Clear company filter
          </button>
        )}
        <span className="ml-auto">
          <ExportMenu onExport={exportDirectory} disabled={!dir} label="Download" />
        </span>
      </FilterBar>

      {tab === 'companies' ? (
        <DataTable
          ariaLabel="Fleet companies"
          rowKey={(c) => c.companyId}
          columns={companyColumns}
          rows={companies}
          loading={!dir && !error}
          onRowClick={(c) => setTab('plants', c.companyId)}
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
          empty={<EmptyState message="No plants match this search." />}
        />
      )}
    </div>
  );
}
