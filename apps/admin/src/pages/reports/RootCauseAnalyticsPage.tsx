import { useEffect, useMemo, useState } from 'react';
import { apiRootCause, type RootCauseReport } from '../../api/reports';
import { BarChartCard, ChartCard, ReportGrid, type BarDatum } from '../../components/charts';
import { DataTable, EmptyState, MetricStrip, PageHeader, type Column, type Metric } from '../../components/data';

/** Human-readable label for a structured root-cause category enum value. */
const humanize = (c: string) => c.split('_').map((w) => w[0] + w.slice(1).toLowerCase()).join(' ');

/**
 * FE-23 — Root-Cause Analytics (ref 23). KPI strip + a multi-colour distribution `BarChartCard`
 * (root cause → %) + a breakdown `DataTable` (cause → tickets / share), all from the Issue 41
 * `/reports/root-cause` endpoint (structured categories from troubleshoot forms). Manager-scoped
 * (ZM own-zone server-side). Presentation-only — no aggregation logic here.
 */
export function RootCauseAnalyticsPage() {
  const [report, setReport] = useState<RootCauseReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiRootCause()
      .then(setReport)
      .catch(() => setError('Failed to load Root-Cause Analytics'));
  }, []);

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
      </ChartCard>
    </section>
  );
}
