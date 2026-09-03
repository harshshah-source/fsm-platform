import { useEffect, useMemo, useState } from 'react';
import { apiZmScorecard, type ZmScorecardReport, type ZmScorecardRow } from '../../api/reports';
import { ChartCard } from '../../components/charts';
import { DataTable, EmptyState, PageHeader, type Column } from '../../components/data';
import { SectionCard } from '../../components/ui';
import { ReportMetaStrip } from './DataAsOfStamp';

/**
 * FE-25 — ZM Performance Scorecard (ref 25). A leader card (top ZM by zone Fleet-Uptime compliance) +
 * the scorecard `DataTable` (ZM → overrides / override-rate / manual assignments / zone SLA compliance)
 * over the Issue 43 `/reports/zm-scorecard` endpoint. **Operations-Head only** — the route (RoleRoute)
 * and the backend `@Roles('OPERATIONS_HEAD')` both gate it; never shown to a ZM. Presentation-only.
 */
export function ZmScorecardPage() {
  const [report, setReport] = useState<ZmScorecardReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiZmScorecard()
      .then(setReport)
      .catch(() => setError('Failed to load the ZM Performance Scorecard'));
  }, []);

  const loading = report === null && error === null;
  const rows = report?.rows ?? [];

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

  const columns: Column<ZmScorecardRow>[] = [
    { key: 'zm', header: 'Zonal Manager', render: (r) => r.zmName },
    { key: 'zone', header: 'Zone', render: (r) => r.zoneName },
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
          ranking is belongs on it, and "no cube computed yet" is a real answer for a fresh month. */}
      <ReportMetaStrip dataAsOf={report?.dataAsOf} loading={loading} stampTestId="zm-scorecard-data-as-of" />

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
    </section>
  );
}
