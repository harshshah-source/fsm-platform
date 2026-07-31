import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { ZoneOverviewRow } from '../../api/dashboard';
import { listSeDirectory } from '../../api/engineersAdmin';
import { ColumnHeader, DataTable, type Column } from '../../components/data';
import { InactiveCountLink } from '../../components/domain';
import { formatCount, formatPct } from '../../lib/fleetFormat';
import { criticalPlusCount } from '../../lib/slaBucket';

/** The FSM holding-zone name (mirrors the backend `UNZONED_ZONE_NAME`); it has no assigned ZM. */
const UNZONED_ZONE_NAME = 'UNZONED';

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
 * Columns: Zone · Zonal Manager · Operational Devices · Inactive Operational · Healthy Devices ·
 * Warehouse Devices · Inactive % · Fleet Health % · Inactive > 24Hr (all bands at/above CRITICAL) ·
 * Assigned SEs · % Successful Troubleshoot (no backend source yet — NA) · Fleet Uptime. The inactive
 * count and the whole row are click-throughs to that zone's inactive devices.
 *
 * Every count column sums to the matching card in the Operational Fleet strip above, because both read
 * the same server-side aggregate. The rates divide by Operational Devices, never by the mirrored
 * total: warehouse stock is reported in its own column and stays out of every ratio.
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

  // Count of active SEs assigned to each zone (dedicated + floating), keyed by zoneId. Sourced from the
  // SE directory the OH/CSM already read for SE Management — no new endpoint. Absent until it resolves.
  const [seCountByZone, setSeCountByZone] = useState<Map<string, number> | null>(null);
  useEffect(() => {
    let alive = true;
    listSeDirectory()
      .then((ses) => {
        if (!alive) return;
        const counts = new Map<string, number>();
        for (const se of ses) {
          if (!se.isActive) continue;
          const key = String(se.zoneId);
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }
        setSeCountByZone(counts);
      })
      .catch(() => {
        if (alive) setSeCountByZone(new Map());
      });
    return () => {
      alive = false;
    };
  }, []);

  // Deep-link into the Device Detail list (`/reports/device`), pre-filtered to the zone's inactive devices.
  const openZoneDevices = (zoneId: string) => {
    const params = new URLSearchParams({ zoneId, status: 'INACTIVE' });
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
      key: 'operational',
      header: <ColumnHeader label="Operational Devices" kpi="operationalDevices" />,
      align: 'right',
      render: (r) => (
        <span data-testid="scorecard-operational" className="tabular-nums text-ink">
          {formatCount(r.operationalDevices)}
        </span>
      ),
      sortable: true,
      sortValue: (r) => r.operationalDevices,
    },
    {
      key: 'total',
      // Renamed from "Inactive / Total": the denominator is the operational fleet, and saying so is
      // the difference between 874/4,093 (21.4%) and the truth, 874/2,482 (35.2%).
      header: <ColumnHeader label="Inactive Operational" kpi="inactiveOperational" />,
      align: 'right',
      render: (r) => (
        <span data-testid="scorecard-inactive-total" className="tabular-nums">
          <InactiveCountLink
            inactive={r.inactiveOperational}
            operational={r.operationalDevices}
            scope={{ zoneId: r.zoneId }}
          />
        </span>
      ),
      sortable: true,
      sortValue: (r) => r.inactiveOperational,
    },
    {
      key: 'healthy',
      header: <ColumnHeader label="Healthy Devices" kpi="healthyOperational" />,
      align: 'right',
      render: (r) => (
        <span data-testid="scorecard-healthy" className="tabular-nums text-ink">
          {formatCount(r.healthyOperational)}
        </span>
      ),
      sortable: true,
      sortValue: (r) => r.healthyOperational,
    },
    {
      key: 'warehouse',
      header: <ColumnHeader label="Warehouse Devices" kpi="warehouseDevices" />,
      align: 'right',
      // Muted on purpose: warehouse stock is not a performance signal and must not read as one — it
      // sits outside every rate in this table.
      render: (r) => (
        <span data-testid="scorecard-warehouse" className="tabular-nums text-ink-muted">
          {formatCount(r.warehouseDevices)}
        </span>
      ),
      sortable: true,
      sortValue: (r) => r.warehouseDevices,
    },
    {
      key: 'inactivePct',
      header: <ColumnHeader label="Inactive %" kpi="inactivePct" />,
      align: 'right',
      render: (r) => (
        <span data-testid="scorecard-inactive-pct" className="tabular-nums font-semibold text-ink">
          {formatPct(r.inactivePct)}
        </span>
      ),
      sortable: true,
      sortValue: (r) => r.inactivePct ?? -1,
    },
    {
      key: 'fleetHealthPct',
      header: <ColumnHeader label="Fleet Health %" kpi="fleetHealthPct" />,
      align: 'right',
      render: (r) => (r.fleetHealthPct != null ? <span data-testid="scorecard-health-pct"><UptimeMeter pct={r.fleetHealthPct} /></span> : <span className="text-ink-muted">—</span>),
      sortable: true,
      sortValue: (r) => r.fleetHealthPct ?? -1,
    },
    {
      key: 'inactive24h',
      header: 'Inactive > 24Hr',
      align: 'right',
      render: (r) => {
        // Every device inactive 24h or longer — the CRITICAL band and worse (Long-Pending / Severe / …).
        const count = criticalPlusCount(r.byBucket);
        return (
          <button
            type="button"
            data-testid="scorecard-inactive-24h"
            onClick={(e) => {
              e.stopPropagation();
              openZoneDevices(r.zoneId);
            }}
            disabled={count === 0}
            // Same drill-down-count role as `InactiveCountLink`, so the same `text-link` token: a
            // red count on the dark canvas is what the operator asked us to stop doing. The severity
            // is already carried by the column itself ("Critical+"), not by the ink.
            className="tabular-nums font-semibold text-link underline-offset-2 hover:underline disabled:cursor-default disabled:text-ink-muted disabled:no-underline"
            title={count > 0 ? 'View inactive devices in this zone' : undefined}
          >
            {count}
          </button>
        );
      },
      sortable: true,
      sortValue: (r) => criticalPlusCount(r.byBucket),
    },
    {
      key: 'assignedSes',
      header: 'Assigned SEs',
      align: 'right',
      render: (r) => {
        // Dedicated + floating SEs assigned to the zone; a dash until the directory loads.
        const count = seCountByZone?.get(r.zoneId);
        return count != null ? (
          <span data-testid="scorecard-assigned-ses" className="tabular-nums text-ink" title="Dedicated + floating SEs assigned to this zone">
            {count}
          </span>
        ) : (
          <span className="text-ink-muted">—</span>
        );
      },
      sortable: true,
      sortValue: (r) => seCountByZone?.get(r.zoneId) ?? -1,
    },
    {
      key: 'troubleshootPct',
      header: '% Successful Troubleshoot',
      align: 'right',
      // No backend source for troubleshoot success rate yet — shown as NA (Issue: awaiting a report).
      render: () => (
        <span data-testid="scorecard-troubleshoot-pct" className="text-ink-muted" title="Troubleshoot success rate (this month) — data not available yet">
          NA
        </span>
      ),
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
