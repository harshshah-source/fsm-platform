import { useEffect, useMemo, useState } from 'react';
import { apiRootCause, REPORT_FILTER_FIELDS, type RootCauseReport } from '../../api/reports';
import { BarChartCard, ChartCard, ReportGrid, type BarDatum } from '../../components/charts';
import { DataTable, EmptyState, MetricStrip, PageHeader, type Column, type Metric } from '../../components/data';
import { ReportMetaStrip } from './DataAsOfStamp';
import { ReportFilterBar, ReportScope, useReportFilterOptions, useReportFilters } from './ReportFilterBar';

/** Human-readable label for a structured root-cause category enum value. */
const humanize = (c: string) => c.split('_').map((w) => w[0] + w.slice(1).toLowerCase()).join(' ');

const FIELDS = REPORT_FILTER_FIELDS.rootCause;

/**
 * FE-23 — Root-Cause Analytics (ref 23). KPI strip + a multi-colour distribution `BarChartCard`
 * (root cause → %) + a breakdown `DataTable` (cause → tickets / share), all from the Issue 41
 * `/reports/root-cause` endpoint (structured categories from troubleshoot forms). Manager-scoped
 * (ZM own-zone server-side). Presentation-only — no aggregation logic here.
 *
 * #364 — the endpoint has accepted from / to / zone / company / plant / deviceType / SE since Issue 41
 * and this page asked for none of it. `from`/`to` are **months** here (`root_cause_summary_monthly`,
 * `parseMonth`), which is why the range control is a month picker rather than the day picker System
 * Efficiency uses; the wrong granularity is a 400, not a coerced value.
 */
export function RootCauseAnalyticsPage() {
  const [report, setReport] = useState<RootCauseReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { filters, set, clear, active } = useReportFilters();

  // Declared AFTER the report effect below so the report request is the first one this page makes:
  // the option lists are decoration and must not queue ahead of the number the reader came for.
  const params = useMemo(
    () => ({
      from: filters.from,
      to: filters.to,
      zoneId: filters.zoneId,
      companyId: filters.companyId,
      plantId: filters.plantId,
      deviceType: filters.deviceType,
      seId: filters.seId,
    }),
    [filters],
  );

  useEffect(() => {
    let live = true;
    setError(null);
    apiRootCause(params)
      .then((r) => live && setReport(r))
      .catch(() => live && setError('Failed to load Root-Cause Analytics'));
    return () => {
      live = false;
    };
  }, [params]);

  const options = useReportFilterOptions(FIELDS);

  const loading = report === null && error === null;
  const slices = report?.distribution ?? [];

  const bars: BarDatum[] = useMemo(() => slices.map((s) => ({ name: humanize(s.category), value: s.pct })), [slices]);

  const topCause = useMemo(() => slices.reduce<RootCauseReport['distribution'][number] | null>((top, s) => (!top || s.count > top.count ? s : top), null), [slices]);

  const metrics: Metric[] = [
    { label: 'Total Submissions', value: report?.totalSubmissions ?? '—', hint: 'In the reporting window', tone: 'info' },
    { label: 'Distinct Causes', value: slices.filter((s) => s.count > 0).length || '—', hint: 'With ≥1 submission', tone: 'neutral' },
    { label: 'Top Cause', value: topCause ? humanize(topCause.category) : '—', hint: topCause ? `${topCause.pct}% of submissions` : 'No data', tone: 'warning' },
  ];

  const columns: Column<RootCauseReport['distribution'][number]>[] = [
    { key: 'cause', header: 'Root cause', render: (r) => humanize(r.category) },
    { key: 'count', header: 'Tickets', align: 'right', render: (r) => r.count },
    { key: 'pct', header: 'Share', align: 'right', render: (r) => `${r.pct}%` },
  ];

  return (
    <section>
      <PageHeader
        title="Root-Cause Analytics"
        subtitle="Structured root-cause distribution from SE troubleshoot forms — no free-text parsing. Zone-scoped for ZM, cross-zone for CSM / Operations Head."
      />

      {/* #347 — the reference header band (ref 23) carries a "Data as of" stamp; this page had none
          at all, so its monthly cube could be arbitrarily old with nothing on screen saying so.
          #364 — the filter controls ride on the band's second line, and the scope chip is the
          SERVER's echoed zone, so a clamped ZM sees the zone the numbers are actually from. */}
      <ReportMetaStrip
        testId="root-cause-meta"
        dataAsOf={report?.dataAsOf}
        loading={loading}
        stampTestId="root-cause-data-as-of"
        filters={
          <ReportFilterBar
            testId="root-cause-filters"
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
          testId="root-cause-scope"
          requestedZoneId={filters.zoneId}
          echoedZoneId={report?.filters?.zoneId}
          zones={options.zones}
        />
      </ReportMetaStrip>

      {error && (
        <div role="alert" className="mb-4 rounded-md border border-critical/30 bg-critical-bg px-3 py-2 text-sm text-critical">
          {error}
        </div>
      )}
      {loading && <p className="mb-4 text-sm text-ink-muted">Loading analytics…</p>}

      <MetricStrip cols={3} metrics={metrics} />

      <ReportGrid>
        <ChartCard title="Distribution by root cause">
          {/* Ranked: the question is which root cause dominates, so the biggest belongs at the top. */}
          {bars.length ? <BarChartCard data={bars} sort="desc" /> : <EmptyState message="No troubleshoot submissions in this window." />}
        </ChartCard>
      </ReportGrid>

      <ChartCard title="Breakdown" className="mb-5">
        <DataTable
          columns={columns}
          rows={slices}
          rowKey={(r) => r.category}
          rowTestId={(r) => `rc-row-${r.category}`}
          ariaLabel="Root cause breakdown"
          empty={<EmptyState message="No root-cause data for the current scope." />}
        />
        {/*
          #364 AC3 — the one report table on these four pages with NO drill-down link, deliberately.
          A root-cause row's rows are the troubleshoot submissions in that category, and nothing in
          this repo lists them: `GET /tickets` takes status / workType / company / plant / plant-text /
          q / assignmentState / bucket / special and has no `rootCause` parameter
          (`ticketing/tickets.controller.ts:46-56`), and Ops Explorer has no submissions dataset
          (`ops-explorer/dataset-registry.ts` — devices, zones, companies, plants, vehicles, engineers,
          tickets, batches, dispatchRuns, recommendations, auditLogs). The plan's `/tickets?rootCause=`
          target does not exist. A link to a list that ignores the filter is worse than no link — it
          shows the reader a different population under the number they clicked — so this says what is
          missing instead. Closing it is a backend change (`root_cause_category` on the ticket query),
          which this slice does not own.
        */}
        <p className="mt-3 text-xs text-ink-muted">
          Filter the whole report by zone, company, plant, device type or engineer to interrogate a
          cause. A per-submission drill-down needs a root-cause filter on the ticket list, which the
          API does not offer yet.
        </p>
      </ChartCard>
    </section>
  );
}
