import { useCallback, useEffect, useState } from 'react';
import {
  apiActionRequired,
  apiCompanyPlantOverview,
  apiCriticalQueue,
  apiZoneOverview,
  type ActionRequiredCard,
  type CompanyPlantRow,
  type CriticalQueueGroup,
  type ZoneOverviewRow,
} from '../../api/dashboard';
import { apiZoneEngineers, type ZoneEngineer } from '../../api/schedules';
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
export function ManagerDashboard() {
  const { session, actingZone } = useAuth();
  const [zones, setZones] = useState<ZoneOverviewRow[]>([]);
  const [companyPlants, setCompanyPlants] = useState<CompanyPlantRow[]>([]);
  const [critical, setCritical] = useState<CriticalQueueGroup[]>([]);
  const [actions, setActions] = useState<ActionRequiredCard[]>([]);
  const [engineers, setEngineers] = useState<ZoneEngineer[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
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
    // Zone-SE list feeds the Critical Queue assign picker; failure just leaves it empty.
    apiZoneEngineers()
      .then((e) => alive && setEngineers(e))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const refreshCritical = useCallback(() => {
    apiCriticalQueue()
      .then(setCritical)
      .catch(() => undefined);
  }, []);

  const data: DashboardData = {
    zones,
    companyPlants,
    critical,
    actions,
    engineers,
    error,
    onAssigned: refreshCritical,
  };

  // Acting as ZM in a zone collapses every role to the Zone Operations view (reference 02).
  if (!actingZone) {
    if (session?.role === 'OPERATIONS_HEAD') return <OpsHeadDashboard {...data} />;
    if (session?.role === 'CENTRAL_SERVICE_MANAGER') return <CentralDashboard {...data} />;
  }
  return <ZmDashboard {...data} />;
}
