import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  apiSeProductivity,
  formatRate,
  formatStageDuration,
  seMetricTone,
  weekStart,
  SE_COVERAGE_LABEL,
  SE_PRODUCTIVITY_BANDS,
  type SeCoverageFilter,
  type SeMetricTone,
  type SeProductivityGranularity,
  type SeProductivityReport,
  type SeProductivityRow,
} from '../../api/reports';
import { DataTable, EmptyState, PageHeader, type Column } from '../../components/data';
import { ReportMetaStrip } from './DataAsOfStamp';
import { ReportFilterBar, ReportScope, useReportFilterOptions, useReportFilters } from './ReportFilterBar';

/**
 * **SE Productivity** (#365, PRD story 25) — the approved design is
 * `docs/ui/desktop/approved-designs/se-productivity-report.html`; `21-reports.png` governs the chrome
 * around it. No v2 image was ever drawn for this screen, so that file is its reference and this page
 * follows it rather than reinterpreting it.
 *
 * **A filterable roster table, one row per engineer** (decision #368). The question a manager brings
 * here is *which of my engineers needs attention*, and a table answers it in one read; a per-SE
 * scorecard makes you already know the name before you can look it up, which makes it the wrong first
 * screen. The filter bar and the freshness band are #364's and #347's, not new ones — the band is what
 * states the scope of the numbers under it, so the controls that set that scope belong in it.
 *
 * Three things about this page are constraints, not styling:
 *
 * **1. Repair and Departure are separate columns.** Audit finding F7: `se_repaired_closures` counted
 * every `CLOSED` troubleshoot ticket, including the ones `DeviceDepartureService` closed because a
 * vehicle left the fleet. An engineer whose plants lost vehicles therefore read as more productive
 * than one who repaired devices — and this is the page staffing decisions are made from. The split is
 * the prerequisite for the page existing, not a column choice.
 *
 * **2. Rates are withheld below the small-sample floor** (`report.rateMinSample`, 10). The withholding
 * happens on the server; this page renders the em dash and says why in the footer. Counts are always
 * shown — a count of six is a true fact about six jobs.
 *
 * **3. This is a diagnostic surface, not a league table.** No ranking, no best/worst badge, no
 * whole-row colouring: only individual out-of-band metrics are marked, against the fixed bands in
 * {@link SE_PRODUCTIVITY_BANDS}, so the eye lands on *a number worth asking about* rather than on a
 * person worth blaming. Default order is by name — the server's — and the table is sortable, but it
 * never opens pre-sorted worst-first.
 */
