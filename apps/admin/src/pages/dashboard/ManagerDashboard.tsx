import { useCallback, useEffect, useState } from 'react';
import {
  apiActionRequired,
  apiCompanyPlantOverview,
  apiCriticalQueue,
  apiFleetSummary,
  apiZoneOverview,
  type ActionRequiredCard,
  type CompanyPlantRow,
  type CriticalQueueGroup,
  type FleetSummary,
  type ZoneOverviewRow,
} from '../../api/dashboard';
import { apiFleetUptime, fleetUptimeOrGap, type FleetUptimeRow } from '../../api/reports';
import { useAuth } from '../../auth/AuthProvider';
import { CentralDashboard } from './CentralDashboard';
import { OpsHeadDashboard } from './OpsHeadDashboard';
import { ZmDashboard, type DashboardData } from './ZmDashboard';

/**
 * Manager dashboard landing — loads the role-scoped aggregations once and selects the variant body by
 * role and acting context (Issue 06 / FE-06 / FE-07). The backend already scopes the data (a ZM sees
 * their own zone; CSM / Operations Head see every zone), so the variants differ only in presentation.
 *
 * - Operations Head → Pan-India Fleet Command (reference 04)
 * - Central Service Manager, not acting → Cross-Zone Central Tower (reference 03)
 * - Zonal Manager, or any role acting as ZM in a zone → Zone Operations Dashboard (reference 01/02)
 *
 * The Warehouse-Manager persona has its own dashboard + data sources (FE-17) and never reaches here —
 * `DashboardHome` selects it before this loads (so the manager-scoped endpoints are never called for a WM).
 */
/**
 * #346 — the per-zone / per-plant uptime lookups carry only the groups that actually have a
 * measurement. A group with no eligible device-time (`uptimePct === null`) is **left out of the map**
 * rather than entered as a number, because both consumers — `ScorecardTable`'s Fleet Uptime column and
 * `CompanyPlantTable`'s `fmtUptime` — already render a missing entry as an em dash and sort it to the
 * bottom. Absence is the shape they were built to read; a `null` value would be a second way to say
 * the same thing, and one of the two would eventually be forgotten.
 */
function measuredUptime(rows: FleetUptimeRow[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const row of rows) {
    if (row.uptimePct !== null && row.eligibleDeviceCount > 0) out.set(row.id, row.uptimePct);
  }
  return out;
}

