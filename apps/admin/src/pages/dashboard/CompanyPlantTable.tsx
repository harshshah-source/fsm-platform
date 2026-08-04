import { Fragment, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { CompanyPlantRow, FleetCounts } from '../../api/dashboard';
import { ColumnHeader, EmptyState, FilterSelect, SearchInput, Skeleton, TableDownloadButton, TableToolbar } from '../../components/data';
import { DurationBadge, InactiveCountLink, PlantName, StatusPill, TierBadge } from '../../components/domain';
import { Badge } from '../../components/ui';
import { IconChevronRight, IconTruck } from '../../components/ui/icons';
import { apiTicketsList, type TicketRow } from '../../api/tickets';
import type { DeviceStatusFilter } from '../../api/devices';
import { cn } from '../../lib/cn';
import { exportTable, type ExportFormat } from '../../lib/exportFile';
import { formatCount, formatPct } from '../../lib/fleetFormat';
import {
  BUCKET_LABEL,
  BUCKET_LABEL_RANGE,
  criticalOnlyCount,
  SLA_BUCKETS,
  type SlaBucket,
} from '../../lib/slaBucket';
import { formatPlantDisplayName } from '../../lib/plantNames';

/**
 * A company's roll-up of its plant rows. The counts are plain sums of the plant rows — which are
 * themselves slices of the same server aggregate the zone table and the KPI strip use — so a company
 * total, a zone total and the dashboard KPI are the same number viewed at three group-by levels.
 *
 * The two rates are re-derived here rather than averaged: averaging per-plant percentages would weight
 * a 4-device plant the same as a 4,000-device one.
 */
interface CompanyGroup extends FleetCounts {
  companyId: string;
  companyName: string;
  companyTier: string;
  plants: CompanyPlantRow[];
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
        mirroredDevices: 0,
        operationalDevices: 0,
        warehouseDevices: 0,
        inactiveOperational: 0,
        healthyOperational: 0,
        inactivePct: null,
        fleetHealthPct: null,
        byBucket: {},
      };
      byCompany.set(r.companyId, g);
    }
    g.plants.push(r);
    g.mirroredDevices += r.mirroredDevices;
    g.operationalDevices += r.operationalDevices;
    g.warehouseDevices += r.warehouseDevices;
    g.inactiveOperational += r.inactiveOperational;
    g.healthyOperational += r.healthyOperational;
    for (const b of SLA_BUCKETS) g.byBucket[b] = (g.byBucket[b] ?? 0) + (r.byBucket[b] ?? 0);
  }
  for (const g of byCompany.values()) {
    const op = g.operationalDevices;
    g.inactivePct = op > 0 ? Math.round((g.inactiveOperational / op) * 1000) / 10 : null;
    g.fleetHealthPct = op > 0 ? Math.round((g.healthyOperational / op) * 1000) / 10 : null;
  }
  return [...byCompany.values()];
}

// SLA buckets ordered by increasing inactivity (4–8Hr … 7d+) so the per-bucket columns read left→right
// from least to most severe. `SLA_BUCKETS` is most-severe-first, so reverse a copy.
const SLA_BUCKETS_ASC = [...SLA_BUCKETS].reverse();

/**
 * Which SLA-bucket columns to render for the active device-status scope.
 *
 * Under `ACTIVE` every bucket is zero *by definition* — a device with an SLA bucket is inactive — so
 * the eight columns carry no information and are dropped. That is a different judgement from hiding a
 * zero *row*: a plant with no inactive devices is a real result (it is the one performing well) and
 * always stays, sorted to the bottom. A column that cannot be non-zero is not a result.
 */
const bucketsFor = (scope: DeviceStatusFilter) => (scope === 'ACTIVE' ? [] : SLA_BUCKETS_ASC);

// S.No. + company + tier + plants + plant + operational + inactive/operational + healthy + warehouse
// + inactive % + fleet health % + one column per SLA bucket + fleet uptime %.
const colspanFor = (bucketCount: number) => 12 + bucketCount;

/** Fleet Uptime % for one plant — one decimal, or a dash when the monthly summary has no value yet
 *  (the report is empty until an OH recompute runs — Issue 135). */
function fmtUptime(pct: number | null | undefined): string {
  return typeof pct === 'number' && Number.isFinite(pct) ? `${pct.toFixed(1)}%` : '—';
}

type AssignmentFilter = '' | 'FORMALLY_ASSIGNED' | 'UNASSIGNED';
/** Sort the tree by aggregate inactivity — companies (and their plants) ordered most/least inactive. */
type SortOrder = '' | 'INACTIVE_DESC' | 'INACTIVE_ASC';

/**
 * The per-bucket SLA columns: one column per bucket, header = its inactivity range (e.g. `24–48Hr`,
 * `7d+`), cell = the number of devices in that band. Rendered as `<th>`/`<td>` fragments so they sit
 * directly in the table row. Ordered least→most severe (`SLA_BUCKETS_ASC`); a zero cell reads as a muted
 * dash so the populated bands stand out. Each count cell keeps its `bucket-<B>` test id.
 */
