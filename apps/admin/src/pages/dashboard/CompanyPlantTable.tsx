import { Fragment, useMemo, useState } from 'react';
import type { CompanyPlantRow } from '../../api/dashboard';
import { EmptyState, ExportMenu, FilterBar, FilterSelect, SearchInput, Skeleton } from '../../components/data';
import { DurationBadge, PlantName, StatusPill, TierBadge } from '../../components/domain';
import { Badge } from '../../components/ui';
import { IconChevronRight, IconTruck } from '../../components/ui/icons';
import { apiTicketsList, type TicketRow } from '../../api/tickets';
import { cn } from '../../lib/cn';
import { exportTable, type ExportFormat } from '../../lib/exportFile';
import { BUCKET_CLASS, BUCKET_LABEL, BUCKET_RANGE_LABEL, criticalOnlyCount, SLA_BUCKETS } from '../../lib/slaBucket';
import { formatInactiveOfTotal } from '../../lib/inactiveDuration';
import { formatPlantDisplayName } from '../../lib/plantNames';

interface CompanyGroup {
  companyId: string;
  companyName: string;
  companyTier: string;
  plants: CompanyPlantRow[];
  totalInactive: number;
  totalDevices: number;
  byBucket: Record<string, number>;
}

function groupByCompany(rows: CompanyPlantRow[]): CompanyGroup[] {
  const byCompany = new Map<string, CompanyGroup>();
  for (const r of rows) {
    let g = byCompany.get(r.companyId);
    if (!g) {
      g = {
        companyId: r.companyId,
        companyName: r.companyName,
        companyTier: r.companyTier,
        plants: [],
        totalInactive: 0,
        totalDevices: 0,
        byBucket: {},
      };
      byCompany.set(r.companyId, g);
    }
    g.plants.push(r);
    g.totalInactive += r.totalInactive;
    g.totalDevices += r.totalDevices;
    for (const b of SLA_BUCKETS) g.byBucket[b] = (g.byBucket[b] ?? 0) + (r.byBucket[b] ?? 0);
  }
  return [...byCompany.values()];
}

// select + company + plant + inactive/total + N buckets + critical + expander.
const COLSPAN = 5 + SLA_BUCKETS.length + 1;

type AssignmentFilter = '' | 'FORMALLY_ASSIGNED' | 'UNASSIGNED';

/**
 * Company/Plant Overview (Issue 06 AC#3 · FE-06 · Issue 122 rework). Company is its own column and the
 * table opens collapsed to one aggregate row per company; expanding a company reveals its plants, and
 * a plant drills down to its open device tickets (device · vehicle · assignment · overridden · SLA).
 * A universal search + assignment-state filter scope the tree and the drill-down; a multi-format
 * (CSV / Excel / PDF) download exports either the checkbox selection or the whole filtered view.
 */
