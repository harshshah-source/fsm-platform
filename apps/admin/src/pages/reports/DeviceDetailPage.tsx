import { useEffect, useMemo, useState } from 'react';
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
import { Button, Field, Input, SectionCard } from '../../components/ui';
import { PlantName, SLABadge } from '../../components/domain';
import { formatInactiveDuration } from '../../lib/inactiveDuration';
import { BUCKET_LABEL_RANGE, SLA_BUCKETS } from '../../lib/slaBucket';

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

  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<DeviceSort>('LONGEST_INACTIVE');
  const [status, setStatus] = useState<DeviceStatusFilter>('ALL');
  const [bucket, setBucket] = useState('');
  const [zoneId, setZoneId] = useState(''); // '' = all; 'UNZONED' or a numeric id string
  const [companyId, setCompanyId] = useState(''); // '' = all
  const [options, setOptions] = useState<DeviceFilterOptions>({ zones: [], companies: [], hasUnzoned: false });
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

  // Any change to the query (search / sort / filters) restarts at page 1 — a stale offset could land
  // past a now-smaller result set.
  useEffect(() => {
    setPage(0);
  }, [search, sort, status, bucket, zoneId, companyId]);

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
    })
      .then((res) => {
        if (!live) return;
        setRows(res.rows);
        setTotal(res.total);
      })
      .catch(() => live && setError('Failed to load devices'));
    return () => {
      live = false;
    };
  }, [search, page, sort, status, bucket, zoneId, companyId]);

  useEffect(() => {
    if (!selectedId) return;
    setCycles(null);
    setTrend(null);
    apiDeviceCycles(selectedId).then((r) => setCycles(r.cycles)).catch(() => setCycles([]));
    apiDeviceDowntimeTrend(selectedId).then(setTrend).catch(() => setTrend(null));
  }, [selectedId]);

  const selected = useMemo(() => rows.find((r) => r.deviceId === selectedId) ?? null, [rows, selectedId]);
  const effectiveDealType = dealType ?? selected?.dealType ?? null;

  const select = (row: DeviceListRow) => {
    setSelectedId(row.deviceId);
    setDealType(row.dealType);
    setShowSummary(false);
  };

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
  const listColumns: Column<DeviceListRow>[] = [
    {
      key: 'deviceId',
      header: 'Device ID',
      render: (r) => <span className="font-medium text-ink-strong tabular-nums">{r.deviceId}</span>,
    },
    { key: 'vehicleNo', header: 'Vehicle Number', render: (r) => r.vehicleNo ?? '—' },
    { key: 'companyName', header: 'Company Name', render: (r) => r.companyName ?? '—' },
    { key: 'plantName', header: 'Plant Name', render: (r) => (r.plantName ? <PlantName code={r.plantName} /> : '—') },
    { key: 'zoneName', header: 'Zone', render: (r) => r.zoneName ?? '—' },
    {
      key: 'inactiveDuration',
      header: 'Inactive Duration',
      align: 'right',
      render: (r) => (
        <span className="tabular-nums text-ink">{formatInactiveDuration(r.latestGpsDatetime) ?? '—'}</span>
      ),
    },
    {
      key: 'slaBucket',
      header: 'SLA Bucket',
      render: (r) =>
        r.slaBucket ? <SLABadge bucket={r.slaBucket} showRange /> : <span className="text-xs text-ink-muted">Active</span>,
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
      />

      {error && (
        <div role="alert" className="mb-4 rounded-md border border-critical/30 bg-critical-bg px-3 py-2 text-sm text-critical">
          {error}
        </div>
      )}

      <div className="mb-4 max-w-md">
        <Field label="Search devices" htmlFor="device-search">
          <Input id="device-search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Device, vehicle, company or plant…" />
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
      </FilterBar>

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
          onRowClick={select}
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
        <>
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
        </>
      )}
    </section>
  );
}
