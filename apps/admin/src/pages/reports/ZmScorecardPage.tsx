import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  apiZmScorecard,
  monthDayRange,
  REPORT_FILTER_FIELDS,
  type ZmScorecardReport,
  type ZmScorecardRow,
  type ZmScorecardSeries,
  type ZmScorecardTrendPoint,
} from '../../api/reports';
import { ChartCard, ChartSegmentedControl, TrendChart, type TrendDatum } from '../../components/charts';
import { DataTable, EmptyState, PageHeader, type Column } from '../../components/data';
import { SectionCard } from '../../components/ui';
import { ReportMetaStrip } from './DataAsOfStamp';
import { ReportFilterBar, ReportScope, useReportFilterOptions, useReportFilters } from './ReportFilterBar';

const FIELDS = REPORT_FILTER_FIELDS.zmScorecard;

/** Which series of a {@link ZmScorecardTrendPoint} the trend panel is drawing. */
type TrendMetric = 'overrideRatePct' | 'overrides' | 'manualAssignments' | 'zoneSlaCompliancePct';

const TREND_METRICS: { value: TrendMetric; label: string; percent: boolean }[] = [
  { value: 'overrideRatePct', label: 'Override rate', percent: true },
  { value: 'overrides', label: 'Overrides', percent: false },
  { value: 'manualAssignments', label: 'Manual assigns', percent: false },
  { value: 'zoneSlaCompliancePct', label: 'Zone SLA', percent: true },
];

/** `2026-04-01` → `Apr 26`. The cube's `month` column is a first-of-month date, not a `YYYY-MM`. */
function monthLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' })} ${String(d.getUTCFullYear()).slice(2)}`;
}

/**
 * FE-25 — ZM Performance Scorecard (ref 25). A leader card (top ZM by zone Fleet-Uptime compliance) +
 * the scorecard `DataTable` (ZM → overrides / override-rate / manual assignments / zone SLA compliance)
 * over the Issue 43 `/reports/zm-scorecard` endpoint. **Operations-Head only** — the route (RoleRoute)
 * and the backend `@Roles('OPERATIONS_HEAD')` both gate it; never shown to a ZM. Presentation-only.
 *
 * #364 — two things this page had and did not use. The endpoint takes `from`/`to` **months** and a
 * `zoneId` drill-down, and it has computed a per-ZM monthly `trend[]` since Issue 43
 * (`reports.service.ts:540`) that the client typed `unknown[]` and threw away. A scorecard ranks
 * people on a single aggregate; without the trend it cannot tell a ZM whose override rate is high and
 * falling from one whose is high and climbing, and only one of those is a problem to act on.
 */
