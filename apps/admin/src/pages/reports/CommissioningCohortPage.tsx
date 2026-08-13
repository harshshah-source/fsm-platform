import { useEffect, useMemo, useState } from 'react';
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
import { BarList, ChartCard, ReportGrid, type BarListItem } from '../../components/charts';
import {
  DataTable,
  EmptyState,
  FilterBar,
  FilterSelect,
  MetricStrip,
  PageHeader,
  type Column,
  type Metric,
} from '../../components/data';

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
  { value: 'all', label: 'All fitments (incl. warehouse)' },
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

  const loading = report === null && error === null;
  const totals = report?.totals;
  const census = report?.population;
  const resolution = report?.resolution;

  const metrics: Metric[] = [
    {
      label: 'Fitments',
      value: totals?.fitments ?? '—',
      hint: `Commissioning events in the last ${cohortDays} days`,
      tone: 'info',
      kpi: 'commissioningFitments',
      testId: 'kpi-fitments',
    },
    {
      label: 'Came Online',
      value: totals?.online ?? '—',
      hint: totals ? `${pct(totals.online, totals.fitments)} of fitments` : 'First GPS fix received',
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
      // fitments than the count beside it, and a reader who cannot see that will over-trust it.
      hint: totals ? `n = ${totals.ttfr.sampleSize} measurable fitments` : 'Post-epoch fitments only',
      tone: 'brand',
      kpi: 'commissioningTtfr',
      testId: 'kpi-ttfr',
    },
  ];

  const curve: BarListItem[] = useMemo(
    () =>
      (resolution?.buckets ?? [])
        .filter((b) => b.cumulativeOnlinePct !== null)
        .map((b) => ({ id: `curve-${b.upToHours}`, label: `within ${b.upToHours} h`, value: b.cumulativeOnlinePct ?? 0 })),
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
        <Link
          to={`/reports/device?plantId=${r.plantId}&commissionedWithinDays=${cohortDays}`}
          data-testid={`cc-plant-link-${r.plantId}`}
          className="text-brand-600 hover:underline focus-ring rounded"
        >
          {r.plantName}
        </Link>
      ),
      // The export must carry the plant NAME, not the link markup.
      exportValue: (r) => r.plantName,
      sortable: true,
      sortValue: (r) => r.plantName,
    },
    { key: 'fitments', header: 'Fitments', align: 'right', sortable: true, sortValue: (r) => r.fitments, render: (r) => r.fitments },
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
    { key: 'fitments', header: 'Fitments', align: 'right', sortable: true, sortValue: (r) => r.fitments, render: (r) => r.fitments },
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

      {/* Every drop between "fitments AutoPlant recorded" and "fitments this page measures" is named.
          Without it a reader reconciling against the source concludes the page is broken — and before
          #233 the page would have been: warehouse devices were counted as failed installs. */}
      {census && (
        <p className="mb-4 text-[12px] text-ink-muted" data-testid="commissioning-census">
          {census.fitmentsInWindow} fitments in window ={' '}
          <strong className="text-ink-strong">{census.operational} operational</strong> + {census.warehouse} warehouse +{' '}
          {census.deactivatedPlant} on deactivated plants + {census.unmirrored} unmirrored.
          {population === 'operational' && ' Warehouse devices are silent because they are in a warehouse, not because an install failed.'}
        </p>
      )}

      <ReportGrid>
        <ChartCard title="How fast this cohort came online">
          {curve.length ? (
            <>
              <BarList items={curve} labelWidth="w-24" />
              <p className="mt-3 text-[11px] text-ink-muted" data-testid="commissioning-curve-basis">
                Cumulative % online, over {resolution?.curveFitments ?? 0} fitments old enough to be graded
                ({resolution?.sampleSize ?? 0} measured, {resolution?.neverOnline ?? 0} never online).{' '}
                {(resolution?.preEpochExcluded ?? 0) > 0 &&
                  `${resolution?.preEpochExcluded} pre-epoch fitments are excluded whatever they did — their first-report stamp measures when the column shipped, not the install. `}
                {(report ? report.totals.fitments - (resolution?.maturedFitments ?? 0) : 0) > 0 &&
                  `${report!.totals.fitments - (resolution?.maturedFitments ?? 0)} are younger than ${resolution?.maturityHours} h and cannot be graded yet.`}
              </p>
            </>
          ) : (
            <EmptyState message="No fitment in this window is both old enough and recent enough to time. The curve needs fitments older than the grace window and newer than the first-report epoch." />
          )}
        </ChartCard>

        <ChartCard title="Install quality — worst never-online rate">
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
      </ReportGrid>

      <ChartCard title="By plant" className="mb-5">
        {/* Stated once, beside the table whose numbers it explains. The cohort counts fitments; the
            device list this links into counts devices. Measured, 6.4% of cohort devices carry more
            than one fitment in 90 days, so the two totals legitimately differ — and a reader who has
            not been told will read that as a bug. */}
        <p className="mb-3 text-[11px] text-ink-muted" data-testid="commissioning-grain-note">
          Counts are <strong>fitments</strong> — one per (device, vehicle, install date). A device
          re-mapped twice in this window is two fitments here and one row on the device list.
        </p>
        <DataTable
          columns={plantColumns}
          rows={report?.byPlant ?? []}
          rowKey={(r) => r.plantId}
          rowTestId={(r) => `cc-plant-${r.plantId}`}
          ariaLabel="Commissioning cohort by plant"
          exportName="commissioning-cohort-by-plant"
          empty={<EmptyState message="No fitments at any plant in this window." />}
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
          empty={<EmptyState message="No fitments carry an installer in this window." />}
        />
        {/* Stated on the page, not just in a code comment. These logins resolve against no user master
            on either side, so the page must not be read as a technician leaderboard. */}
        <p className="mt-3 text-[11px] text-ink-muted" data-testid="commissioning-installer-caveat">
          Installer values are login strings from AutoPlant with no user master behind them. Service
          accounts and unresolved logins are shown and labelled, never ranked as people.
        </p>
      </ChartCard>
    </section>
  );
}
