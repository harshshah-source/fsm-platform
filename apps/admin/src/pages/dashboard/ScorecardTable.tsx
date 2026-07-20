import { useNavigate } from 'react-router-dom';
import type { ZoneOverviewRow } from '../../api/dashboard';
import { DataTable, type Column } from '../../components/data';
import { SLABadge } from '../../components/domain';
import { criticalOnlyCount, SLA_BUCKETS, type SlaBucket } from '../../lib/slaBucket';
import { formatInactiveOfTotal } from '../../lib/inactiveDuration';

/** The FSM holding-zone name (mirrors the backend `UNZONED_ZONE_NAME`); it has no assigned ZM. */
const UNZONED_ZONE_NAME = 'UNZONED';

/** Worst (most-severe non-zero) bucket in a zone — `SLA_BUCKETS` is in descending severity order. */
function worstBucket(byBucket: Record<string, number>): SlaBucket | null {
  return SLA_BUCKETS.find((b) => (byBucket[b] ?? 0) > 0) ?? null;
}

/**
 * Compact inline uptime meter — a small filled bar plus the percentage in text, colour-graded by health
 * (≥95% good, ≥85% watch, else critical). Sized to sit inside the existing row height (no table growth).
 */
function UptimeMeter({ pct }: { pct: number }) {
  const clamped = Math.max(0, Math.min(100, pct));
  const tone =
    clamped >= 95
      ? { bar: 'bg-success', text: 'text-success' }
      : clamped >= 85
        ? { bar: 'bg-warning', text: 'text-warning' }
        : { bar: 'bg-critical', text: 'text-critical' };
  return (
    <span className="flex items-center justify-end gap-2" title={`Fleet uptime ${clamped.toFixed(2)}% this month`}>
      <span className="h-1.5 w-16 overflow-hidden rounded-full bg-surface-sunken" aria-hidden>
        <span className={`block h-full rounded-full ${tone.bar}`} style={{ width: `${clamped}%` }} />
      </span>
      <span className={`w-12 text-right tabular-nums font-semibold ${tone.text}`}>{clamped.toFixed(1)}%</span>
    </span>
  );
}

/**
 * Zone Performance Scorecard (FE-07, reference 03/04). A cross-zone league table derived from the
 * existing `zone-overview` aggregation — no new endpoint. Shared by the Central Tower (CSM) and
 * Pan-India Fleet Command (OH) variants.
 *
 * Issue 122: a ZONAL MANAGER column follows Zone; the "Critical" column counts strictly the CRITICAL
 * band (matching the KPI). Both the Critical count and the whole row are click-throughs to the device
 * list — the count deep-links to that zone's inactive CRITICAL devices, the row to the whole zone.
 */
export function ScorecardTable({
  rows,
  zoneUptime,
}: {
  rows: ZoneOverviewRow[];
  /** Per-zone current-month uptime %, keyed by zoneId (BE-39 Fleet Uptime report). */
  zoneUptime?: Map<string, number>;
}) {
  const navigate = useNavigate();

  // Deep-link into the Device Detail list (`/reports/device`), pre-filtered from the clicked cell/row.
  const openZoneDevices = (zoneId: string, opts: { criticalOnly?: boolean } = {}) => {
    const params = new URLSearchParams({ zoneId, status: 'INACTIVE' });
    if (opts.criticalOnly) params.set('bucket', 'CRITICAL');
    navigate(`/reports/device?${params.toString()}`);
  };

  const columns: Column<ZoneOverviewRow>[] = [
    {
      key: 'zone',
      header: 'Zone',
      render: (r) => <span className="font-medium text-ink-strong">{r.zoneName}</span>,
      sortable: true,
      sortValue: (r) => r.zoneName,
    },
    {
      key: 'zm',
      header: 'Zonal Manager',
      // UNZONED is a holding zone with no real ZM — show "NA" rather than the mock seed label.
      render: (r) =>
        r.zoneName === UNZONED_ZONE_NAME ? (
          <span className="text-ink-muted">NA</span>
        ) : r.zonalManagerName ? (
          <span className="text-ink">{r.zonalManagerName}</span>
        ) : (
          <span className="text-ink-muted">—</span>
        ),
      sortable: true,
      sortValue: (r) => (r.zoneName === UNZONED_ZONE_NAME ? '' : (r.zonalManagerName ?? '')),
    },
    {
      key: 'total',
      header: 'Inactive / Total',
      align: 'right',
      render: (r) => (
        <span data-testid="scorecard-inactive-total" className="tabular-nums">
          {formatInactiveOfTotal(r.totalInactive, r.totalDevices)}
        </span>
      ),
      sortable: true,
      sortValue: (r) => r.totalInactive,
    },
    {
      key: 'critical',
      header: 'Critical',
      align: 'right',
      render: (r) => {
        const count = criticalOnlyCount(r.byBucket);
        return (
          <button
            type="button"
            data-testid="scorecard-critical"
            onClick={(e) => {
              e.stopPropagation();
              openZoneDevices(r.zoneId, { criticalOnly: true });
            }}
            disabled={count === 0}
            className="tabular-nums font-semibold text-critical underline-offset-2 hover:underline disabled:cursor-default disabled:text-ink-muted disabled:no-underline"
            title={count > 0 ? 'View CRITICAL devices in this zone' : undefined}
          >
            {count}
          </button>
        );
      },
      sortable: true,
      sortValue: (r) => criticalOnlyCount(r.byBucket),
    },
    {
      key: 'worst',
      header: 'Worst Bucket',
      align: 'right',
      render: (r) => {
        const w = worstBucket(r.byBucket);
        return w ? <SLABadge bucket={w} /> : <span className="text-ink-muted">—</span>;
      },
    },
    {
      key: 'uptime',
      header: 'Fleet Uptime',
      align: 'right',
      render: (r) => {
        const pct = zoneUptime?.get(r.zoneId);
        return pct != null ? (
          <span data-testid="scorecard-uptime">
            <UptimeMeter pct={pct} />
          </span>
        ) : (
          <span className="text-ink-muted">—</span>
        );
      },
      sortable: true,
      // Zones without a computed uptime sort to the bottom (−1) rather than jumping to the top as 0.
      sortValue: (r) => zoneUptime?.get(r.zoneId) ?? -1,
    },
  ];

  return (
    <section aria-labelledby="scorecard-heading" className="mb-8">
      <h3
        id="scorecard-heading"
        className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-ink-caps"
      >
        Zone Performance Scorecard
      </h3>
      <DataTable
        ariaLabel="Zone Performance Scorecard"
        rowKey={(r) => r.zoneId}
        columns={columns}
        rows={rows}
        onRowClick={(r) => openZoneDevices(r.zoneId)}
        empty="No zones in scope."
      />
    </section>
  );
}