export function ZmScorecardPage() {
  const [report, setReport] = useState<ZmScorecardReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { filters, set, clear, active } = useReportFilters();

  const params = useMemo(
    () => ({ from: filters.from, to: filters.to, zoneId: filters.zoneId }),
    [filters],
  );

  useEffect(() => {
    let live = true;
    setError(null);
    apiZmScorecard(params)
      .then((r) => live && setReport(r))
      .catch(() => live && setError('Failed to load the ZM Performance Scorecard'));
    return () => {
      live = false;
    };
  }, [params]);

  const options = useReportFilterOptions(FIELDS);

  const loading = report === null && error === null;
  const rows = report?.rows ?? [];
  const trend: ZmScorecardSeries[] = report?.trend ?? [];

  /**
   * The scorecard's month range as the DAY range `/reports/efficiency` parses, taken from the
   * report's own echoed `fromMonth`/`toMonth` rather than the URL — the echo is what the numbers on
   * screen were actually computed over, and it is what a drill-down link must carry.
   */
  const dayRange = useMemo(() => {
    if (!report) return null;
    const from = report.fromMonth.slice(0, 10);
    const to = monthDayRange(report.toMonth.slice(0, 7)).to;
    return { from, to };
  }, [report]);

  /**
   * Leader: the ZM with the highest zone Fleet-Uptime compliance over the range.
   *
   * #346 — a zone with no eligible device-time has `zoneSlaCompliancePct === null` (it used to be
   * `100`, which crowned the emptiest zone as the best-run one). Such rows are not candidates at all:
   * "we have no measurement" is not a score, and with no measured zone in the range there is no top
   * performer to name and the card does not render.
   */
  const leader = useMemo(
    () =>
      rows
        .filter((r): r is ZmScorecardRow & { zoneSlaCompliancePct: number } => r.zoneSlaCompliancePct !== null)
        .reduce<(ZmScorecardRow & { zoneSlaCompliancePct: number }) | null>(
          (top, r) => (!top || r.zoneSlaCompliancePct > top.zoneSlaCompliancePct ? r : top),
          null,
        ),
    [rows],
  );

  const [seriesId, setSeriesId] = useState<string>('');
  const [metric, setMetric] = useState<TrendMetric>('overrideRatePct');
  const series = trend.find((s) => s.zmId === seriesId) ?? trend[0] ?? null;
  const metricSpec = TREND_METRICS.find((m) => m.value === metric)!;

  // `null` is a GAP, not a zero (#346, #347): a month with no eligible device-time has no compliance
  // figure, and the line must break over it rather than dive to 0 or sit at 100.
  const points: TrendDatum[] = useMemo(
    () =>
      (series?.points ?? []).map((p: ZmScorecardTrendPoint) => ({
        label: monthLabel(p.month),
        value: p[metric],
      })),
    [series, metric],
  );

  const columns: Column<ZmScorecardRow>[] = [
    { key: 'zm', header: 'Zonal Manager', render: (r) => r.zmName },
    {
      key: 'zone',
      header: 'Zone',
      // #364 AC3 — the decision activity behind an override count is the zone's efficiency report over
      // the SAME range. The scorecard is month-grained and `/reports/efficiency` is day-grained, so the
      // months are widened to their first and last day; a drill-down that silently resets the window
      // answers a different question from the one that was clicked.
      render: (r) => (
        <Link
          to={`/reports/system-efficiency?zoneId=${r.zoneId}${dayRange ? `&from=${dayRange.from}&to=${dayRange.to}` : ''}`}
          className="font-medium text-brand-700 underline-offset-2 hover:underline focus-ring"
          title="This zone's efficiency over the same range"
        >
          {r.zoneName}
        </Link>
      ),
    },
    { key: 'overrides', header: 'Overrides', align: 'right', render: (r) => r.overrides },
    { key: 'overrideRate', header: 'Override rate', align: 'right', render: (r) => `${r.overrideRatePct}%` },
    { key: 'manual', header: 'Manual assigns', align: 'right', render: (r) => r.manualAssignments },
    {
      key: 'sla',
      header: 'Zone SLA',
      align: 'right',
      // #346 — no eligible device-time means no compliance figure; an em dash, never a fabricated 100.
      render: (r) =>
        r.zoneSlaCompliancePct === null ? (
          <span className="text-ink-muted">—</span>
        ) : (
          <span className="font-medium text-ink-strong">{r.zoneSlaCompliancePct}%</span>
        ),
    },
  ];

  return (
    <section>
      <PageHeader
        title="ZM Performance Scorecard"
        subtitle="Zonal-Manager decision activity vs zone Fleet-Uptime outcomes — override behaviour, manual assignments and SLA compliance. Operations-Head view."
      />

      {/* #347 — ref 25's header band. People are ranked on this page; how old the cube behind the
          ranking is belongs on it, and "no cube computed yet" is a real answer for a fresh month.
          #364 — the month range and the zone drill-down join it. This report is OH-only, so the zone
          is a drill-down rather than a clamp and the chip reads "All India" when none is applied. */}
      <ReportMetaStrip
        testId="zm-scorecard-meta"
        dataAsOf={report?.dataAsOf}
        loading={loading}
        stampTestId="zm-scorecard-data-as-of"
        filters={
          <ReportFilterBar
            testId="zm-scorecard-filters"
            fields={FIELDS}
            filters={filters}
            set={set}
            clear={clear}
            active={active}
            options={options}
            granularity="month"
          />
        }
      >
        <ReportScope
          testId="zm-scorecard-scope"
          requestedZoneId={filters.zoneId}
          echoedZoneId={report?.zoneId}
          zones={options.zones}
          allLabel="All India"
        />
      </ReportMetaStrip>

      {error && (
        <div role="alert" className="mb-4 rounded-md border border-critical/30 bg-critical-bg px-3 py-2 text-sm text-critical">
          {error}
        </div>
      )}
      {loading && <p className="mb-4 text-sm text-ink-muted">Loading scorecard…</p>}

      {leader && (
        <div className="mb-5 max-w-sm">
          <SectionCard title="Top performer">
            <div data-testid="zm-leader" className="flex flex-col gap-1">
              <span className="text-lg font-semibold text-ink-strong">{leader.zmName}</span>
              <span className="text-sm text-ink-muted">
                {leader.zoneName} · {leader.zoneSlaCompliancePct}% zone Fleet-Uptime · {leader.overrideRatePct}% override rate
              </span>
            </div>
          </SectionCard>
        </div>
      )}

      <ChartCard title="Scorecard" className="mb-5">
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(r) => r.zmId}
          rowTestId={(r) => `zm-row-${r.zmId}`}
          ariaLabel="ZM scorecard"
          empty={<EmptyState message="No ZM performance data for the current range." />}
        />
      </ChartCard>

      {/* #364 AC2 — the monthly trend the backend has always computed and the client discarded. */}
      <ChartCard title="Monthly trend" className="mb-5">
        <div data-testid="zm-trend" data-series={series?.zmId ?? ''} data-metric={metric}>
          {series === null ? (
            <EmptyState message="No monthly trend for this range — the ZM performance cube has no rows in it." />
          ) : (
            <>
              <div className="mb-3 flex flex-wrap items-center gap-3">
                <label className="flex items-center gap-2 text-xs text-ink-muted">
                  <span className="font-semibold uppercase tracking-wider text-ink-caps">Trend for</span>
                  <select
                    aria-label="Trend for"
                    value={series.zmId}
                    onChange={(e) => setSeriesId(e.target.value)}
                    className="h-8 rounded-md border border-line bg-surface-card px-2 text-[12px] text-ink-strong shadow-sm hover:border-line-strong focus-visible:border-brand-600 focus-ring"
                  >
                    {trend.map((s) => (
                      <option key={s.zmId} value={s.zmId}>{s.zmName}</option>
                    ))}
                  </select>
                </label>
                {/* The metric switch is client-side: the whole series for every ZM already arrived
                    with the report, so re-asking the server for a column it already sent would be a
                    round trip that can only return the same numbers. */}
                <ChartSegmentedControl
                  ariaLabel="Trend metric"
                  value={metric}
                  onChange={setMetric}
                  options={TREND_METRICS.map((m) => ({ value: m.value, label: m.label }))}
                />
              </div>

              <TrendChart
                data={points}
                seriesName={`${series.zmName} · ${metricSpec.label}`}
                format={metricSpec.percent ? 'percent' : 'count'}
                zeroBaseline={!metricSpec.percent}
              />

              {/*
                The chart is an SVG with no text alternative, and in a headless renderer it measures
                0×0 and draws nothing at all. This table is the series in words: the same numbers, for
                a screen reader and for anyone reading a printed report.
              */}
              <table className="sr-only" aria-label={`${series.zmName} monthly ${metricSpec.label.toLowerCase()}`}>
                <thead>
                  <tr><th>Month</th><th>{metricSpec.label}</th></tr>
                </thead>
                <tbody>
                  {points.map((p) => (
                    <tr key={p.label}>
                      <td>{p.label}</td>
                      <td>{p.value === null ? 'no data' : `${p.value}${metricSpec.percent ? '%' : ''}`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </div>
      </ChartCard>
    </section>
  );
}
