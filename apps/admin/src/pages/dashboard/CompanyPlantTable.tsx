import { Fragment, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { CompanyPlantRow } from '../../api/dashboard';
import { EmptyState, ExportMenu, FilterBar, FilterSelect, SearchInput, Skeleton } from '../../components/data';
import { DurationBadge, PlantName, StatusPill, TierBadge } from '../../components/domain';
import { Badge } from '../../components/ui';
import { IconChevronRight, IconTruck } from '../../components/ui/icons';
import { apiTicketsList, type TicketRow } from '../../api/tickets';
import { cn } from '../../lib/cn';
import { exportTable, type ExportFormat } from '../../lib/exportFile';
import {
  BUCKET_CLASS,
  BUCKET_LABEL,
  BUCKET_LABEL_RANGE,
  criticalOnlyCount,
  SLA_BUCKETS,
  type SlaBucket,
} from '../../lib/slaBucket';
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

// company + tier + plants + plant + inactive/total + SLA spread + fleet uptime % (Issue 135).
const COLSPAN = 7;

/** Inactive devices as a percentage of the fleet at that entity (inactive / total devices). One
 *  decimal; degrades to a dash when the denominator is unknown so it never renders `NaN%`. */
function inactivePct(inactive: number, total: number | null | undefined): string {
  if (typeof total !== 'number' || !Number.isFinite(total) || total <= 0) return '—';
  return `${((inactive / total) * 100).toFixed(1)}%`;
}

/** Fleet Uptime % for one plant — one decimal, or a dash when the monthly summary has no value yet
 *  (the report is empty until an OH recompute runs — Issue 135). */
function fmtUptime(pct: number | null | undefined): string {
  return typeof pct === 'number' && Number.isFinite(pct) ? `${pct.toFixed(1)}%` : '—';
}

type AssignmentFilter = '' | 'FORMALLY_ASSIGNED' | 'UNASSIGNED';
/** Sort the tree by aggregate inactivity — companies (and their plants) ordered most/least inactive. */
type SortOrder = '' | 'INACTIVE_DESC' | 'INACTIVE_ASC';

/**
 * The per-bucket counts as one compact wrapping chip row (Issue 122b) — replaces eight fixed columns
 * so the whole table fits on screen with no horizontal scroll. Only non-zero buckets render; each chip
 * keeps its `bucket-<B>` test id and shows the label + range on hover.
 */
function SlaSpread({ byBucket }: { byBucket: Record<string, number> }) {
  const nonZero = SLA_BUCKETS.filter((b) => (byBucket[b] ?? 0) > 0);
  if (nonZero.length === 0) return <span className="text-xs text-ink-muted/50">—</span>;
  return (
    <span className="flex flex-wrap items-center gap-1">
      {nonZero.map((b) => (
        <span
          key={b}
          data-testid={`bucket-${b}`}
          title={BUCKET_LABEL_RANGE[b]}
          className={cn(
            'inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[11px] font-semibold tabular-nums',
            BUCKET_CLASS[b],
          )}
        >
          <span className="max-w-20 truncate font-normal">{BUCKET_LABEL[b]}</span>
          {byBucket[b]}
        </span>
      ))}
    </span>
  );
}

/**
 * Company/Plant Overview (Issue 06 AC#3 · FE-06 · Issue 122/122b rework). Company is its own column
 * and the table opens collapsed to one aggregate row per company; expanding a company reveals its
 * plants, and a plant drills down to its open device tickets (device · vehicle · assignment ·
 * overridden · SLA). The per-bucket counts render as one compact chip row (`SlaSpread`) so the table
 * needs NO horizontal scrolling. A universal search + assignment-state filter scope the tree and the
 * drill-down; the download exports the whole filtered view as CSV / Excel / PDF.
 */
export function CompanyPlantTable({
  rows,
  plantUptime,
}: {
  rows: CompanyPlantRow[];
  /** Per-plant current-month Fleet Uptime %, keyed by plantId (Issue 135); `—` shown when absent. */
  plantUptime?: Map<string, number>;
}) {
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

    if (!sortOrder) return filtered;
    // Order companies by aggregate inactive count, and each company's plants the same way, so the
    // most (or least) inactive company floats to the top with its worst plants first.
    const dir = sortOrder === 'INACTIVE_DESC' ? -1 : 1;
    return filtered
      .map((g) => ({ ...g, plants: [...g.plants].sort((a, b) => (a.totalInactive - b.totalInactive) * dir) }))
      .sort((a, b) => (a.totalInactive - b.totalInactive) * dir);
  }, [rows, term, sortOrder, deviceMatchPlantIds]);

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
      'Company', 'Tier', 'Plants', 'Plant', 'Total inactive', 'Total devices', 'Inactive %',
      'Fleet Uptime %', 'Critical', ...SLA_BUCKETS.map((b) => BUCKET_LABEL[b]),
    ];
    const body = chosen.map((r) => [
      r.companyName,
      r.companyTier,
      plantsByCompany.get(r.companyId) ?? '',
      formatPlantDisplayName(r.plantName),
      r.totalInactive,
      r.totalDevices,
      inactivePct(r.totalInactive, r.totalDevices),
      fmtUptime(plantUptime?.get(r.plantId)),
      criticalOnlyCount(r.byBucket),
      ...SLA_BUCKETS.map((b) => r.byBucket[b] ?? 0),
    ]);
    exportTable(format, 'company-plant-overview', 'Company / Plant Overview', headers, body);
  };

  const th =
    'whitespace-nowrap px-4 py-2.5 text-left text-[11px] font-bold uppercase tracking-wider text-white';

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
          <FilterSelect
            aria-label="Sort by inactivity"
            value={sortOrder}
            onChange={(e) => setSortOrder(e.target.value as SortOrder)}
          >
            <option value="">Sort: default order</option>
            <option value="INACTIVE_DESC">Most inactive first</option>
            <option value="INACTIVE_ASC">Least inactive first</option>
          </FilterSelect>
          <ExportMenu onExport={exportOverview} disabled={companies.length === 0} label="Download" />
        </FilterBar>
      </div>
      <div className="overflow-hidden rounded-card border border-line bg-surface-card shadow-sm">
        <table aria-label="Company/Plant Overview" className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-chrome-700 bg-chrome-900">
              <th className={th}>Company</th>
              <th className={th}>Tier</th>
              <th className={cn(th, 'text-right')}>Plants</th>
              <th className={th}>Plant</th>
              <th className={cn(th, 'text-right')}>Inactive / Total</th>
              <th className={th}>SLA Spread</th>
              <th className={cn(th, 'text-right')}>Fleet Uptime %</th>
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
              // Auto-expand while a search is active — a matched company staying collapsed by default
              // hid the very plant/device the search found, making a working search look broken.
              const open = term !== '' || openCompanies.has(co.companyId);
              return (
                <Fragment key={co.companyId}>
                  {/* Company aggregate row (collapsed by default). */}
                  <tr
                    className="cursor-pointer border-b border-line bg-surface-sunken/50 hover:bg-surface-sunken"
                    onClick={() => toggleCompany(co.companyId)}
                  >
                    <td className="px-4 py-2.5 font-semibold text-ink-strong">
                      <span className="flex items-center gap-1.5">
                        <IconChevronRight
                          className={cn('h-4 w-4 shrink-0 text-ink-muted transition-transform', open && 'rotate-90')}
                        />
                        <span className="min-w-0 truncate">{co.companyName}</span>
                      </span>
                    </td>
                    <td className="px-4 py-2.5">
                      <TierBadge tier={co.companyTier} />
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-ink">{co.plants.length}</td>
                    <td className="px-4 py-2.5 text-ink-muted">—</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-ink">
                      {formatInactiveOfTotal(co.totalInactive, co.totalDevices)}
                    </td>
                    <td className="px-4 py-2.5">
                      <SlaSpread byBucket={co.byBucket} />
                    </td>
                    <td className="px-4 py-2.5" />
                  </tr>

                  {open &&
                    co.plants.map((p) => (
                      <Fragment key={p.plantId}>
                        {/* The whole plant row is the toggle for its device sub-table (Issue 135) — no
                            separate "View devices" button. Keyboard-operable like the ticket rows. */}
                        <tr
                          onClick={() => togglePlant(p.plantId)}
                          tabIndex={0}
                          aria-expanded={openPlant === p.plantId}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              void togglePlant(p.plantId);
                            }
                          }}
                          className="cursor-pointer border-b border-line last:border-b-0 hover:bg-surface-sunken/50 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand-600/50"
                        >
                          <td className="px-4 py-2.5 pl-10 text-xs text-ink-muted">{co.companyName}</td>
                          <td className="px-4 py-2.5" />
                          <td className="px-4 py-2.5" />
                          <td className="px-4 py-2.5 text-ink">
                            <PlantName code={p.plantName} />
                          </td>
                          <td
                            data-testid="plant-inactive-total"
                            className="px-4 py-2.5 text-right tabular-nums text-ink"
                          >
                            {formatInactiveOfTotal(p.totalInactive, p.totalDevices)}
                          </td>
                          <td className="px-4 py-2.5">
                            <SlaSpread byBucket={p.byBucket} />
                          </td>
                          <td
                            data-testid="plant-fleet-uptime"
                            className="px-4 py-2.5 text-right tabular-nums text-ink-muted"
                          >
                            {fmtUptime(plantUptime?.get(p.plantId))}
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
                                  totalDevices={p.totalDevices}
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
    </section>
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
  totalDevices,
}: {
  plantLabel: string;
  loading: boolean;
  tickets: TicketRow[];
  totalDevices: number | null | undefined;
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
    { key: 'devices', label: 'Total devices', value: totalDevices ?? '—' },
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
      'Device', 'Vehicle No.', 'Zone', 'Company', 'Plant', 'Transporter', 'Assignment', 'SE', 'Batch', 'SLA',
      'Status',
    ];
    const body = view.map((d) => [
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
              <ExportMenu onExport={exportTickets} disabled={view.length === 0} label="Download" />
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
            {view.map((d) => (
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
                      className="whitespace-nowrap text-xs font-medium text-brand-700 hover:underline"
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