export function CompanyPlantTable({ rows }: { rows: CompanyPlantRow[] }) {
  const [search, setSearch] = useState('');
  const [assignment, setAssignment] = useState<AssignmentFilter>('');
  const [openCompanies, setOpenCompanies] = useState<Set<string>>(new Set());
  const [openPlant, setOpenPlant] = useState<string | null>(null);
  const [devices, setDevices] = useState<Record<string, TicketRow[]>>({});
  const [loadingPlant, setLoadingPlant] = useState<string | null>(null);
  // Multi-select for download: company ids and `plant:<id>` keys.
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const term = search.trim().toLowerCase();
  const companies = useMemo(() => {
    const groups = groupByCompany(rows);
    if (!term) return groups;
    // Match company/plant by name or id; keep a company if it or any of its plants matches.
    return groups
      .map((g) => {
        const companyMatch = g.companyName.toLowerCase().includes(term) || g.companyId.includes(term);
        const plants = companyMatch
          ? g.plants
          : g.plants.filter(
              (p) => formatPlantDisplayName(p.plantName).toLowerCase().includes(term) || p.plantId.includes(term),
            );
        return companyMatch || plants.length > 0 ? { ...g, plants } : null;
      })
      .filter((g): g is CompanyGroup => g !== null);
  }, [rows, term]);

  const toggleCompany = (companyId: string) => {
    setOpenCompanies((prev) => {
      const next = new Set(prev);
      if (next.has(companyId)) next.delete(companyId);
      else next.add(companyId);
      return next;
    });
  };

  const togglePlant = async (plantId: string) => {
    if (openPlant === plantId) {
      setOpenPlant(null);
      return;
    }
    setOpenPlant(plantId);
    setLoadingPlant(plantId);
    try {
      // Drill-down honours the same assignment-state + universal-search filters as the tree, so the
      // open-tickets panel reflects what the operator is looking for (device / vehicle level).
      const loaded = await apiTicketsList({
        plantId,
        assignmentState: assignment || undefined,
        q: term || undefined,
      });
      setDevices((prev) => ({ ...prev, [plantId]: loaded }));
    } finally {
      setLoadingPlant((p) => (p === plantId ? null : p));
    }
  };

  const toggleSelect = (key: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // Rows to export: the checkbox selection (companies expand to all their plants), else everything
  // currently visible after search. One flat row per plant.
  const exportOverview = (format: ExportFormat) => {
    const chosen: CompanyPlantRow[] = [];
    for (const g of companies) {
      for (const p of g.plants) {
        const picked = selected.size === 0 || selected.has(g.companyId) || selected.has(`plant:${p.plantId}`);
        if (picked) chosen.push(p);
      }
    }
    const headers = [
      'Company', 'Tier', 'Plant', 'Total inactive', 'Total devices', 'Critical',
      ...SLA_BUCKETS.map((b) => BUCKET_LABEL[b]),
    ];
    const body = chosen.map((r) => [
      r.companyName,
      r.companyTier,
      formatPlantDisplayName(r.plantName),
      r.totalInactive,
      r.totalDevices,
      criticalOnlyCount(r.byBucket),
      ...SLA_BUCKETS.map((b) => r.byBucket[b] ?? 0),
    ]);
    exportTable(format, 'company-plant-overview', 'Company / Plant Overview', headers, body);
  };

  const th =
    'whitespace-nowrap px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-caps';

  const bucketCells = (byBucket: Record<string, number>) =>
    SLA_BUCKETS.map((b) => {
      const count = byBucket[b] ?? 0;
      return (
        <td key={b} className="px-4 py-2.5 text-right">
          <span
            data-testid={`bucket-${b}`}
            className={cn(
              'inline-block min-w-7 rounded-full px-1.5 text-center text-xs font-semibold tabular-nums',
              count > 0 ? BUCKET_CLASS[b] : 'text-ink-muted/40',
            )}
          >
            {count}
          </span>
        </td>
      );
    });

  return (
    <section aria-labelledby="company-plant-heading" className="mb-8">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3
          id="company-plant-heading"
          className="text-[11px] font-semibold uppercase tracking-wider text-ink-caps"
        >
          Company / Plant Overview
        </h3>
        <FilterBar className="mb-0">
          <SearchInput
            aria-label="Search company, plant or ID"
            placeholder="Company, plant, ID, vehicle, device…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-60"
          />
          <FilterSelect
            aria-label="Assignment state"
            value={assignment}
            onChange={(e) => setAssignment(e.target.value as AssignmentFilter)}
          >
            <option value="">All assignment states</option>
            <option value="FORMALLY_ASSIGNED">Assigned</option>
            <option value="UNASSIGNED">Unassigned</option>
          </FilterSelect>
          <ExportMenu onExport={exportOverview} disabled={companies.length === 0} label="Download" />
        </FilterBar>
      </div>
      {selected.size > 0 && (
        <p className="mb-2 text-xs text-ink-muted">
          {selected.size} selected for download.{' '}
          <button type="button" className="underline" onClick={() => setSelected(new Set())}>
            Clear
          </button>
        </p>
      )}
      <div className="overflow-hidden rounded-card border border-line bg-surface-card shadow-sm">
        <div className="overflow-x-auto">
          <table aria-label="Company/Plant Overview" className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-line bg-surface-sunken/60">
                <th className={cn(th, 'w-8')}></th>
                <th className={th}>Company</th>
                <th className={th}>Plant</th>
                <th className={cn(th, 'text-right')}>Inactive / Total</th>
                {SLA_BUCKETS.map((b) => (
                  <th key={b} className={cn(th, 'text-right')}>
                    <span className="flex flex-col items-end leading-tight">
                      <span>{BUCKET_LABEL[b]}</span>
                      <span className="text-[10px] font-normal normal-case tracking-normal text-ink-muted tabular-nums">
                        {BUCKET_RANGE_LABEL[b]}
                      </span>
                    </span>
                  </th>
                ))}
                <th className={cn(th, 'text-right')}>Critical</th>
                <th className={cn(th, 'text-right')}>Devices</th>
              </tr>
            </thead>
            <tbody>
              {companies.length === 0 && (
                <tr>
                  <td colSpan={COLSPAN} className="p-0">
                    <EmptyState icon={<IconTruck />} message="No companies match this search." />
                  </td>
                </tr>
              )}
              {companies.map((co) => {
                const open = openCompanies.has(co.companyId);
                return (
                  <Fragment key={co.companyId}>
                    {/* Company aggregate row (collapsed by default). */}
                    <tr
                      className="cursor-pointer border-b border-line bg-surface-sunken/50 hover:bg-surface-sunken"
                      onClick={() => toggleCompany(co.companyId)}
                    >
                      <td className="px-4 py-2.5" onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          aria-label={`Select ${co.companyName}`}
                          checked={selected.has(co.companyId)}
                          onChange={() => toggleSelect(co.companyId)}
                        />
                      </td>
                      <td className="px-4 py-2.5 font-semibold text-ink-strong">
                        <span className="flex items-center gap-1.5">
                          <IconChevronRight
                            className={cn('h-4 w-4 shrink-0 text-ink-muted transition-transform', open && 'rotate-90')}
                          />
                          {co.companyName}
                          <TierBadge tier={co.companyTier} className="ml-1 align-middle" />
                          <span className="ml-1 text-xs font-normal text-ink-muted">
                            {co.plants.length} plant{co.plants.length === 1 ? '' : 's'}
                          </span>
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-ink-muted">—</td>
                      <td className="px-4 py-2.5 text-right tabular-nums text-ink">
                        {formatInactiveOfTotal(co.totalInactive, co.totalDevices)}
                      </td>
                      {bucketCells(co.byBucket)}
                      <td className="px-4 py-2.5 text-right tabular-nums font-semibold text-critical">
                        {criticalOnlyCount(co.byBucket)}
                      </td>
                      <td className="px-4 py-2.5" />
                    </tr>

                    {open &&
                      co.plants.map((p) => (
                        <Fragment key={p.plantId}>
                          <tr className="border-b border-line last:border-b-0">
                            <td className="px-4 py-2.5 pl-8" onClick={(e) => e.stopPropagation()}>
                              <input
                                type="checkbox"
                                aria-label={`Select plant ${formatPlantDisplayName(p.plantName)}`}
                                checked={selected.has(`plant:${p.plantId}`) || selected.has(co.companyId)}
                                onChange={() => toggleSelect(`plant:${p.plantId}`)}
                              />
                            </td>
                            <td className="px-4 py-2.5 text-ink-muted">—</td>
                            <td className="px-4 py-2.5 text-ink">
                              <PlantName code={p.plantName} />
                            </td>
                            <td
                              data-testid="plant-inactive-total"
                              className="px-4 py-2.5 text-right tabular-nums text-ink"
                            >
                              {formatInactiveOfTotal(p.totalInactive, p.totalDevices)}
                            </td>
                            {bucketCells(p.byBucket)}
                            <td className="px-4 py-2.5 text-right tabular-nums font-semibold text-critical">
                              {criticalOnlyCount(p.byBucket)}
                            </td>
                            <td className="px-4 py-2.5 text-right">
                              <button
                                type="button"
                                onClick={() => togglePlant(p.plantId)}
                                aria-expanded={openPlant === p.plantId}
                                className="text-xs font-medium text-brand-700 hover:underline"
                              >
                                {openPlant === p.plantId ? 'Hide devices' : 'View devices'}
                              </button>
                            </td>
                          </tr>
                          {openPlant === p.plantId && (
                            <tr>
                              <td colSpan={COLSPAN} className="bg-surface-sunken/40 p-0">
                                <div className="px-6 py-4 sm:px-10">
                                  <OpenDeviceTickets
                                    plantLabel={formatPlantDisplayName(p.plantName)}
                                    loading={loadingPlant === p.plantId}
                                    tickets={devices[p.plantId] ?? []}
                                  />
                                </div>
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      ))}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

/** The open device tickets at one plant — device, vehicle, assignment, overridden, SLA, status. */
function OpenDeviceTickets({
  plantLabel,
  loading,
  tickets,
}: {
  plantLabel: string;
  loading: boolean;
  tickets: TicketRow[];
}) {
  return (
    <div className="overflow-hidden rounded-card border border-line bg-surface-card shadow-sm">
      <div className="flex items-center justify-between gap-2 border-b border-line bg-surface-raised px-4 py-2.5">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-caps">
          Open device tickets — {plantLabel}
        </span>
        {!loading && <span className="text-xs tabular-nums text-ink-muted">{tickets.length}</span>}
      </div>
      {loading ? (
        <ul>
          {Array.from({ length: 3 }).map((_, i) => (
            <li key={`sk-${i}`} className="flex items-center justify-between gap-3 border-b border-line/70 px-4 py-2.5 last:border-b-0">
              <Skeleton className="h-4 w-28" />
              <Skeleton className="h-5 w-20" />
            </li>
          ))}
        </ul>
      ) : tickets.length === 0 ? (
        <EmptyState icon={<IconTruck />} message="No open device tickets at this plant." />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-line bg-surface-sunken/50 text-left text-[11px] uppercase tracking-wider text-ink-caps">
                <th className="px-4 py-2 font-semibold">Device</th>
                <th className="px-4 py-2 font-semibold">Vehicle No.</th>
                <th className="px-4 py-2 font-semibold">Assignment</th>
                <th className="px-4 py-2 font-semibold">SLA</th>
                <th className="px-4 py-2 font-semibold">Status</th>
              </tr>
            </thead>
            <tbody>
              {tickets.map((d) => (
                <tr key={d.ticketId} className="border-b border-line/70 last:border-b-0 hover:bg-surface-sunken/50">
                  <td className="px-4 py-2.5 font-mono tabular-nums text-ink-strong">{d.deviceId}</td>
                  <td className="px-4 py-2.5 font-mono text-xs text-ink">{d.vehicleNo ?? '—'}</td>
                  <td className="px-4 py-2.5">
                    {d.assignmentState === 'FORMALLY_ASSIGNED' ? (
                      <span className="flex flex-wrap items-center gap-1.5">
                        <Badge tone="success">Assigned</Badge>
                        {d.overridden && <Badge tone="info">Overridden</Badge>}
                        {d.assignedSeName && <span className="text-xs text-ink-muted">{d.assignedSeName}</span>}
                      </span>
                    ) : (
                      <Badge tone="warning">Unassigned</Badge>
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    <DurationBadge bucket={d.slaBucket} latestGpsDatetime={d.latestGpsDatetime} />
                  </td>
                  <td className="px-4 py-2.5">
                    <StatusPill status={d.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
