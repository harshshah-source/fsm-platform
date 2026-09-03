import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  apiCommissioningCohort,
  apiCommissioningInstallers,
  type CohortInstallerRow,
  type CohortPlantRow,
  type CommissioningCohortReport,
  type CommissioningPopulation,
  type CommissioningTiming,
  type InstallQualityReport,
  type InstallQualityRow,
  type InstallerKind,
} from '../../api/reports';
import {
  apiDeviceList,
  type DeviceListRow,
  type DeviceSort,
  type DeviceStatusFilter,
} from '../../api/devices';
import {
  apiAssignTicket,
  apiZoneEngineers,
  DeferralConflictError,
  type DeferralConflict,
  type ZoneEngineer,
} from '../../api/schedules';
import { ChartCard, TrendChart, type TrendDatum } from '../../components/charts';
import { DeferralConfirm } from '../../components/domain';
import {
  DataTable,
  EmptyState,
  FilterBar,
  FilterSelect,
  MetricStrip,
  PageHeader,
  SearchInput,
  type Column,
  type Metric,
} from '../../components/data';
import { Badge, Button } from '../../components/ui';
import { engineerOptionLabel } from '../../lib/capacity';

/**
 * #232 AC-1 — Commissioning cohort & install quality (ref `21-reports.png`).
 *
 * Composition follows the reports reference: scope-chip band → KPI strip → two panels → breakdown
 * tables. Presentation only; every number here is served ready-made by
 * `/api/reports/commissioning/{cohort,installers}` and nothing is recomputed in the browser. That is
 * deliberate — the cohort's population predicate and its "came online" definition live in one SQL
 * expression, and a second arithmetic here is exactly how two surfaces start disagreeing.
 *
 * Three rendering rules below are correctness rather than polish:
 *
 *  1. **A null median renders "—", never 0.** Zero claims every device commissioned instantly; the
 *     null says nothing was measured. `sampleSize` is shown beside every median for the same reason.
 *  2. **Installer rows that are not `PERSON` are shown but never ranked.** 17,712 of 24,294 logins are
 *     an underscore form that mixes plant-prefixed individuals with depot accounts, and nothing in the
 *     data separates them. A leaderboard that names one of those is a confidently wrong accusation.
 *  3. **The window says "last 90 days", not "last 3 months".** The ceiling is 90 — a measured
 *     performance contract — and a label that overstates it by two days would be the page lying about
 *     its own scope.
 */

/** The server caps `cohortDays` at 90; offering a 92-day "3 months" option would just 400. */
const WINDOW_OPTIONS = [
  { value: 7, label: 'Last 7 days' },
  { value: 30, label: 'Last 30 days' },
  { value: 90, label: 'Last 90 days' },
] as const;

const POPULATION_OPTIONS: { value: CommissioningPopulation; label: string }[] = [
  { value: 'operational', label: 'Operational fleet' },
  { value: 'all', label: 'All fitting events (incl. warehouse)' },
];

/** The controlled vocabulary `INSTALLATION_REMARK` carries, plus the blank bulk-load population. */
const REMARK_OPTIONS = [
  { value: '', label: 'All install types' },
  { value: 'New Installation', label: 'New Installation' },
  { value: 'Re-Installation', label: 'Re-Installation' },
  { value: 'Re-Mapping', label: 'Re-Mapping' },
] as const;

const INSTALLER_KIND_LABEL: Record<InstallerKind, string> = {
  PERSON: 'Person',
  SERVICE_ACCOUNT: 'Service account',
  UNCLASSIFIED: 'Unresolved login',
  UNATTRIBUTED: 'No installer recorded',
};

// #236 — the cohort's device list. Same sort/status vocabulary as Device Detail (FE-22), because they
// are the same backend enum (`DeviceSort`/`DeviceStatusFilter`) and a second set of labels for the
// same values is how two pages start reading as if they mean different things.
const DEVICE_SORT_OPTIONS: { value: DeviceSort; label: string }[] = [
  { value: 'LONGEST_INACTIVE', label: 'Oldest — longest inactive' },
  { value: 'NEWEST_ACTIVITY', label: 'Newest activity' },
  { value: 'SLA_SEVERITY', label: 'SLA severity' },
  { value: 'DEVICE_ID', label: 'Device ID' },
];
const DEVICE_PAGE_SIZE = 25;
const nf = new Intl.NumberFormat('en-IN');

