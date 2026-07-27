import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  apiDeviceCycles,
  apiDeviceDowntimeTrend,
  apiDeviceFilterOptions,
  apiDeviceList,
  apiSetDealType,
  type DeviceCycle,
  type DeviceDowntimeTrend,
  type DeviceFilterOptions,
  type DeviceListRow,
  type DeviceSort,
  type DeviceStatusFilter,
} from '../../api/devices';
import { useAuth } from '../../auth/AuthProvider';
import { BarChartCard, ChartCard, type BarDatum } from '../../components/charts';
import { DataTable, EmptyState, FilterBar, FilterSelect, PageHeader, type Column } from '../../components/data';
import { Badge, Button, Field, Input, SectionCard } from '../../components/ui';
import { PlantName, SLABadge } from '../../components/domain';
import { formatDateTimeWithYear } from '../../lib/datetime';
import { formatInactiveDuration } from '../../lib/inactiveDuration';
import { formatPlantDisplayName } from '../../lib/plantNames';
import { BUCKET_LABEL_RANGE, SLA_BUCKETS } from '../../lib/slaBucket';
import { AssignSePanel } from './AssignSePanel';

/** Assignment-state pill shared by the device list + detail (Issue 122). */
function AssignmentBadge({ state }: { state: string | null | undefined }) {
  if (state === 'FORMALLY_ASSIGNED') return <Badge tone="success">Assigned</Badge>;
  if (state === 'UNASSIGNED') return <Badge tone="warning">Unassigned</Badge>;
  return <span className="text-xs text-ink-muted">No open ticket</span>;
}

const humanize = (c: string | null) => (c ? c.split('_').map((w) => w[0] + w.slice(1).toLowerCase()).join(' ') : '—');
const hrs = (n: number) => `${Math.round(n)}h`;

// One page of the device list. The backend hard-caps a page at 200; 100 keeps the table light while
// still surfacing a meaningful slice, and the pager walks the rest of the (much larger) fleet.
const PAGE_SIZE = 100;
const nf = new Intl.NumberFormat('en-IN');

// Sort options, in menu order — labels are operator-facing; the values match the backend whitelist.
const SORT_OPTIONS: { value: DeviceSort; label: string }[] = [
  { value: 'LONGEST_INACTIVE', label: 'Oldest — longest inactive' },
  { value: 'NEWEST_ACTIVITY', label: 'Newest activity' },
  { value: 'SLA_SEVERITY', label: 'SLA severity' },
  { value: 'PRIORITY', label: 'Priority (Platinum→Silver)' },
  { value: 'DEVICE_ID', label: 'Device ID' },
];

/**
 * FE-22 — Device Detail (ref 22). A searchable device list (the new `/devices` read) over a selected
 * device's lifetime downtime stats + current failure cycle + monthly downtime trend (Issue 44), plus
 * the Operations-Head `deal_type` tag (Issue 49). Recent detail is hot; the lifetime trend is served
 * from the monthly summary table. Zone-scoped server-side. Presentation-only.
 */