function BucketHeaderCells({ className, buckets }: { className: string; buckets: SlaBucket[] }) {
  return (
    <>
      {buckets.map((b) => (
        <th key={b} className={className} title={BUCKET_LABEL_RANGE[b]}>
          {BUCKET_LABEL[b]}
        </th>
      ))}
    </>
  );
}

function BucketCountCells({
  byBucket,
  className,
  scope,
  buckets,
}: {
  byBucket: Record<string, number>;
  className: string;
  /** Device Detail query params identifying the entity, e.g. `{ companyId }` or `{ plantId }`. */
  scope: Record<string, string>;
  buckets: SlaBucket[];
}) {
  return (
    <>
      {buckets.map((b) => {
        const n = byBucket[b] ?? 0;
        // A non-zero count deep-links into the Device Detail list, pre-filtered to exactly those devices:
        // the entity (company/plant) + this SLA bucket + INACTIVE — the same contract as InactiveCountLink.
        // `stopPropagation` keeps the row's expand/toggle handler from also firing on the count click.
        const to = `/reports/device?${new URLSearchParams({ ...scope, status: 'INACTIVE', bucket: b }).toString()}`;
        return (
          <td key={b} data-testid={`bucket-${b}`} className={className}>
            {n > 0 ? (
              <Link
                to={to}
                onClick={(e) => e.stopPropagation()}
                title={`View ${BUCKET_LABEL_RANGE[b]} inactive devices`}
                className="font-semibold text-link underline-offset-2 hover:underline"
              >
                {n}
              </Link>
            ) : (
              <span className="text-ink-muted/40">—</span>
            )}
          </td>
        );
      })}
    </>
  );
}

/**
 * Company/Plant Overview (Issue 06 AC#3 · FE-06 · Issue 122/122b rework). Company is its own column
 * and the table opens collapsed to one aggregate row per company; expanding a company reveals its
 * plants, and a plant drills down to its open device tickets (device · vehicle · assignment ·
 * overridden · SLA). The SLA distribution renders as one column per bucket — header = the inactivity
 * range (`24–48Hr`, `7d+`, …), cell = the device count in that band (`BucketHeaderCells` /
 * `BucketCountCells`) — so the table scrolls horizontally when the bucket columns overflow. A universal
 * search + assignment-state filter scope the tree and the drill-down; the download exports the whole
 * filtered view as CSV / Excel / PDF.
 */