export function SeProductivityPage() {
  const [report, setReport] = useState<SeProductivityReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Zone and month come from #364's shared filter state; the three dimensions only this endpoint has
  // (granularity, week anchor, coverage) sit beside them in the same query string. Both writers use
  // the functional form of `setSearchParams`, so neither clobbers the other's keys.
  const { filters, set, clear: clearShared, active: sharedActive } = useReportFilters();
  const [params, setParams] = useSearchParams();

  const granularity = (params.get('granularity') === 'weekly' ? 'weekly' : 'monthly') as SeProductivityGranularity;
  const coverage = (params.get('coverage') ?? 'all') as SeCoverageFilter;
  const weekOf = params.get('weekOf') ?? '';

  const setOwn = useCallback(
    (key: 'granularity' | 'coverage' | 'weekOf', value: string) => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (value && value !== 'all' && value !== 'monthly') next.set(key, value);
          else next.delete(key);
          // Switching granularity drops the other mode's anchor rather than leaving a stale one in the
          // URL that would silently reappear on the next switch.
          if (key === 'granularity') next.delete(value === 'weekly' ? 'month' : 'weekOf');
          return next;
        },
        { replace: true },
      );
    },
    [setParams],
  );

  const ownActive = granularity !== 'monthly' || coverage !== 'all' || weekOf !== '';
  const clear = useCallback(() => {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        for (const k of ['granularity', 'coverage', 'weekOf']) next.delete(k);
        return next;
      },
      { replace: true },
    );
    clearShared();
  }, [clearShared, setParams]);

  const query = useMemo(
    () => ({
      granularity,
      month: granularity === 'monthly' ? filters.month : null,
      weekOf: granularity === 'weekly' ? weekOf || weekStart() : null,
      zoneId: filters.zoneId,
      coverage,
    }),
    [granularity, filters.month, filters.zoneId, weekOf, coverage],
  );

  useEffect(() => {
    let live = true;
    setError(null);
    apiSeProductivity(query)
      .then((r) => live && setReport(r))
      .catch(() => live && setError('Failed to load the SE Productivity report'));
    return () => {
      live = false;
    };
  }, [query]);

  const options = useReportFilterOptions(ZONE_ONLY);
  const loading = report === null && error === null;
  const rows = Array.isArray(report?.rows) ? report.rows : [];
  const minSample = report?.rateMinSample ?? 10;

  const columns: Column<SeProductivityRow>[] = [
    {
      key: 'name',
      header: 'Engineer',
      sortable: true,
      sortValue: (r) => r.name,
      render: (r) => <span className="font-semibold text-ink-strong">{r.name}</span>,
    },
    {
      key: 'coverage',
      header: 'Coverage',
      sortable: true,
      sortValue: (r) => r.coverageType,
      render: (r) => <span className="text-ink-muted">{SE_COVERAGE_LABEL[r.coverageType] ?? r.coverageType}</span>,
    },
    { key: 'closures', header: 'Closures', align: 'right', sortable: true, sortValue: (r) => r.closures, render: (r) => r.closures },
    {
      key: 'repair',
      header: 'Repair',
      align: 'right',
      sortable: true,
      sortValue: (r) => r.repairClosures,
      render: (r) => r.repairClosures,
    },
    {
      key: 'departure',
      header: 'Departure',
      align: 'right',
      sortable: true,
      sortValue: (r) => r.departureClosures,
      // F7 — shown, never credited. Muted because it is context for the Repair number beside it, not
      // an achievement: these closures happened to the engineer, they were not done by them.
      render: (r) => <span className="text-ink-muted">{r.departureClosures}</span>,
    },
    {
      key: 'ftf',
      header: 'First-time fix',
      align: 'right',
      sortable: true,
      // A withheld rate sorts last in either direction rather than as 0, which would rank a
      // six-closure engineer as the worst in the zone on a number the page refuses to show.
      sortValue: (r) => r.firstTimeFixRatePct ?? -1,
      exportValue: (r) => formatRate(r.firstTimeFixRatePct),
      render: (r) => (
        <MetricCell
          text={formatRate(r.firstTimeFixRatePct)}
          tone={seMetricTone(r.firstTimeFixRatePct, SE_PRODUCTIVITY_BANDS.firstTimeFixPct, 'higherIsBetter')}
          withheld={r.firstTimeFixRatePct === null}
          suppressed={r.ratesSuppressed}
          minSample={minSample}
        />
      ),
    },
    {
      key: 'failedVerification',
      header: 'Failed verif.',
      align: 'right',
      sortable: true,
      sortValue: (r) => r.failedVerificationRatePct ?? -1,
      exportValue: (r) => formatRate(r.failedVerificationRatePct),
      render: (r) => (
        <MetricCell
          text={formatRate(r.failedVerificationRatePct)}
          tone={seMetricTone(r.failedVerificationRatePct, SE_PRODUCTIVITY_BANDS.failedVerificationPct, 'lowerIsBetter')}
          withheld={r.failedVerificationRatePct === null}
          suppressed={r.ratesSuppressed}
          minSample={minSample}
        />
      ),
    },
    {
      key: 'onsiteToSubmit',
      header: 'Avg on-site → submit',
      align: 'right',
      sortable: true,
      sortValue: (r) => r.avgOnsiteToSubmissionSeconds ?? -1,
      exportValue: (r) => formatStageDuration(r.avgOnsiteToSubmissionSeconds),
      render: (r) => (
        <MetricCell
          text={formatStageDuration(r.avgOnsiteToSubmissionSeconds)}
          tone={seMetricTone(
            r.avgOnsiteToSubmissionSeconds,
            SE_PRODUCTIVITY_BANDS.onsiteToSubmissionSeconds,
            'lowerIsBetter',
          )}
          withheld={r.avgOnsiteToSubmissionSeconds === null}
          // Not gated by the closure floor — an average over a stated sample is not a rate.
          suppressed={false}
          minSample={minSample}
          title={r.onsiteToSubmissionCount > 0 ? `over ${r.onsiteToSubmissionCount} visits` : undefined}
        />
      ),
    },
  ];

  return (
    <section>
      <PageHeader
        title="SE Productivity"
        subtitle="One row per engineer — closures split into repairs and departures, first-time-fix and failed-verification rates, and average on-site → submission time. Zone-scoped for ZM, cross-zone for CSM / Operations Head."
      />

      <ReportMetaStrip
        testId="se-productivity-meta"
        dataAsOf={report?.dataAsOf}
        loading={loading}
        stampTestId="se-productivity-data-as-of"
        filters={
          <div className="flex flex-wrap items-end gap-2">
            <ReportFilterBar
              testId="se-productivity-filters"
              fields={ZONE_ONLY}
              filters={filters}
              set={set}
              clear={clear}
              active={sharedActive || ownActive}
              options={options}
              granularity="month"
              singleMonth={granularity === 'monthly'}
            />
            <Field label="Granularity">
              <select
                aria-label="Granularity"
                value={granularity}
                onChange={(e) => setOwn('granularity', e.target.value)}
                className={`${CONTROL} w-28`}
              >
                <option value="monthly">Monthly</option>
                <option value="weekly">Weekly</option>
              </select>
            </Field>
            {granularity === 'weekly' && (
              <Field label="Week of">
                {/* Any day in the week: the server resolves it to that week's Monday, and the window
                    the report echoes is what the footer prints — so the control need not know. */}
                <input
                  type="date"
                  aria-label="Week of"
                  value={weekOf || weekStart()}
                  onChange={(e) => setOwn('weekOf', e.target.value)}
                  className={`${CONTROL} w-32`}
                />
              </Field>
            )}
            <Field label="Coverage">
              <select
                aria-label="Coverage"
                value={coverage}
                onChange={(e) => setOwn('coverage', e.target.value)}
                className={`${CONTROL} w-32`}
              >
                <option value="all">All coverage</option>
                <option value="DEDICATED">Dedicated</option>
                <option value="MULTI_PLANT">Multi-plant</option>
                <option value="FLOATING">Floating</option>
              </select>
            </Field>
          </div>
        }
      >
        {/* The chip renders the server's ECHOED zone, never the local pick: a ZM who picks another
            zone is clamped back to their own, and the chip has to say which zone they are reading. */}
        <ReportScope
          testId="se-productivity-scope"
          requestedZoneId={filters.zoneId}
          echoedZoneId={report?.filters?.zoneId}
          zones={options.zones}
        />
        {report && (
          <span data-testid="se-productivity-window" className="text-ink-muted">
            {report.from} → {report.to}
          </span>
        )}
      </ReportMetaStrip>

      {error && (
        <div role="alert" className="mb-4 rounded-md border border-critical/30 bg-critical-bg px-3 py-2 text-sm text-critical">
          {error}
        </div>
      )}

      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.seId}
        rowTestId={(r) => `se-prod-row-${r.seId}`}
        ariaLabel="SE productivity"
        exportName={`se-productivity-${report?.from ?? ''}`}
        serialNumbers={false}
        loading={loading}
        empty={<EmptyState message="No engineers in this scope for the selected window." />}
      />

      {/* The design's footer strip: what the window covered, and — stated, never implied — the reason
          some rate cells are dashes. A suppressed number with no explanation reads as a bug. */}
      <div
        data-testid="se-productivity-footer"
        className="mt-2 flex flex-wrap justify-between gap-2 rounded-md border border-line bg-surface-card px-3 py-2 text-[11.5px] text-ink-muted"
      >
        <span>
          {report ? `${report.totals.engineers} engineers · ${report.totals.closures} closures in window` : '—'}
          {report && report.totals.departureClosures > 0 && (
            <> · {report.totals.departureClosures} closed by device departure, not repair</>
          )}
        </span>
        <span>Rates suppressed below {minSample} closures</span>
      </div>
    </section>
  );
}