export function ManagerDashboard() {
  const { session, actingZone } = useAuth();
  const [zones, setZones] = useState<ZoneOverviewRow[]>([]);
  const [companyPlants, setCompanyPlants] = useState<CompanyPlantRow[]>([]);
  const [critical, setCritical] = useState<CriticalQueueGroup[]>([]);
  const [actions, setActions] = useState<ActionRequiredCard[]>([]);
  const [fleet, setFleet] = useState<FleetSummary | null>(null);
  const [fleetUptime, setFleetUptime] = useState<number | null>(null);
  // Per-zone current-month uptime %, keyed by zoneId — feeds the Scorecard's Fleet Uptime column.
  const [zoneUptime, setZoneUptime] = useState<Map<string, number>>(new Map());
  // Per-plant current-month uptime %, keyed by plantId — Company/Plant Overview Fleet Uptime % (Issue 135).
  const [plantUptime, setPlantUptime] = useState<Map<string, number>>(new Map());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    // Drop the previous scope's rows before asking for the new one. Entering acting mode otherwise
    // renders the Zone Operations body over the pan-India numbers still in state until the requests
    // land — the exact misreading this whole fix is about. A no-op on first mount.
    setZones([]);
    setCompanyPlants([]);
    setCritical([]);
    setActions([]);
    setFleet(null);
    setFleetUptime(null);
    setZoneUptime(new Map());
    setPlantUptime(new Map());
    setError(null);
    Promise.all([
      apiActionRequired(),
      apiZoneOverview(),
      apiCompanyPlantOverview(),
      apiCriticalQueue(),
    ])
      .then(([a, z, cp, cq]) => {
        if (!alive) return;
        setActions(a);
        setZones(z);
        setCompanyPlants(cp);
        setCritical(cq);
      })
      .catch(() => alive && setError('Failed to load dashboard'));
    // Fleet-summary KPI counts — an older backend without the endpoint just leaves the cards at "—".
    apiFleetSummary()
      .then((f) => alive && typeof f?.operationalDevices === 'number' && setFleet(f))
      .catch(() => undefined);
    // Current-month Fleet Uptime % for the hero card (BE-39). Left at "—" until the monthly summary is
    // computed (report reports 0 eligible devices) or on a backend without the endpoint.
    apiFleetUptime({ groupBy: 'zone' })
      .then((r) => {
        if (!alive || !r) return;
        if (r.fleet?.eligibleDeviceCount > 0) setFleetUptime(fleetUptimeOrGap(r));
        if (r.rows) setZoneUptime(measuredUptime(r.rows));
      })
      .catch(() => undefined);
    // Per-plant uptime for the Company/Plant Overview Fleet Uptime % column (Issue 135); empty until
    // the monthly summary is computed, or on a backend without the endpoint (column stays "—").
    apiFleetUptime({ groupBy: 'plant' })
      .then((r) => alive && r?.rows && setPlantUptime(measuredUptime(r.rows)))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
    // `actingZone` is a dependency, not decoration: every request above carries it as
    // `X-Acting-As-Zone`, so entering or leaving acting mode changes what the SAME endpoints return.
    // With an empty dep list the body swapped to the Zone view over whatever pan-India data was
    // already in state, and nothing refetched until a reload.
  }, [actingZone]);

  const refreshCritical = useCallback(() => {
    apiCriticalQueue()
      .then(setCritical)
      .catch(() => undefined);
  }, []);

  // Full KPI-source reload — used by the OH manual ingestion trigger so the stat cards roll to fresh
  // values when a run completes. Resolves once the new data is applied to state.
  const reload = useCallback(async () => {
    const [a, z, cp, cq] = await Promise.all([
      apiActionRequired(),
      apiZoneOverview(),
      apiCompanyPlantOverview(),
      apiCriticalQueue(),
    ]);
    setActions(a);
    setZones(z);
    setCompanyPlants(cp);
    setCritical(cq);
    apiFleetSummary()
      .then((f) => typeof f?.operationalDevices === 'number' && setFleet(f))
      .catch(() => undefined);
    apiFleetUptime({ groupBy: 'zone' })
      .then((r) => {
        if (!r) return;
        if (r.fleet?.eligibleDeviceCount > 0) setFleetUptime(fleetUptimeOrGap(r));
        if (r.rows) setZoneUptime(measuredUptime(r.rows));
      })
      .catch(() => undefined);
    apiFleetUptime({ groupBy: 'plant' })
      .then((r) => r?.rows && setPlantUptime(measuredUptime(r.rows)))
      .catch(() => undefined);
  }, []);

  const data: DashboardData = {
    zones,
    companyPlants,
    critical,
    actions,
    fleet,
    fleetUptime,
    zoneUptime,
    plantUptime,
    // #350 — the zone-SE list this page used to fetch fed the Critical Queue's assign picker, which
    // #277 removed: `apiZoneEngineers()` ran on every dashboard load (and again on every acting-mode
    // change) for a consumer that no longer exists. The field itself is still on `DashboardData`,
    // declared in `ZmDashboard.tsx` and destructured by nobody — its removal belongs to whoever owns
    // that file next (#351); passing empty is what stops the request.
    engineers: [],
    error,
    onAssigned: refreshCritical,
    onDataRefetch: reload,
  };

  // Acting as ZM in a zone collapses every role to the Zone Operations view (reference 02).
  if (!actingZone) {
    if (session?.role === 'OPERATIONS_HEAD') return <OpsHeadDashboard {...data} />;
    if (session?.role === 'CENTRAL_SERVICE_MANAGER') return <CentralDashboard {...data} />;
  }
  return <ZmDashboard {...data} />;
}