export function CompanyPlantTable({
  rows,
  plantUptime,
  statusScope = 'ALL',
}: {
  rows: CompanyPlantRow[];
  /** Per-plant current-month Fleet Uptime %, keyed by plantId (Issue 135); `—` shown when absent. */
  plantUptime?: Map<string, number>;
  /**
   * The active device-status filter when this table is embedded in the zone drill-down. It changes
   * the DEFAULT ordering (rows with nothing in the filtered population sort last and are dimmed,
   * never dropped) and drops the SLA columns under `ACTIVE`. `ALL` is the dashboard's behaviour and
   * leaves everything exactly as it was.
   */
  statusScope?: DeviceStatusFilter;
}) {
  const buckets = bucketsFor(statusScope);
  const COLSPAN = colspanFor(buckets.length);
  const [search, setSearch] = useState('');
  const [assignment, setAssignment] = useState<AssignmentFilter>('');
  const [sortOrder, setSortOrder] = useState<SortOrder>('');
  const [openCompanies, setOpenCompanies] = useState<Set<string>>(new Set());
  const [openPlant, setOpenPlant] = useState<string | null>(null);
  const [devices, setDevices] = useState<Record<string, TicketRow[]>>({});
  const [loadingPlant, setLoadingPlant] = useState<string | null>(null);

  const term = search.trim().toLowerCase();

  // The search box promises "ID, vehicle, device" (placeholder + aria-label), but `CompanyPlantRow`
  // only carries company/plant identity — it has no device/vehicle fields to match against. Bug fix:
  // fall back to the same universal ticket search (`apiTicketsList({ q })`) the plant drill-down
  // already uses, so a device id or vehicle number resolves to the plant(s) it lives at. Debounced so
  // typing doesn't fire a request per keystroke; cleared immediately when the search is emptied.
  const [deviceMatchPlantIds, setDeviceMatchPlantIds] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!term) {
      setDeviceMatchPlantIds(new Set());
      return;
    }
    let alive = true;
    const t = setTimeout(() => {
      apiTicketsList({ q: term })
        .then((tickets) => {
          if (alive) setDeviceMatchPlantIds(new Set(tickets.map((tk) => tk.plantId)));
        })
        .catch(() => {
          if (alive) setDeviceMatchPlantIds(new Set());
        });
    }, 300);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [term]);

  const companies = useMemo(() => {
    const groups = groupByCompany(rows);
    const filtered = !term
      ? groups
      : // Match company/plant by name or id, or a plant holding a device/vehicle match; keep a company
        // if it or any of its plants matches.
        groups
          .map((g) => {
            const companyMatch = g.companyName.toLowerCase().includes(term) || g.companyId.includes(term);
            const plants = companyMatch
              ? g.plants
              : g.plants.filter(
                  (p) =>
                    formatPlantDisplayName(p.plantName).toLowerCase().includes(term) ||
                    p.plantId.includes(term) ||
                    deviceMatchPlantIds.has(p.plantId),
                );
            return companyMatch || plants.length > 0 ? { ...g, plants } : null;
          })
          .filter((g): g is CompanyGroup => g !== null);

    if (!sortOrder) {
      // No explicit sort. On the dashboard (`ALL`) that means source order, unchanged. Inside the
      // zone drill-down it means "most of what I am filtered to, first" — and, crucially, entities
      // with NONE of it sort to the BOTTOM rather than disappearing: a plant with zero inactive
      // devices is the one performing well, and an operator seeing 8 of 20 plants would otherwise be
      // unable to tell the healthy 12 from 12 that are simply missing from the data.
      if (statusScope === 'ALL') return filtered;
      const weight = (e: FleetCounts) =>
        statusScope === 'ACTIVE' ? e.healthyOperational : e.inactiveOperational;
      return filtered
        .map((g) => ({ ...g, plants: [...g.plants].sort((a, b) => weight(b) - weight(a)) }))
        .sort((a, b) => weight(b) - weight(a));
    }
    // Order companies by aggregate inactive count, and each company's plants the same way, so the
    // most (or least) inactive company floats to the top with its worst plants first.
    const dir = sortOrder === 'INACTIVE_DESC' ? -1 : 1;
    return filtered
      .map((g) => ({ ...g, plants: [...g.plants].sort((a, b) => (a.inactiveOperational - b.inactiveOperational) * dir) }))
      .sort((a, b) => (a.inactiveOperational - b.inactiveOperational) * dir);
  }, [rows, term, sortOrder, deviceMatchPlantIds, statusScope]);

  /** True when this entity contributes nothing to the population the page is currently filtered to. */
  const isEmptyForScope = (e: FleetCounts) =>
    statusScope === 'INACTIVE'
      ? e.inactiveOperational === 0
      : statusScope === 'ACTIVE'
        ? e.healthyOperational === 0
        : false;

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

  // Download the current filtered view — one flat row per plant (Issue 135: + Plants + Fleet Uptime %).
  const exportOverview = (format: ExportFormat) => {
    const plantsByCompany = new Map(companies.map((g) => [g.companyId, g.plants.length]));
    const chosen = companies.flatMap((g) => g.plants);
    const headers = [
      'S.No.', 'Company', 'Tier', 'Plants', 'Plant', 'Operational devices', 'Inactive operational',
      'Healthy devices', 'Warehouse devices', 'Inactive %', 'Fleet Health %',
      'Fleet Uptime %', 'Critical', ...SLA_BUCKETS.map((b) => BUCKET_LABEL[b]),
    ];
    const body = chosen.map((r, i) => [
      i + 1,
      r.companyName,
      r.companyTier,
      plantsByCompany.get(r.companyId) ?? '',
      formatPlantDisplayName(r.plantName),
      r.operationalDevices,
      r.inactiveOperational,
      r.healthyOperational,
      r.warehouseDevices,
      formatPct(r.inactivePct),
      formatPct(r.fleetHealthPct),
      fmtUptime(plantUptime?.get(r.plantId)),
      criticalOnlyCount(r.byBucket),
      ...SLA_BUCKETS.map((b) => r.byBucket[b] ?? 0),
    ]);
    exportTable(format, 'company-plant-overview', 'Company / Plant Overview', headers, body);
  };

  // Fixed layout (`table-fixed` + colgroup below) keeps the whole table at 100% of the card width so the
  // 8 SLA-bucket columns never force a horizontal scroll; headers/cells stay compact and truncate/wrap.
  const th = 'px-2.5 py-2.5 text-left text-[11px] font-bold uppercase tracking-wide text-white';
  // Tighter horizontal padding for the narrow operational-breakdown columns (Operational / Inactive /
  // Healthy / Warehouse / Inactive % / Health %) — this table packs 12+ columns into the viewport, and
  // the standard `th` padding alone left too little room for a label + its info icon to sit without
  // wrapping into each other.
  const thDense = 'px-1.5';
  const thBucket = 'px-1 py-2.5 text-right text-[10px] font-bold uppercase tracking-tight text-white';
  const td = 'px-2.5 py-2.5';
  const tdBucket = 'px-1 py-2.5 text-right text-xs tabular-nums text-ink';

  return (
    <section aria-labelledby="company-plant-heading" className="mb-6">
      <h3 id="company-plant-heading" className="sr-only">
        Company / Plant Overview
      </h3>
      <div className="overflow-hidden rounded-card border border-line bg-surface-card shadow-sm">
        {/* Label, filters and download ride inside the table's card (see `TableToolbar`). */}
        <TableToolbar
          title="Company / Plant Overview"
          trailing={
            <TableDownloadButton
              ariaLabel="Company/Plant Overview"
              disabled={companies.length === 0}
              onSelectFormat={exportOverview}
            />
          }
        >
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
          <FilterSelect
            aria-label="Sort by inactivity"
            value={sortOrder}
            onChange={(e) => setSortOrder(e.target.value as SortOrder)}
          >
            <option value="">Sort: default order</option>
            <option value="INACTIVE_DESC">Most inactive first</option>
            <option value="INACTIVE_ASC">Least inactive first</option>
          </FilterSelect>
        </TableToolbar>

        {/* The fixed colgroup's percentages are budgeted to total 100% WITH the eight SLA columns. With
            them dropped (ACTIVE scope) that budget under-fills and `table-fixed` leaves a dead gutter,
            so the table falls back to auto layout — same columns, redistributed. */}
        <table
          aria-label="Company/Plant Overview"
          className={cn('w-full border-collapse text-sm', buckets.length > 0 && 'table-fixed')}
        >
          {buckets.length > 0 && (
          <colgroup>
            {/* Leading 3.5rem S.No. column (#160) — the percentage columns below are shaved down from
                their pre-#160 total (100%) to leave it room. */}
            <col style={{ width: '3.5rem' }} />
            <col style={{ width: '11%' }} />
            <col style={{ width: '5%' }} />
            <col style={{ width: '4%' }} />
            <col style={{ width: '7%' }} />
            <col style={{ width: '7%' }} />
            <col style={{ width: '6%' }} />
            <col style={{ width: '5%' }} />
            <col style={{ width: '7%' }} />
            <col style={{ width: '5%' }} />
            <col style={{ width: '5%' }} />
            {buckets.map((b) => (
              <col key={b} style={{ width: '4%' }} />
            ))}
            <col style={{ width: '6%' }} />
          </colgroup>
          )}
          <thead>
            <tr className="border-b border-chrome-700 bg-chrome-900">
              <th className={cn(th, 'text-right')}>S.No.</th>
              <th className={th}>Company</th>
              <th className={th}>Tier</th>
              <th className={cn(th, 'text-right')}>Plants</th>
              <th className={th}>Plant</th>
              <th className={cn(th, thDense, 'text-right')}>
                <ColumnHeader label="Operational" kpi="operationalDevices" stacked />
              </th>
              {/* Renamed from "Inactive / Total": the denominator is the operational fleet, so a
                  warehouse-heavy company no longer reads as healthier than it is. "Inactive" alone
                  reads unambiguously beside the "Operational" column it sits next to. */}
              <th className={cn(th, thDense, 'text-right')}>
                <ColumnHeader label="Inactive" kpi="inactiveOperational" stacked />
              </th>
              <th className={cn(th, thDense, 'text-right')}>
                <ColumnHeader label="Healthy" kpi="healthyOperational" stacked />
              </th>
              <th className={cn(th, thDense, 'text-right')}>
                <ColumnHeader label="Warehouse" kpi="warehouseDevices" stacked />
              </th>
              <th className={cn(th, thDense, 'text-right')}>
                <ColumnHeader label="Inactive %" kpi="inactivePct" stacked />
              </th>
              <th className={cn(th, thDense, 'text-right')}>
                <ColumnHeader label="Health %" kpi="fleetHealthPct" stacked />
              </th>
              <BucketHeaderCells className={thBucket} buckets={buckets} />
              <th className={cn(th, thDense, 'text-right')}>Uptime %</th>
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
            {companies.map((co, index) => {
              // Auto-expand while a search is active — a matched company staying collapsed by default
              // hid the very plant/device the search found, making a working search look broken.
              const open = term !== '' || openCompanies.has(co.companyId);
              return (
                <Fragment key={co.companyId}>
                  {/* Company aggregate row (collapsed by default). */}
                  <tr
                    // Dimmed, not dropped: this company has nothing in the filtered population, which
                    // is itself the finding. It keeps its row, its numbers and its drill-down.
                    className={cn(
                      'cursor-pointer border-b border-line bg-surface-sunken/50 hover:bg-surface-sunken',
                      isEmptyForScope(co) && 'opacity-60',
                    )}
                    data-testid={isEmptyForScope(co) ? 'company-row-empty-for-scope' : undefined}
                    onClick={() => toggleCompany(co.companyId)}
                  >
                    <td className={cn(td, 'text-right tabular-nums text-ink')}>{index + 1}</td>
                    <td className={cn(td, 'font-semibold text-ink-strong')}>
                      <span className="flex min-w-0 items-center gap-1.5">
                        <IconChevronRight
                          className={cn('h-4 w-4 shrink-0 text-ink-muted transition-transform', open && 'rotate-90')}
                        />
                        <span className="min-w-0 truncate" title={co.companyName}>{co.companyName}</span>
                      </span>
                    </td>
                    <td className={td}>
                      <TierBadge tier={co.companyTier} />
                    </td>
                    <td className={cn(td, 'text-right tabular-nums text-ink')}>{co.plants.length}</td>
                    <td className={cn(td, 'text-ink-muted')}>—</td>
                    <td data-testid="company-operational" className={cn(td, 'text-right tabular-nums text-ink')}>
                      {formatCount(co.operationalDevices)}
                    </td>
                    <td className={cn(td, 'text-right tabular-nums text-ink')}>
                      <InactiveCountLink
                        inactive={co.inactiveOperational}
                        operational={co.operationalDevices}
                        scope={{ companyId: co.companyId }}
                      />
                    </td>
                    <td data-testid="company-healthy" className={cn(td, 'text-right tabular-nums text-ink')}>
                      {formatCount(co.healthyOperational)}
                    </td>
                    {/* Muted: warehouse stock is not a performance signal and sits outside every rate. */}
                    <td data-testid="company-warehouse" className={cn(td, 'text-right tabular-nums text-ink-muted')}>
                      {formatCount(co.warehouseDevices)}
                    </td>
                    <td data-testid="company-inactive-pct" className={cn(td, 'text-right tabular-nums font-semibold text-ink')}>
                      {formatPct(co.inactivePct)}
                    </td>
                    <td data-testid="company-health-pct" className={cn(td, 'text-right tabular-nums font-semibold text-ink')}>
                      {formatPct(co.fleetHealthPct)}
                    </td>
                    <BucketCountCells byBucket={co.byBucket} className={tdBucket} scope={{ companyId: co.companyId }} buckets={buckets} />
                    <td className={td} />
                  </tr>

                  {/* Expanding a company opens its plants as their OWN table (styled like the Open device
                      tickets panel) inside a full-width cell — not as interleaved rows in this table. */}
                  {open && (
                    <tr>
                      <td colSpan={COLSPAN} className="bg-surface-sunken/40 p-0">
                        <div className="px-2 py-4 sm:px-4">
                          <CompanyPlants
                            company={co}
                            plantUptime={plantUptime}
                            openPlant={openPlant}
                            loadingPlant={loadingPlant}
                            devices={devices}
                            onTogglePlant={togglePlant}
                            buckets={buckets}
                            isEmptyForScope={isEmptyForScope}
                          />
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/**
 * One company's plants as their own bordered table (Issue 135 rework) — the same panel treatment as the
 * plant-level "Open device tickets" sub-table, opened when a company row is expanded instead of splicing
 * plant rows into the parent overview table. Each plant row is itself the toggle for its device
 * sub-table (no separate "View devices" button); the fetch/cache of a plant's tickets stays owned by the
 * parent (`onTogglePlant` / `devices` / `loadingPlant`) so only one plant loads at a time app-wide.
 */
function CompanyPlants({
  company,
  plantUptime,
  openPlant,
  loadingPlant,
  devices,
  onTogglePlant,
  buckets,
  isEmptyForScope,
}: {
  company: CompanyGroup;
  plantUptime?: Map<string, number>;
  openPlant: string | null;
  loadingPlant: string | null;
  devices: Record<string, TicketRow[]>;
  onTogglePlant: (plantId: string) => void | Promise<void>;
  /** SLA columns to render — empty under an ACTIVE-only scope, where every band is zero by definition. */
  buckets: SlaBucket[];
  /** Marks a plant that contributes nothing to the filtered population: dimmed, kept, sorted last. */
  isEmptyForScope: (e: FleetCounts) => boolean;
}) {
  const cellPad = 'px-2 py-1.5';
  const th = `${cellPad} font-bold`;
  const thBucket = 'px-1 py-1.5 text-right text-[10px] font-bold';
  const tdBucket = 'px-1 py-1.5 text-right text-xs tabular-nums text-ink';
  // The plant sub-table's expansion cell spans S.No. · Plant · Operational · Inactive Operational ·
  // Healthy · Warehouse · Inactive % · Fleet Health % · the SLA-bucket columns · Uptime.
  const PLANT_COLSPAN = 9 + buckets.length;

  // Own download, restricted to this company's plants — S.No. re-numbers from 1 (AC-20: sub-tables
  // number independently).
  const exportPlants = (format: ExportFormat) => {
    const headers = [
      'S.No.', 'Plant', 'Operational devices', 'Inactive operational', 'Healthy devices',
      'Warehouse devices', 'Inactive %', 'Fleet Health %', 'Fleet Uptime %',
      ...SLA_BUCKETS_ASC.map((b) => BUCKET_LABEL[b]),
    ];
    const body = company.plants.map((p, i) => [
      i + 1,
      formatPlantDisplayName(p.plantName),
      p.operationalDevices,
      p.inactiveOperational,
      p.healthyOperational,
      p.warehouseDevices,
      formatPct(p.inactivePct),
      formatPct(p.fleetHealthPct),
      fmtUptime(plantUptime?.get(p.plantId)),
      ...SLA_BUCKETS_ASC.map((b) => p.byBucket[b] ?? 0),
    ]);
    exportTable(format, `plants-${company.companyName}`, `Plants — ${company.companyName}`, headers, body);
  };

  return (
    <div className="overflow-hidden rounded-card border border-line bg-surface-card shadow-sm">
      <div className="flex items-center justify-between gap-2 border-b border-line bg-surface-raised px-3 py-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-caps">
          Plants — {company.companyName}
        </span>
        <TableDownloadButton
          ariaLabel={`Plants for ${company.companyName}`}
          disabled={company.plants.length === 0}
          onSelectFormat={exportPlants}
        />
      </div>
      {/* Same fixed-vs-auto rule as the parent table (see there). */}
      <table
        aria-label={`Plants for ${company.companyName}`}
        className={cn('w-full border-collapse text-sm', buckets.length > 0 && 'table-fixed')}
      >
        {buckets.length > 0 && (
        <colgroup>
          <col style={{ width: '3.5rem' }} />
          <col style={{ width: '14%' }} />
          <col style={{ width: '7%' }} />
          <col style={{ width: '9%' }} />
          <col style={{ width: '6%' }} />
          <col style={{ width: '7%' }} />
          <col style={{ width: '6%' }} />
          <col style={{ width: '7%' }} />
          {buckets.map((b) => (
            <col key={b} style={{ width: '4%' }} />
          ))}
          <col style={{ width: '6%' }} />
        </colgroup>
        )}
        <thead>
          <tr className="border-b border-chrome-700 bg-chrome-900 text-left text-[11px] uppercase tracking-wider text-white">
            <th className={cn(th, 'text-right')}>S.No.</th>
            <th className={th}>Plant</th>
            <th className={cn(th, 'text-right')}>
              <ColumnHeader label="Operational" kpi="operationalDevices" stacked />
            </th>
            <th className={cn(th, 'text-right')}>
              <ColumnHeader label="Inactive" kpi="inactiveOperational" stacked />
            </th>
            <th className={cn(th, 'text-right')}>
              <ColumnHeader label="Healthy" kpi="healthyOperational" stacked />
            </th>
            <th className={cn(th, 'text-right')}>
              <ColumnHeader label="Warehouse" kpi="warehouseDevices" stacked />
            </th>
            <th className={cn(th, 'text-right')}>
              <ColumnHeader label="Inactive %" kpi="inactivePct" stacked />
            </th>
            <th className={cn(th, 'text-right')}>
              <ColumnHeader label="Health %" kpi="fleetHealthPct" stacked />
            </th>
            <BucketHeaderCells className={thBucket} buckets={buckets} />
            <th className={cn(th, 'text-right')}>Uptime %</th>
          </tr>
        </thead>
        <tbody>
          {company.plants.map((p, index) => (
            <Fragment key={p.plantId}>
              <tr
                onClick={() => onTogglePlant(p.plantId)}
                tabIndex={0}
                aria-expanded={openPlant === p.plantId}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    void onTogglePlant(p.plantId);
                  }
                }}
                data-testid={isEmptyForScope(p) ? 'plant-row-empty-for-scope' : undefined}
                className={cn(
                  'cursor-pointer border-b border-line/70 last:border-b-0 hover:bg-surface-sunken/50 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand-600/50',
                  // Kept and still drillable — just visually recessive, because it has nothing in the
                  // population the page is filtered to. Absence and zero must not look the same.
                  isEmptyForScope(p) && 'opacity-60',
                )}
              >
                <td className={`${cellPad} text-right tabular-nums text-ink`}>{index + 1}</td>
                <td className={`${cellPad} truncate text-ink`} title={formatPlantDisplayName(p.plantName)}>
                  <PlantName code={p.plantName} />
                </td>
                <td data-testid="plant-operational" className={`${cellPad} text-right tabular-nums text-ink`}>
                  {formatCount(p.operationalDevices)}
                </td>
                <td data-testid="plant-inactive-total" className={`${cellPad} text-right tabular-nums text-ink`}>
                  <InactiveCountLink
                    inactive={p.inactiveOperational}
                    operational={p.operationalDevices}
                    scope={{ plantId: p.plantId }}
                  />
                </td>
                <td data-testid="plant-healthy" className={`${cellPad} text-right tabular-nums text-ink`}>
                  {formatCount(p.healthyOperational)}
                </td>
                <td data-testid="plant-warehouse" className={`${cellPad} text-right tabular-nums text-ink-muted`}>
                  {formatCount(p.warehouseDevices)}
                </td>
                <td data-testid="plant-inactive-pct" className={`${cellPad} text-right tabular-nums font-semibold text-ink`}>
                  {formatPct(p.inactivePct)}
                </td>
                <td data-testid="plant-health-pct" className={`${cellPad} text-right tabular-nums font-semibold text-ink`}>
                  {formatPct(p.fleetHealthPct)}
                </td>
                <BucketCountCells byBucket={p.byBucket} className={tdBucket} scope={{ plantId: p.plantId }} buckets={buckets} />
                <td data-testid="plant-fleet-uptime" className={`${cellPad} text-right tabular-nums text-ink-muted`}>
                  {fmtUptime(plantUptime?.get(p.plantId))}
                </td>
              </tr>
              {openPlant === p.plantId && (
                <tr>
                  <td colSpan={PLANT_COLSPAN} className="bg-surface-sunken/40 p-0">
                    <div className="px-4 py-3 sm:px-6">
                      <OpenDeviceTickets
                        plantLabel={formatPlantDisplayName(p.plantName)}
                        loading={loadingPlant === p.plantId}
                        tickets={devices[p.plantId] ?? []}
                        operationalDevices={p.operationalDevices}
                      />
                    </div>
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}

type TicketAssignmentFilter = '' | 'FORMALLY_ASSIGNED' | 'UNASSIGNED';
type TicketSort = 'SLA_DESC' | 'SLA_ASC' | 'DEVICE';

// SLA severity rank for the sub-table sort — `SLA_BUCKETS` is ordered most-severe-first, so a lower
// index is more severe; a null/unknown bucket sorts last.
const bucketSeverityRank = (bucket: string | null): number => {
  const i = (SLA_BUCKETS as readonly string[]).indexOf(bucket ?? '');
  return i === -1 ? SLA_BUCKETS.length : i;
};

/**
 * The open device tickets at one plant — device, vehicle, transporter, assignment, batch, SLA, status.
 * Carries its own plant-level summary (tickets created / SE-assigned / total devices / unassigned) and
 * its own compact download + sort + assignment filter, all operating on the already-loaded ticket set
 * (no extra fetch). Rows drill into the ticket detail; the batch link and any inner control stop the
 * row-click so they don't also open the drawer.
 */
function OpenDeviceTickets({
  plantLabel,
  loading,
  tickets,
  operationalDevices,
}: {
  plantLabel: string;
  loading: boolean;
  tickets: TicketRow[];
  /** The plant's OPERATIONAL device count — the population these tickets are raised against. */
  operationalDevices: number | null | undefined;
}) {
  const navigate = useNavigate();
  const [filter, setFilter] = useState<TicketAssignmentFilter>('');
  const [sort, setSort] = useState<TicketSort>('SLA_DESC');

  // A row click drills into that device's ticket detail (opens the Detail Drawer on the Tickets page).
  const openTicket = (ticketId: string) => navigate(`/tickets/${ticketId}`);

  // Plant-level totals are computed from the FULL ticket set (not the client filter) so the summary
  // describes the plant regardless of what the operator is currently filtering to.
  const assignedCount = tickets.filter((t) => t.assignmentState === 'FORMALLY_ASSIGNED').length;
  const unassignedCount = tickets.filter((t) => t.assignmentState === 'UNASSIGNED').length;
  const summary: Array<{ key: string; label: string; value: number | string }> = [
    { key: 'tickets', label: 'Tickets created', value: tickets.length },
    { key: 'assigned', label: 'SE assigned', value: assignedCount },
    { key: 'devices', label: 'Operational devices', value: operationalDevices ?? '—' },
    { key: 'unassigned', label: 'Unassigned', value: unassignedCount },
  ];

  const view = useMemo(() => {
    const list = filter ? tickets.filter((t) => t.assignmentState === filter) : [...tickets];
    list.sort((a, b) => {
      if (sort === 'DEVICE') return a.deviceId.localeCompare(b.deviceId);
      const d = bucketSeverityRank(a.slaBucket) - bucketSeverityRank(b.slaBucket);
      return sort === 'SLA_ASC' ? -d : d;
    });
    return list;
  }, [tickets, filter, sort]);

  const exportTickets = (format: ExportFormat) => {
    const headers = [
      'S.No.', 'Device', 'Vehicle No.', 'Zone', 'Company', 'Plant', 'Transporter', 'Assignment', 'SE', 'Batch', 'SLA',
      'Status',
    ];
    const body = view.map((d, i) => [
      i + 1,
      d.deviceId,
      d.vehicleNo ?? '',
      d.zoneName ?? '',
      d.companyName ?? '',
      d.plantName ? formatPlantDisplayName(d.plantName) : '',
      d.transporterName ?? '',
      d.assignmentState === 'FORMALLY_ASSIGNED' ? 'Assigned' : 'Unassigned',
      d.assignedSeName ?? '',
      d.batchId ? `Batch #${d.batchId}` : '',
      d.slaBucket ? BUCKET_LABEL[d.slaBucket as SlaBucket] ?? d.slaBucket : '',
      d.status,
    ]);
    exportTable(format, `open-device-tickets-${plantLabel}`, `Open device tickets — ${plantLabel}`, headers, body);
  };

  // Compact spacing throughout the drill-down (`px-3 py-1.5`) so the plant's tickets read as a dense
  // secondary panel rather than a second full-height table.
  const cellPad = 'px-3 py-1.5';
  const th = `${cellPad} font-bold`;

  return (
    <div className="overflow-hidden rounded-card border border-line bg-surface-card shadow-sm">
      <div className="border-b border-line bg-surface-raised px-3 py-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-caps">
            Open device tickets — {plantLabel}
          </span>
          {!loading && tickets.length > 0 && (
            <span className="inline-flex flex-wrap items-center gap-1.5">
              <FilterSelect
                aria-label="Filter tickets by assignment"
                value={filter}
                onChange={(e) => setFilter(e.target.value as TicketAssignmentFilter)}
                className="h-8 text-xs"
              >
                <option value="">All assignments</option>
                <option value="FORMALLY_ASSIGNED">Assigned to SE</option>
                <option value="UNASSIGNED">Not assigned</option>
              </FilterSelect>
              <FilterSelect
                aria-label="Sort tickets"
                value={sort}
                onChange={(e) => setSort(e.target.value as TicketSort)}
                className="h-8 text-xs"
              >
                <option value="SLA_DESC">SLA: most severe</option>
                <option value="SLA_ASC">SLA: least severe</option>
                <option value="DEVICE">Device A–Z</option>
              </FilterSelect>
              <TableDownloadButton
                ariaLabel={`Open device tickets — ${plantLabel}`}
                disabled={view.length === 0}
                onSelectFormat={exportTickets}
              />
            </span>
          )}
        </div>
        {/* Plant-level ticket summary (Tickets created · SE assigned · Total devices · Unassigned). */}
        {!loading && tickets.length > 0 && (
          <div className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-1">
            {summary.map((s) => (
              <span
                key={s.key}
                data-testid={`plant-summary-${s.key}`}
                className="flex items-baseline gap-1.5"
              >
                <span className="text-base font-bold tabular-nums text-ink-strong">{s.value}</span>
                <span className="text-[11px] uppercase tracking-wide text-ink-caps">{s.label}</span>
              </span>
            ))}
          </div>
        )}
      </div>
      {loading ? (
        <ul>
          {Array.from({ length: 3 }).map((_, i) => (
            <li key={`sk-${i}`} className="flex items-center justify-between gap-3 border-b border-line/70 px-3 py-1.5 last:border-b-0">
              <Skeleton className="h-4 w-28" />
              <Skeleton className="h-5 w-20" />
            </li>
          ))}
        </ul>
      ) : tickets.length === 0 ? (
        <EmptyState icon={<IconTruck />} message="No open device tickets at this plant." />
      ) : view.length === 0 ? (
        <EmptyState icon={<IconTruck />} message="No tickets match this filter." />
      ) : (
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-chrome-700 bg-chrome-900 text-left text-[11px] uppercase tracking-wider text-white">
              <th className={cn(th, 'text-right')}>S.No.</th>
              <th className={th}>Device</th>
              <th className={th}>Vehicle No.</th>
              <th className={th}>Zone</th>
              <th className={th}>Company</th>
              <th className={th}>Plant</th>
              <th className={th}>Transporter</th>
              <th className={th}>Assignment</th>
              <th className={th}>Batch</th>
              <th className={th}>SLA</th>
              <th className={th}>Status</th>
            </tr>
          </thead>
          <tbody>
            {view.map((d, index) => (
              <tr
                key={d.ticketId}
                onClick={() => openTicket(d.ticketId)}
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    openTicket(d.ticketId);
                  }
                }}
                className="cursor-pointer border-b border-line/70 last:border-b-0 hover:bg-surface-sunken/50 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand-600/50"
              >
                <td className={`${cellPad} text-right tabular-nums text-ink`}>{index + 1}</td>
                {/* For some companies AutoPlant's master sends the vehicle registration AS the device id
                    (verified against ap source 2026-07-14 — 1,950 devices, mostly Vasavadatta /
                    Saurashtra / Deepak). Not an FSM bug; flag it so operators aren't confused. */}
                <td
                  className={`${cellPad} font-mono tabular-nums text-ink-strong`}
                  title={
                    d.vehicleNo && d.deviceId === d.vehicleNo
                      ? 'AutoPlant source data uses the vehicle number as this device\'s ID'
                      : undefined
                  }
                >
                  {d.deviceId}
                </td>
                <td className={`${cellPad} font-mono text-xs text-ink`}>{d.vehicleNo ?? '—'}</td>
                <td className={`${cellPad} text-xs text-ink`}>{d.zoneName ?? '—'}</td>
                <td className={`${cellPad} text-xs text-ink`}>{d.companyName ?? '—'}</td>
                <td className={`${cellPad} text-xs text-ink`}>
                  {d.plantName ? formatPlantDisplayName(d.plantName) : '—'}
                </td>
                <td className={`${cellPad} text-xs text-ink`}>{d.transporterName ?? '—'}</td>
                <td className={cellPad}>
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
                {/* A batched ticket links to its batch by batch id — never via the run, which most
                    batches don't have. The link stops row-click propagation so it doesn't also open
                    the ticket drawer. Only a ticket with no batch at all shows the dash. */}
                <td className={cellPad}>
                  {d.batchId ? (
                    <Link
                      to={`/batches/${d.batchId}`}
                      onClick={(e) => e.stopPropagation()}
                      className="whitespace-nowrap text-xs font-medium text-link hover:underline"
                    >
                      Batch #{d.batchId} →
                    </Link>
                  ) : (
                    <span className="text-ink-muted">—</span>
                  )}
                </td>
                <td className={cellPad}>
                  <DurationBadge bucket={d.slaBucket} latestGpsDatetime={d.latestGpsDatetime} />
                </td>
                <td className={cellPad}>
                  <StatusPill status={d.status} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