/** A median of `null` is "not measured" and must never render as a zero. */
const hours = (t: CommissioningTiming): string => (t.medianHours === null ? '—' : `${t.medianHours} h`);
const pct = (part: number, whole: number): string => (whole === 0 ? '—' : `${Math.round((part / whole) * 1000) / 10}%`);

export function CommissioningCohortPage() {
  const [cohortDays, setCohortDays] = useState<number>(90);
  const [population, setPopulation] = useState<CommissioningPopulation>('operational');
  const [remark, setRemark] = useState<string>('');

  const [report, setReport] = useState<CommissioningCohortReport | null>(null);
  const [quality, setQuality] = useState<InstallQualityReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  // #236 — the cohort's device list. `deviceSearchInput` follows every keystroke; `deviceSearch` (what
  // the query uses) settles 300ms after typing stops, the same debounce Device Detail uses.
  const [deviceSearchInput, setDeviceSearchInput] = useState('');
  const [deviceSearch, setDeviceSearch] = useState('');
  const [deviceSort, setDeviceSort] = useState<DeviceSort>('LONGEST_INACTIVE');
  const [deviceStatus, setDeviceStatus] = useState<DeviceStatusFilter>('ALL');
  // Set only by the "Filter to this plant" button below — a scope the reader chose IN this table, not
  // a dropdown to go looking in. Independent of the #235 `<Link>` to Device Detail, which still
  // navigates away unchanged.
  const [devicePlantFilter, setDevicePlantFilter] = useState<{ id: string; name: string } | null>(null);
  const [devicePage, setDevicePage] = useState(0);
  const [deviceRows, setDeviceRows] = useState<DeviceListRow[]>([]);
  const [deviceTotal, setDeviceTotal] = useState(0);
  const [deviceError, setDeviceError] = useState<string | null>(null);
  const [engineers, setEngineers] = useState<ZoneEngineer[]>([]);
  // Bumped after a successful Assign SE so the list refetches with the fresh assignment column.
  const [assignedToken, setAssignedToken] = useState(0);
  const deviceListRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let live = true;
    setError(null);
    setReport(null);
    const remarks = remark === '' ? undefined : [remark];
    // The two loads are independent and neither gates the other — the #193 precedent. Install quality
    // is the slower, wider read; the cohort should not wait on it.
    apiCommissioningCohort({ cohortDays, population, remarks })
      .then((r) => live && setReport(r))
      .catch(() => live && setError('Failed to load the commissioning cohort'));
    apiCommissioningInstallers({ lookbackDays: cohortDays, groupBy: 'installer', sort: 'neverOnlineRate', minInstalls: 5, population })
      .then((r) => live && setQuality(r))
      .catch(() => live && setQuality(null));
    return () => {
      live = false;
    };
  }, [cohortDays, population, remark]);

  // The zone-scoped engineer roster for the Assign SE control below — loaded once. Same endpoint
  // CriticalQueue's one-click assign uses, so a ZM sees only their own zone's SEs, matching the clamp
  // the rest of this page already carries.
  useEffect(() => {
    apiZoneEngineers()
      .then(setEngineers)
      .catch(() => setEngineers([]));
  }, []);

  useEffect(() => {
    const t = setTimeout(() => setDeviceSearch(deviceSearchInput), 300);
    return () => clearTimeout(t);
  }, [deviceSearchInput]);

  // A query change restarts at page 1 — a stale offset could land past a now-smaller result set.
  useEffect(() => {
    setDevicePage(0);
  }, [deviceSearch, deviceSort, deviceStatus, devicePlantFilter, cohortDays]);

  useEffect(() => {
    let live = true;
    apiDeviceList({
      search: deviceSearch,
      limit: DEVICE_PAGE_SIZE,
      offset: devicePage * DEVICE_PAGE_SIZE,
      sort: deviceSort,
      status: deviceStatus,
      plantId: devicePlantFilter ? Number(devicePlantFilter.id) : undefined,
      commissionedWithinDays: cohortDays,
    })
      .then((res) => {
        if (!live) return;
        setDeviceRows(res.rows);
        setDeviceTotal(res.total);
        setDeviceError(null);
      })
      .catch(() => live && setDeviceError('Failed to load the device list'));
    return () => {
      live = false;
    };
  }, [deviceSearch, devicePage, deviceSort, deviceStatus, devicePlantFilter, cohortDays, assignedToken]);

  const loading = report === null && error === null;
  const totals = report?.totals;
  const census = report?.population;
  const resolution = report?.resolution;

  const metrics: Metric[] = [
    {
      label: 'Fitting Events',
      value: totals?.fitments ?? '—',
      hint: `Fitting events in the last ${cohortDays} days`,
      tone: 'info',
      kpi: 'commissioningFitments',
      testId: 'kpi-fitments',
    },
    {
      label: 'Came Online',
      value: totals?.online ?? '—',
      hint: totals ? `${pct(totals.online, totals.fitments)} of fitting events` : 'First GPS fix received',
      tone: 'success',
      kpi: 'commissioningOnline',
      testId: 'kpi-online',
      share: totals && totals.fitments > 0 ? totals.online / totals.fitments : null,
    },
    {
      label: 'Awaiting First Report',
      value: totals?.pending ?? '—',
      hint: report ? `Silent, inside the ${report.graceHours} h grace window` : 'Not yet a defect',
      tone: 'warning',
      kpi: 'commissioningPending',
      testId: 'kpi-pending',
    },
    {
      label: 'Failed to Report',
      value: totals?.failed ?? '—',
      hint: report ? `Silent past ${report.graceHours} h — broken, not slow` : 'Past the grace window',
      tone: 'critical',
      kpi: 'commissioningFailed',
      testId: 'kpi-failed',
      share: totals && totals.fitments > 0 ? totals.failed / totals.fitments : null,
    },
    {
      label: 'Median Time to First Report',
      value: totals ? hours(totals.ttfr) : '—',
      // The sample size rides on the card, not in a tooltip: this median is measured over far fewer
      // fitting events than the count beside it, and a reader who cannot see that will over-trust it.
      hint: totals ? `n = ${totals.ttfr.sampleSize} measurable fitting events` : 'Post-epoch fitting events only',
      tone: 'brand',
      kpi: 'commissioningTtfr',
      testId: 'kpi-ttfr',
    },
  ];

  // A cumulative series over hours-since-fitment — one line approaching an asymptote, not a set of
  // unrelated categories. It was drawn as a BarList (stacked horizontal bars) until #236; that read as
  // five disconnected buckets and hid the shape (how fast it flattens, and what it flattens AT) that is
  // the whole point of the panel. Buckets with a null percentage are dropped rather than rendered as 0
  // — a device grade is either measured or excluded, and 0% would claim it stayed dark when nothing
  // about it was measured at all.
  const curve: TrendDatum[] = useMemo(
    () =>
      (resolution?.buckets ?? [])
        .filter((b) => b.cumulativeOnlinePct !== null)
        .map((b) => ({ label: `${b.upToHours}h`, value: b.cumulativeOnlinePct ?? 0 })),
    [resolution],
  );

  const plantColumns: Column<CohortPlantRow>[] = [
    {
      key: 'plant',
      header: 'Plant',
      // #235 drill-through. Links on `plantId`, never on the displayed name — the #217 S2 defect was
      // exactly a drilldown that substituted a display value into an id param. The target reads every
      // param handed to it (verified against DeviceDetailPage's contract, not assumed).
      render: (r) => (
        <span className="flex items-center gap-2">
          <Link
            to={`/reports/device?plantId=${r.plantId}&commissionedWithinDays=${cohortDays}`}
            data-testid={`cc-plant-link-${r.plantId}`}
            className="text-brand-600 hover:underline focus-ring rounded"
          >
            {r.plantName}
          </Link>
          {/* #236 — a SEPARATE affordance from the link above. The link navigates to Device Detail
              (unchanged, #235); this narrows the table further down THIS page, in place. */}
          <button
            type="button"
            data-testid={`cc-plant-filter-${r.plantId}`}
            title={`Filter the device list below to ${r.plantName}`}
            onClick={(e) => {
              e.stopPropagation();
              setDevicePlantFilter({ id: r.plantId, name: r.plantName });
              deviceListRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
            }}
            className="text-[11px] text-ink-muted underline-offset-2 hover:underline focus-ring rounded"
          >
            Filter list ↓
          </button>
        </span>
      ),
      // The export must carry the plant NAME, not the link markup.
      exportValue: (r) => r.plantName,
      sortable: true,
      sortValue: (r) => r.plantName,
    },
    { key: 'fitments', header: 'Fitting Events', align: 'right', sortable: true, sortValue: (r) => r.fitments, render: (r) => r.fitments },
    { key: 'online', header: 'Online', align: 'right', sortable: true, sortValue: (r) => r.online, render: (r) => r.online },
    { key: 'pending', header: 'Awaiting', align: 'right', sortable: true, sortValue: (r) => r.pending, render: (r) => r.pending },
    { key: 'failed', header: 'Failed', align: 'right', sortable: true, sortValue: (r) => r.failed, render: (r) => r.failed },
    {
      key: 'rate',
      header: 'Online %',
      align: 'right',
      sortable: true,
      sortValue: (r) => (r.fitments === 0 ? 0 : r.online / r.fitments),
      render: (r) => pct(r.online, r.fitments),
    },
    { key: 'ttfr', header: 'Median TTFR', align: 'right', render: (r) => hours(r.ttfr) },
  ];

  const installerColumns: Column<CohortInstallerRow>[] = [
    {
      key: 'installer',
      header: 'Installer login',
      render: (r) => (
        <span className="flex flex-col">
          <span>{r.installerKey ?? '—'}</span>
          {/* The kind is on every row, not just the ambiguous ones: a reader has to be able to see
              that "unresolved" is a category the data has, rather than an error on one row. */}
          <span className="text-[11px] text-ink-muted">{INSTALLER_KIND_LABEL[r.installerKind]}</span>
        </span>
      ),
      sortable: true,
      sortValue: (r) => r.installerKey ?? '',
    },
    { key: 'fitments', header: 'Fitting Events', align: 'right', sortable: true, sortValue: (r) => r.fitments, render: (r) => r.fitments },
    { key: 'online', header: 'Online', align: 'right', sortable: true, sortValue: (r) => r.online, render: (r) => r.online },
    { key: 'failed', header: 'Failed', align: 'right', sortable: true, sortValue: (r) => r.failed, render: (r) => r.failed },
    { key: 'ttfr', header: 'Median TTFR', align: 'right', render: (r) => hours(r.ttfr) },
  ];

  const qualityColumns: Column<InstallQualityRow>[] = [
    {
      key: 'installer',
      header: 'Installer login',
      render: (r) => (
        <span className="flex flex-col">
          <span>{r.installerKey ?? '—'}</span>
          <span className="text-[11px] text-ink-muted">{r.installerKind ? INSTALLER_KIND_LABEL[r.installerKind] : '—'}</span>
        </span>
      ),
    },
    { key: 'installs', header: 'Installs', align: 'right', render: (r) => r.installs },
    { key: 'neverOnline', header: 'Never online', align: 'right', render: (r) => r.neverOnline },
    { key: 'rate', header: 'Never-online %', align: 'right', render: (r) => `${Math.round(r.neverOnlineRate * 1000) / 10}%` },
    { key: 'plants', header: 'Plants', align: 'right', render: (r) => r.distinctPlants },
    {
      key: 'days',
      header: 'Install days',
      align: 'right',
      // "Many installs, one afternoon, none online" is a shape rather than an anecdote, which is why
      // this is a first-class column instead of a footnote.
      render: (r) => r.distinctInstallDays,
    },
  ];

  // #236 — pager geometry, same shape as Device Detail's.
  const devicePageCount = Math.max(1, Math.ceil(deviceTotal / DEVICE_PAGE_SIZE));
  const deviceFromRow = deviceTotal === 0 ? 0 : devicePage * DEVICE_PAGE_SIZE + 1;
  const deviceToRow = Math.min(deviceTotal, devicePage * DEVICE_PAGE_SIZE + deviceRows.length);

  const deviceColumns: Column<DeviceListRow>[] = [
    { key: 'deviceId', header: 'Device ID', render: (r) => <span className="whitespace-nowrap font-medium text-ink-strong tabular-nums">{r.deviceId}</span> },
    { key: 'vehicleNo', header: 'Vehicle', render: (r) => r.vehicleNo ?? '—' },
    { key: 'plantName', header: 'Plant', render: (r) => r.plantName ?? '—' },
    { key: 'companyName', header: 'Company', render: (r) => r.companyName ?? '—' },
    {
      key: 'status',
      header: 'Status',
      render: (r) =>
        r.latestGpsDatetime === null ? (
          <Badge tone="critical">Never reported</Badge>
        ) : r.isInactive ? (
          <Badge tone="warning">Inactive</Badge>
        ) : (
          <Badge tone="success">Active</Badge>
        ),
    },
    {
      key: 'assignment',
      header: 'Assignment',
      render: (r) => (
        <DeviceAssignControl
          row={r}
          engineers={engineers}
          onAssigned={() => setAssignedToken((t) => t + 1)}
        />
      ),
    },
  ];

  return (
    <section>
      <PageHeader
        title="Commissioning Cohort"
        subtitle="Install quality for recently fitted devices — how many came online, how long each took, and which have not. Zone-scoped for ZM, cross-zone for CSM / Operations Head."
      />

      {error && (
        <div role="alert" className="mb-4 rounded-md border border-critical/30 bg-critical-bg px-3 py-2 text-sm text-critical">
          {error}
        </div>
      )}
      {loading && <p className="mb-4 text-sm text-ink-muted">Loading commissioning cohort…</p>}

      {/* Scope-chip band — the ZoneDrilldownSection pattern. A ZM is CLAMPED server-side, and is told
          so here rather than being shown a partial answer that looks whole. */}
      <div className="mb-4 flex flex-wrap items-center gap-2" data-testid="commissioning-scope">
        <FilterBar>
          <FilterSelect
            aria-label="Cohort window"
            value={cohortDays}
            onChange={(e) => setCohortDays(Number(e.target.value))}
          >
            {WINDOW_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </FilterSelect>
          <FilterSelect
            aria-label="Population"
            value={population}
            onChange={(e) => setPopulation(e.target.value as CommissioningPopulation)}
          >
            {POPULATION_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </FilterSelect>
          <FilterSelect aria-label="Install type" value={remark} onChange={(e) => setRemark(e.target.value)}>
            {REMARK_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </FilterSelect>
        </FilterBar>
        {report?.scopedToZoneId && (
          <span
            data-testid="commissioning-zone-clamp"
            className="rounded-full border border-line bg-surface-sunken px-2.5 py-1 text-[11px] text-ink-muted"
          >
            Scoped to your zone
          </span>
        )}
        {report && (
          <span className="rounded-full border border-line bg-surface-sunken px-2.5 py-1 text-[11px] text-ink-muted">
            Fitted since {new Date(report.cohortStart).toLocaleDateString()}
          </span>
        )}
      </div>

      <MetricStrip cols={5} metrics={metrics} />

      {/* Every drop between "fitting events AutoPlant recorded" and "fitting events this page measures"
          is named. Without it a reader reconciling against the source concludes the page is broken —
          and before #233 the page would have been: warehouse devices were counted as failed installs. */}
      {census && (
        <p className="mb-4 text-[12px] text-ink-muted" data-testid="commissioning-census">
          {census.fitmentsInWindow} fitting events in window ={' '}
          <strong className="text-ink-strong">{census.operational} operational</strong> + {census.warehouse} warehouse +{' '}
          {census.deactivatedPlant} on deactivated plants + {census.unmirrored} unmirrored.
          {population === 'operational' && ' Warehouse devices are silent because they are in a warehouse, not because an install failed.'}
        </p>
      )}

      {/* #236 — full width, not paired 2-up (a deliberate departure from the `21-reports.png` panel
          pairing, on direct operator instruction: a 6-column install-quality table read as cramped at
          half the 1440px shell, and the curve's shape is easier to read wide than squeezed narrow). */}
      <ChartCard title="How fast this cohort came online" className="mb-5">
        {curve.length ? (
          <>
            <div data-testid="commissioning-curve">
              {/* A cumulative curve KEEPS its zero baseline: it starts at 0% by construction, and
                  clipping the axis would misrepresent how much of the cohort came online early. */}
              <TrendChart
                data={curve}
                height={220}
                format="percent"
                seriesName="Cumulative online"
              />
            </div>
            <p className="mt-3 text-[11px] text-ink-muted" data-testid="commissioning-curve-basis">
              Cumulative % online, over {resolution?.curveFitments ?? 0} fitting events old enough to be graded
              ({resolution?.sampleSize ?? 0} measured, {resolution?.neverOnline ?? 0} never online).{' '}
              {(resolution?.preEpochExcluded ?? 0) > 0 &&
                `${resolution?.preEpochExcluded} pre-epoch fitting events are excluded whatever they did — their first-report stamp measures when the column shipped, not the install. `}
              {(report ? report.totals.fitments - (resolution?.maturedFitments ?? 0) : 0) > 0 &&
                `${report!.totals.fitments - (resolution?.maturedFitments ?? 0)} are younger than ${resolution?.maturityHours} h and cannot be graded yet.`}
            </p>
          </>
        ) : (
          <EmptyState message="No fitting event in this window is both old enough and recent enough to time. The curve needs fitting events older than the grace window and newer than the first-report epoch." />
        )}
      </ChartCard>

      <ChartCard title="Install quality — worst never-online rate" className="mb-5">
        {quality && quality.rows.length ? (
          <DataTable
            columns={qualityColumns}
            rows={quality.rows.slice(0, 10)}
            rowKey={(r) => r.installerKey ?? 'unattributed'}
            rowTestId={(r) => `iq-row-${r.installerKey ?? 'unattributed'}`}
            ariaLabel="Install quality by installer"
            downloadable={false}
            empty={<EmptyState message="No installer meets the minimum install count." />}
          />
        ) : (
          <EmptyState message="No install-quality rows for the current scope." />
        )}
      </ChartCard>

      <ChartCard title="By plant" className="mb-5">
        {/* Stated once, beside the table whose numbers it explains. The cohort counts fitting events;
            the device list this links into counts devices. Measured, 6.4% of cohort devices carry more
            than one fitting event in 90 days, so the two totals legitimately differ — and a reader who
            has not been told will read that as a bug. */}
        <p className="mb-3 text-[11px] text-ink-muted" data-testid="commissioning-grain-note">
          Counts are <strong>fitting events</strong> — one per (device, vehicle, install date). A
          device re-mapped twice in this window is two fitting events here and one row on the device
          list.
        </p>
        <DataTable
          columns={plantColumns}
          rows={report?.byPlant ?? []}
          rowKey={(r) => r.plantId}
          rowTestId={(r) => `cc-plant-${r.plantId}`}
          ariaLabel="Commissioning cohort by plant"
          exportName="commissioning-cohort-by-plant"
          empty={<EmptyState message="No fitting events at any plant in this window." />}
        />
      </ChartCard>

      <ChartCard title="By installer" className="mb-5">
        <DataTable
          columns={installerColumns}
          rows={report?.byInstaller ?? []}
          rowKey={(r) => r.installerKey ?? 'unattributed'}
          rowTestId={(r) => `cc-installer-${r.installerKey ?? 'unattributed'}`}
          ariaLabel="Commissioning cohort by installer"
          exportName="commissioning-cohort-by-installer"
          empty={<EmptyState message="No fitting events carry an installer in this window." />}
        />
        {/* Stated on the page, not just in a code comment. These logins resolve against no user master
            on either side, so the page must not be read as a technician leaderboard. */}
        <p className="mt-3 text-[11px] text-ink-muted" data-testid="commissioning-installer-caveat">
          Installer values are login strings from AutoPlant with no user master behind them. Service
          accounts and unresolved logins are shown and labelled, never ranked as people.
        </p>
      </ChartCard>

      {/* #236 — the cohort's own device list, not just a link to one. `commissionedWithinDays` is the
          only scope carried over from the aggregates above: `GET /api/devices` has no population
          predicate (that concept lives only in the commissioning aggregation SQL, #233), so applying
          "operational vs all" here would mean a second, independent definition of it living in the
          browser — the exact defect class #232–234 exist to prevent. Stated below, not left for a
          reader to discover by reconciling counts that will not match. */}
      <div ref={deviceListRef} className="mb-5">
        <DataTable
          columns={deviceColumns}
          rows={deviceRows}
          rowKey={(r) => r.deviceId}
          rowTestId={(r) => `cc-device-row-${r.deviceId}`}
          ariaLabel="Commissioning cohort devices"
          downloadable={false}
          error={deviceError}
          onRetry={() => setAssignedToken((t) => t + 1)}
          toolbarTitle={
            <span className="flex items-baseline gap-2">
              Devices
              <span className="text-[11px] font-medium normal-case tracking-normal text-ink-muted tabular-nums">
                {deviceTotal === 0 ? 'No devices' : `Showing ${nf.format(deviceFromRow)}–${nf.format(deviceToRow)} of ${nf.format(deviceTotal)}`}
              </span>
            </span>
          }
          toolbar={
            <>
              <SearchInput
                aria-label="Search devices"
                value={deviceSearchInput}
                onChange={(e) => setDeviceSearchInput(e.target.value)}
                placeholder="Device, vehicle, company or plant…"
                className="w-56"
              />
              <FilterSelect aria-label="Sort devices" value={deviceSort} onChange={(e) => setDeviceSort(e.target.value as DeviceSort)}>
                {DEVICE_SORT_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    Sort: {o.label}
                  </option>
                ))}
              </FilterSelect>
              <FilterSelect aria-label="Device status" value={deviceStatus} onChange={(e) => setDeviceStatus(e.target.value as DeviceStatusFilter)}>
                <option value="ALL">All statuses</option>
                <option value="ACTIVE">Active only</option>
                <option value="INACTIVE">Inactive only</option>
                <option value="NEVER_REPORTED">Never reported</option>
              </FilterSelect>
            </>
          }
          empty={<EmptyState message="No devices for the current scope." />}
        />
        <p className="mt-2 text-[11px] text-ink-muted" data-testid="commissioning-device-scope-note">
          Scoped to the last {cohortDays} days only — this list does not apply the population filter
          above (operational vs all), because the device list has no such predicate. See the census
          line for the operational/warehouse split.
        </p>
        {devicePlantFilter && (
          <div className="mt-2 flex items-center gap-2">
            <span
              data-testid="cc-device-plant-chip"
              className="rounded-full border border-brand-600/30 bg-brand-600/10 px-2.5 py-1 text-[12px] text-ink-strong"
            >
              Filtered to {devicePlantFilter.name}
            </span>
            <button
              type="button"
              data-testid="cc-device-plant-clear"
              onClick={() => setDevicePlantFilter(null)}
              className="text-[12px] text-ink-muted underline-offset-2 hover:underline focus-ring rounded"
            >
              Clear
            </button>
          </div>
        )}
        {deviceTotal > DEVICE_PAGE_SIZE && (
          <nav aria-label="Device list pages" className="mt-3 flex items-center justify-between gap-3">
            <Button
              size="sm"
              variant="secondary"
              data-testid="cc-device-page-prev"
              disabled={devicePage === 0}
              onClick={() => setDevicePage((p) => Math.max(0, p - 1))}
            >
              ‹ Prev
            </Button>
            <span data-testid="cc-device-page-status" className="text-xs text-ink-muted tabular-nums">
              Page {nf.format(devicePage + 1)} of {nf.format(devicePageCount)}
            </span>
            <Button
              size="sm"
              variant="secondary"
              data-testid="cc-device-page-next"
              disabled={devicePage + 1 >= devicePageCount}
              onClick={() => setDevicePage((p) => Math.min(devicePageCount - 1, p + 1))}
            >
              Next ›
            </Button>
          </nav>
        )}
      </div>
    </section>
  );
}