export function DeviceDetailPage() {
  const { session } = useAuth();
  const isOpsHead = session?.role === 'OPERATIONS_HEAD';

  // Deep-link support (Issue 122): the Zone Performance Scorecard links here pre-filtered by
  // zone / bucket / status. Read those once as the initial filter values.
  const [searchParams] = useSearchParams();
  const initialStatus = searchParams.get('status');
  // The search box is debounced: `searchInput` follows every keystroke, `search` (what the list
  // query uses) settles 300ms after typing stops — one backend query per pause, not per key.
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<DeviceSort>('LONGEST_INACTIVE');
  const [status, setStatus] = useState<DeviceStatusFilter>(
    initialStatus === 'INACTIVE' || initialStatus === 'ACTIVE' ? initialStatus : 'ALL',
  );
  const [bucket, setBucket] = useState(searchParams.get('bucket') ?? '');
  const [zoneId, setZoneId] = useState(searchParams.get('zoneId') ?? ''); // '' = all; 'UNZONED' or a numeric id string
  const [companyId, setCompanyId] = useState(searchParams.get('companyId') ?? ''); // '' = all
  const [plantId, setPlantId] = useState(searchParams.get('plantId') ?? ''); // '' = all; follows the company pick
  const [assignOpen, setAssignOpen] = useState(false);
  // Bumped after a successful manual assignment so the list refetches with fresh assignment columns.
  const [assignedToken, setAssignedToken] = useState(0);
  // Bumped by the table's Retry action after a failed load (e.g. the backend was restarting).
  const [retryToken, setRetryToken] = useState(0);
  const [options, setOptions] = useState<DeviceFilterOptions>({ zones: [], companies: [], plants: [], hasUnzoned: false });
  const [rows, setRows] = useState<DeviceListRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0); // 0-indexed
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [cycles, setCycles] = useState<DeviceCycle[] | null>(null);
  const [trend, setTrend] = useState<DeviceDowntimeTrend | null>(null);
  const [dealType, setDealType] = useState<string | null>(null);
  const [showSummary, setShowSummary] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Filter dropdown sources — the zones/companies actually present in the caller's scope. Loaded once.
  useEffect(() => {
    apiDeviceFilterOptions().then(setOptions).catch(() => {});
  }, []);

  // Debounce the search keystrokes into the query value.
  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  // Any change to the query (search / sort / filters) restarts at page 1 — a stale offset could land
  // past a now-smaller result set.
  useEffect(() => {
    setPage(0);
  }, [search, sort, status, bucket, zoneId, companyId, plantId]);

  // The plant dropdown follows the company pick — drop a plant that no longer belongs. Skips until
  // the options have actually loaded, so a deep-linked plantId isn't cleared by the empty first render.
  useEffect(() => {
    if (!plantId || !companyId || (options.plants ?? []).length === 0) return;
    const stillValid = (options.plants ?? []).some(
      (p) => String(p.plantId) === plantId && String(p.companyId) === companyId,
    );
    if (!stillValid) setPlantId('');
  }, [companyId, plantId, options.plants]);

  useEffect(() => {
    let live = true;
    apiDeviceList({
      search,
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
      sort,
      status,
      bucket: bucket || undefined,
      zoneId: zoneId === '' ? undefined : zoneId === 'UNZONED' ? 'UNZONED' : Number(zoneId),
      companyId: companyId === '' ? undefined : Number(companyId),
      plantId: plantId === '' ? undefined : Number(plantId),
    })
      .then((res) => {
        if (!live) return;
        setRows(res.rows);
        setTotal(res.total);
        setError(null);
      })
      .catch(() => live && setError('Failed to load devices'));
    return () => {
      live = false;
    };
  }, [search, page, sort, status, bucket, zoneId, companyId, plantId, assignedToken, retryToken]);

  useEffect(() => {
    if (!selectedId) return;
    setCycles(null);
    setTrend(null);
    apiDeviceCycles(selectedId).then((r) => setCycles(r.cycles)).catch(() => setCycles([]));
    apiDeviceDowntimeTrend(selectedId).then(setTrend).catch(() => setTrend(null));
  }, [selectedId]);

  // Plant dropdown options — scoped to the picked company; de-duplicated when unscoped (a plant
  // serving several companies appears once per company in `options.plants`).
  const dedupedPlants = useMemo(() => {
    const all = options.plants ?? [];
    const scoped = companyId ? all.filter((p) => String(p.companyId) === companyId) : all;
    const seen = new Set<number>();
    return scoped.filter((p) => (seen.has(p.plantId) ? false : (seen.add(p.plantId), true)));
  }, [options.plants, companyId]);

  const selected = useMemo(() => rows.find((r) => r.deviceId === selectedId) ?? null, [rows, selectedId]);
  const effectiveDealType = dealType ?? selected?.dealType ?? null;

  const select = (row: DeviceListRow) => {
    setSelectedId(row.deviceId);
    setDealType(row.dealType);
    setShowSummary(false);
  };

  // The detail block renders BELOW the (long) device table — scroll it into view on selection, or a
  // row click reads as "nothing happened" (operator report, 2026-07-15). Optional-chained: jsdom has
  // no scrollIntoView.
  const detailRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (selectedId) detailRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
  }, [selectedId]);

  const tag = async (dt: 'RECURRING' | 'ONE_TIME') => {
    if (!selectedId) return;
    try {
      const updated = await apiSetDealType(selectedId, dt);
      setDealType(updated.dealType);
    } catch {
      setError('Failed to tag the deal type');
    }
  };

  // Pager geometry — 1-indexed row span for the caption, clamped so an empty page reads "0" cleanly.
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const fromRow = total === 0 ? 0 : page * PAGE_SIZE + 1;
  const toRow = Math.min(total, page * PAGE_SIZE + rows.length);

  const componentHours = useMemo(() => (trend?.monthly ?? []).reduce((s, m) => s + m.componentDowntimeHours, 0), [trend]);
  const currentCycle = useMemo(() => (cycles ?? []).find((c) => c.closedAt === null) ?? (cycles ?? [])[0] ?? null, [cycles]);
  const trendBars: BarDatum[] = useMemo(() => (trend?.monthly ?? []).map((m) => ({ name: m.month, value: m.downtimeHours })), [trend]);

  // Proper per-attribute columns (Change #1) — Device ID / Vehicle Number / Company / Plant / Zone are
  // no longer crammed together, and Inactive Duration is split from the SLA Bucket. All fields come
  // straight off the zone-scoped `/devices` payload (device → vehicle → plant → zone, company_master),
  // so no per-row fetch. Plant short codes (e.g. ACP-9106) are displayed verbatim (source-data issue).
  // Widths drive the fixed table layout (`tableLayout="fixed"` on the DataTable below) so all 11 columns
  // fit the page and the operator never scrolls sideways; long ids/names wrap (`break-all` on the mono
  // id columns). Re-proportioned down from 100% (#160) to leave room for the leading 3.5rem S.No. column.
  const listColumns: Column<DeviceListRow>[] = [
    {
      key: 'deviceId',
      header: 'Device ID',
      width: '9%',
      className: 'break-all',
      render: (r) => <span className="font-medium text-ink-strong tabular-nums">{r.deviceId}</span>,
    },
    { key: 'vehicleNo', header: 'Vehicle Number', width: '9%', className: 'break-all', render: (r) => r.vehicleNo ?? '—' },
    // AutoPlant device identity, mirrored onto `devices` by the daily master sync. Both are sparse at
    // source (Device Type ~93%, IMSI ~85% of the deployed fleet), so "—" is a normal reading here.
    { key: 'deviceType', header: 'Device Type', width: '7%', render: (r) => r.deviceType ?? '—' },
    {
      key: 'imsiNo',
      header: 'IMSI No',
      width: '8%',
      className: 'break-all',
      render: (r) => (r.imsiNo ? <span className="tabular-nums">{r.imsiNo}</span> : '—'),
    },
    { key: 'companyName', header: 'Company Name', width: '11%', render: (r) => r.companyName ?? '—' },
    { key: 'plantName', header: 'Plant Name', width: '9%', render: (r) => (r.plantName ? <PlantName code={r.plantName} /> : '—') },
    { key: 'zoneName', header: 'Zone', width: '7%', render: (r) => r.zoneName ?? '—' },
    {
      key: 'inactiveDuration',
      header: 'Inactive Duration',
      align: 'right',
      width: '8%',
      render: (r) => (
        <span className="tabular-nums text-ink">{formatInactiveDuration(r.latestGpsDatetime) ?? '—'}</span>
      ),
    },
    {
      key: 'tripCreationDatetime',
      header: 'Trip Creation Date Time',
      width: '8%',
      render: (r) => <span className="tabular-nums text-ink">{formatDateTimeWithYear(r.tripCreationDatetime)}</span>,
    },
    {
      key: 'slaBucket',
      header: 'SLA Bucket',
      width: '9%',
      render: (r) =>
        r.slaBucket ? <SLABadge bucket={r.slaBucket} showRange /> : <span className="text-xs text-ink-muted">Active</span>,
    },
    {
      key: 'assignment',
      header: 'Assignment',
      width: '11%',
      render: (r) => (
        <span className="flex flex-col gap-0.5">
          <AssignmentBadge state={r.assignmentState} />
          {r.assignedSeName && <span className="text-xs text-ink-muted">{r.assignedSeName}</span>}
          {r.openTicketId && (
            <Link
              to={`/tickets/${r.openTicketId}`}
              data-testid={`row-ticket-link-${r.deviceId}`}
              title="Open this ticket in Ticket Operations"
              // Row click selects the device inline; the link must not also re-select on its way out.
              onClick={(e) => e.stopPropagation()}
              className="inline-flex w-fit items-center gap-1 font-mono text-xs font-medium text-info hover:underline"
            >
              #{r.openTicketId.slice(0, 8)}
              <span aria-hidden>→</span>
            </Link>
          )}
        </span>
      ),
    },
  ];

  const summaryColumns: Column<DeviceDowntimeTrend['monthly'][number]>[] = [
    { key: 'month', header: 'Month', render: (m) => m.month },
    { key: 'cycles', header: 'Cycles', align: 'right', render: (m) => m.cycleCount },
    { key: 'hours', header: 'Downtime', align: 'right', render: (m) => hrs(m.downtimeHours) },
  ];

  const stats: { label: string; value: string | number }[] = trend
    ? [
        { label: 'Lifetime Cycles', value: trend.lifetime.totalCycles },
        { label: 'Downtime Hrs', value: hrs(trend.lifetime.totalDowntimeHours) },
        { label: 'Avg Recovery Hrs', value: trend.lifetime.avgTimeToRecoverHours != null ? hrs(trend.lifetime.avgTimeToRecoverHours) : '—' },
        { label: 'Longest Episode Hrs', value: hrs(trend.lifetime.longestEpisodeHours) },
        { label: 'Repeat Failures', value: trend.lifetime.repeatFailures },
        { label: 'Component-Related Hrs', value: hrs(componentHours) },
      ]
    : [];

  return (
    <section>
      <PageHeader
        title="Device Detail"
        subtitle="Per-device lifetime downtime history and trend — failure cycles, root cause, component and verification context. Recent detail is hot; the lifetime trend reads the monthly summary. Zone-scoped for ZM."
        actions={
          <Button
            type="button"
            size="sm"
            variant={assignOpen ? 'secondary' : 'primary'}
            data-testid="assign-se-toggle"
            onClick={() => setAssignOpen((o) => !o)}
          >
            {assignOpen ? 'Close Assign SE' : 'Assign SE'}
          </Button>
        }
      />

      {error && (
        <div role="alert" className="mb-4 rounded-md border border-critical/30 bg-critical-bg px-3 py-2 text-sm text-critical">
          {error}
        </div>
      )}

      <div className="mb-4 max-w-md">
        <Field label="Search devices" htmlFor="device-search">
          <Input id="device-search" value={searchInput} onChange={(e) => setSearchInput(e.target.value)} placeholder="Device, vehicle, company or plant…" />
        </Field>
      </div>

      <FilterBar>
        <FilterSelect aria-label="Sort by" value={sort} onChange={(e) => setSort(e.target.value as DeviceSort)}>
          {SORT_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              Sort: {o.label}
            </option>
          ))}
        </FilterSelect>
        <FilterSelect aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value as DeviceStatusFilter)}>
          <option value="ALL">All statuses</option>
          <option value="INACTIVE">Inactive only</option>
          <option value="ACTIVE">Active only</option>
        </FilterSelect>
        <FilterSelect aria-label="SLA bucket" value={bucket} onChange={(e) => setBucket(e.target.value)}>
          <option value="">All SLA buckets</option>
          {SLA_BUCKETS.map((b) => (
            <option key={b} value={b}>
              {BUCKET_LABEL_RANGE[b]}
            </option>
          ))}
        </FilterSelect>
        <FilterSelect aria-label="Zone" value={zoneId} onChange={(e) => setZoneId(e.target.value)}>
          <option value="">All zones</option>
          {options.hasUnzoned && <option value="UNZONED">UNZONED</option>}
          {options.zones.map((z) => (
            <option key={z.zoneId} value={z.zoneId}>
              {z.name}
            </option>
          ))}
        </FilterSelect>
        <FilterSelect aria-label="Company" value={companyId} onChange={(e) => setCompanyId(e.target.value)}>
          <option value="">All companies</option>
          {options.companies.map((c) => (
            <option key={c.companyId} value={c.companyId}>
              {c.name}
            </option>
          ))}
        </FilterSelect>
        {/* Plant dropdown follows the company pick (Issue 122b) — only that company's plants list. */}
        <FilterSelect aria-label="Plant" value={plantId} onChange={(e) => setPlantId(e.target.value)}>
          <option value="">All plants</option>
          {dedupedPlants.map((p) => (
            <option key={p.plantId} value={String(p.plantId)}>
              {formatPlantDisplayName(p.name)}
            </option>
          ))}
        </FilterSelect>
      </FilterBar>

      {assignOpen && (
        <AssignSePanel
          options={options}
          onAssigned={() => setAssignedToken((t) => t + 1)}
          onClose={() => setAssignOpen(false)}
        />
      )}

      <ChartCard
        title="Devices"
        className="mb-5"
        action={
          <span data-testid="device-list-count" className="text-xs text-ink-muted tabular-nums">
            {total === 0 ? 'No devices' : `Showing ${nf.format(fromRow)}–${nf.format(toRow)} of ${nf.format(total)}`}
          </span>
        }
      >
        <DataTable
          columns={listColumns}
          rows={rows}
          rowKey={(r) => r.deviceId}
          rowTestId={(r) => `dev-row-${r.deviceId}`}
          ariaLabel="Device list"
          tableLayout="fixed"
          snoOffset={page * PAGE_SIZE}
          onRowClick={select}
          // A failed load must read as a failure with a Retry — never as "no devices" (Issue 122b:
          // an operator saw the empty state while the backend was mid-restart and reported a bug).
          error={error}
          onRetry={() => setRetryToken((t) => t + 1)}
          empty={<EmptyState message="No devices for the current scope." />}
        />
        {total > PAGE_SIZE && (
          <nav aria-label="Device list pages" className="mt-3 flex items-center justify-between gap-3">
            <Button
              size="sm"
              variant="secondary"
              data-testid="device-page-prev"
              disabled={page === 0}
              onClick={() => setPage((p) => Math.max(0, p - 1))}
            >
              ‹ Prev
            </Button>
            <span data-testid="device-page-status" className="text-xs text-ink-muted tabular-nums">
              Page {nf.format(page + 1)} of {nf.format(pageCount)}
            </span>
            <Button
              size="sm"
              variant="secondary"
              data-testid="device-page-next"
              disabled={page + 1 >= pageCount}
              onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
            >
              Next ›
            </Button>
          </nav>
        )}
      </ChartCard>

      {selected && (
        <div ref={detailRef}>
          <SectionCard
            title={
              <span className="flex items-center justify-between gap-3">
                <span>
                  {selected.deviceId}
                  <span className="ml-2 text-xs font-normal text-ink-muted">
                    {[selected.vehicleNo, selected.deviceType, selected.companyName].filter(Boolean).join(' · ')}
                  </span>
                </span>
                {effectiveDealType && <span className="text-xs font-medium text-ink-muted">Deal: {humanize(effectiveDealType)}</span>}
              </span>
            }
            className="mb-5"
          >
            <div data-testid="device-stats" className="grid grid-cols-2 gap-3 md:grid-cols-3">
              {stats.map((s) => (
                <div key={s.label} className="rounded-md border border-line bg-surface-sunken px-3 py-2">
                  <div className="text-xs uppercase tracking-wide text-ink-muted">{s.label}</div>
                  <div className="text-lg font-semibold text-ink-strong">{s.value}</div>
                </div>
              ))}
              {!trend && <p className="text-sm text-ink-muted">Loading lifetime stats…</p>}
            </div>

            <div data-testid="device-assignment" className="mt-4 rounded-md border border-line bg-surface-sunken px-3 py-2">
              <div className="mb-1 text-xs font-medium uppercase tracking-wide text-ink-muted">Assignment</div>
              {selected.assignmentState ? (
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
                  <span className="flex items-center gap-2">
                    <AssignmentBadge state={selected.assignmentState} />
                  </span>
                  {selected.assignedSeName && (
                    <span className="text-ink">
                      <span className="text-ink-muted">SE:</span> {selected.assignedSeName}
                    </span>
                  )}
                  {selected.batchId && (
                    <span className="text-ink">
                      <span className="text-ink-muted">Batch:</span> #{selected.batchId}
                      {selected.batchStatus === 'OVERRIDDEN' && (
                        <Badge tone="info" className="ml-1.5">Overridden</Badge>
                      )}
                    </span>
                  )}
                  {selected.scheduleId && (
                    <span className="text-ink">
                      <span className="text-ink-muted">Schedule:</span> #{selected.scheduleId}
                    </span>
                  )}
                  {selected.openTicketId && (
                    <Link
                      to={`/tickets/${selected.openTicketId}`}
                      data-testid="open-ticket-link"
                      title="Open this ticket in Ticket Operations"
                      className="inline-flex items-center gap-1 rounded-md border border-line bg-surface-card px-2 py-0.5 font-mono text-xs font-medium text-info transition-colors hover:border-info/40 hover:bg-info-bg"
                    >
                      Ticket #{selected.openTicketId.slice(0, 8)}
                      <span aria-hidden>→</span>
                    </Link>
                  )}
                </div>
              ) : (
                <div className="text-sm text-ink-muted">No open ticket for this device.</div>
              )}
            </div>

            {isOpsHead && (
              <div data-testid="deal-type-control" className="mt-4 flex items-center gap-2">
                <span className="text-xs font-medium text-ink-muted">Tag deal type:</span>
                <Button size="sm" variant={effectiveDealType === 'RECURRING' ? 'primary' : 'secondary'} data-testid="deal-type-recurring" onClick={() => void tag('RECURRING')}>
                  Recurring
                </Button>
                <Button size="sm" variant={effectiveDealType === 'ONE_TIME' ? 'primary' : 'secondary'} data-testid="deal-type-onetime" onClick={() => void tag('ONE_TIME')}>
                  One-time
                </Button>
              </div>
            )}
          </SectionCard>

          <SectionCard title="Current failure cycle" className="mb-5">
            {currentCycle ? (
              <dl className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-1 text-sm">
                <dt className="text-ink-muted">SLA bucket</dt>
                <dd><SLABadge bucket={currentCycle.slaBucketReached} /></dd>
                <dt className="text-ink-muted">Root cause</dt>
                <dd>{humanize(currentCycle.rootCauseCategory)}</dd>
                <dt className="text-ink-muted">Repeat failure</dt>
                <dd>{currentCycle.repeatFailure ? 'Yes' : 'No'}</dd>
                <dt className="text-ink-muted">Component-related</dt>
                <dd>{currentCycle.componentRelated ? 'Yes' : 'No'}</dd>
                <dt className="text-ink-muted">Verification</dt>
                <dd>{humanize(currentCycle.verificationOutcome)}</dd>
              </dl>
            ) : (
              <EmptyState message="No failure cycles recorded for this device." />
            )}
          </SectionCard>

          <ChartCard
            title="Lifetime downtime trend"
            className="mb-5"
            action={
              <Button size="sm" variant="secondary" data-testid="trend-summary-toggle" onClick={() => setShowSummary((s) => !s)}>
                {showSummary ? 'Chart' : 'Summary table'}
              </Button>
            }
          >
            {showSummary ? (
              <DataTable
                columns={summaryColumns}
                rows={trend?.monthly ?? []}
                rowKey={(m) => m.month}
                ariaLabel="Downtime summary"
                empty={<EmptyState message="No monthly downtime history." />}
              />
            ) : trendBars.length ? (
              <BarChartCard data={trendBars} />
            ) : (
              <EmptyState message="No monthly downtime history." />
            )}
          </ChartCard>
        </div>
      )}
    </section>
  );
}