/** This endpoint reads no company / plant / device-type / SE dimension, so the bar offers none. */
const ZONE_ONLY = ['zoneId'] as const;

const CONTROL =
  'h-8 rounded-md border border-line bg-surface-card px-2 text-[12px] text-ink-strong shadow-sm transition-colors ' +
  'hover:border-line-strong focus-visible:border-brand-600 focus-ring';

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-0.5">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-caps">{label}</span>
      {children}
    </label>
  );
}

/**
 * One metric cell. `data-tone` carries the band verdict so the marking is assertable without reading
 * colour, and `data-withheld` distinguishes "no sample" from "below the floor" — the two reasons a
 * cell is an em dash, which look identical on screen and are not the same fact.
 *
 * Nothing here relies on colour alone: a marked value keeps its own title text, and the dash cells
 * carry the reason. The design must survive grayscale.
 */
function MetricCell({
  text,
  tone,
  withheld,
  suppressed,
  minSample,
  title,
}: {
  text: string;
  tone: SeMetricTone;
  withheld: boolean;
  suppressed: boolean;
  minSample: number;
  title?: string;
}) {
  if (withheld) {
    return (
      <span
        data-tone="none"
        data-withheld={suppressed ? 'small-sample' : 'no-data'}
        title={suppressed ? `Withheld: fewer than ${minSample} closures in the window.` : 'Nothing measured in the window.'}
        className="italic text-ink-muted"
      >
        {text}
      </span>
    );
  }
  const cls =
    tone === 'bad' ? 'font-semibold text-critical' : tone === 'warn' ? 'font-semibold text-warning' : 'text-ink-strong';
  return (
    <span
      data-tone={tone}
      title={tone === 'normal' ? title : `Outside the expected band${title ? ` — ${title}` : ''}`}
      className={cls}
    >
      {text}
    </span>
  );
}