/**
 * Per-row Assign SE control (#236) — the `CriticalQueue.tsx` `AssignControl` pattern, applied to the
 * device's OPEN TICKET rather than a plant cluster. A device with no live ticket has nothing to assign
 * — #229's auto-recovery has never run, so a fitment that failed to report can sit with no ticket at
 * all — and a control that silently no-ops there would be worse than no control. That branch says so.
 */
function DeviceAssignControl({
  row,
  engineers,
  onAssigned,
}: {
  row: DeviceListRow;
  engineers: ZoneEngineer[];
  onAssigned: () => void;
}) {
  const [seId, setSeId] = useState('');
  const [busy, setBusy] = useState(false);
  // #249 — the assign the backend refused because the vehicle is not back yet, held until the manager
  // states a reason or backs out. Per row: each device's hold is its own decision.
  const [conflict, setConflict] = useState<DeferralConflict | null>(null);

  if (row.assignmentState === 'FORMALLY_ASSIGNED') {
    return (
      <span className="flex flex-col gap-0.5" data-testid={`cc-assign-state-${row.deviceId}`}>
        <Badge tone="success">Assigned</Badge>
        {row.assignedSeName && <span className="text-xs text-ink-muted">{row.assignedSeName}</span>}
      </span>
    );
  }

  if (!row.openTicketId || row.assignmentState !== 'UNASSIGNED') {
    return (
      <span className="text-xs text-ink-muted" data-testid={`cc-assign-state-${row.deviceId}`}>
        No open ticket
      </span>
    );
  }

  const ticketId = row.openTicketId;
  const assign = async (deferral?: { confirm: boolean; reasonCode: string }) => {
    if (!seId) return;
    setBusy(true);
    try {
      await apiAssignTicket(ticketId, seId, deferral);
      setConflict(null);
      onAssigned();
    } catch (e) {
      if (e instanceof DeferralConflictError) {
        setConflict(e.conflict);
        return;
      }
      throw e;
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-1.5" data-testid={`cc-assign-control-${row.deviceId}`}>
      {conflict && (
        <DeferralConfirm
          conflict={conflict}
          busy={busy}
          onConfirm={(reasonCode) => void assign({ confirm: true, reasonCode })}
          onCancel={() => setConflict(null)}
        />
      )}
      <div className="flex items-center gap-1.5">
        <FilterSelect
          aria-label={`Assign SE for ${row.deviceId}`}
          value={seId}
          onChange={(e) => setSeId(e.target.value)}
          className="h-8 text-xs"
        >
          <option value="">Select SE…</option>
          {/* #269 — same `n/cap` vocabulary as the other assign pickers; marked, never blocked. */}
          {engineers.map((e) => (
            <option key={e.engineerId} value={e.engineerId}>
              {engineerOptionLabel(e)}
            </option>
          ))}
        </FilterSelect>
        <Button
          size="sm"
          data-testid={`cc-assign-btn-${row.deviceId}`}
          disabled={seId === '' || busy}
          loading={busy}
          onClick={() => void assign()}
        >
          Assign
        </Button>
      </div>
    </div>
  );
}
