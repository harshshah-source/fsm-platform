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
import { ActionRequiredPanel } from './ActionRequiredPanel';
import { CompanyPlantTable } from './CompanyPlantTable';
import { CriticalQueue } from './CriticalQueue';
import { ZoneOverviewTable } from './ZoneOverviewTable';

/**
 * Zone Operations Dashboard landing (Issue 06). Composes the Action Required panel, Zone Overview,
 * Company/Plant Overview, and Grouped Critical Work Queue. Role/zone scoping is enforced server-side
 * (a ZM only ever receives their own zone; CSM / Operations Head see all zones).
 */
export function DashboardHome() {
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

  return (
    <div>
      <h2 className="mb-4 text-xl font-semibold">Zone Operations Dashboard</h2>
      {error && (
        <p role="alert" className="mb-4 text-sm text-red-700">
          {error}
        </p>
      )}
      <ActionRequiredPanel cards={actions} />
      <ZoneOverviewTable rows={zones} />
      <CompanyPlantTable rows={companyPlants} />
      <CriticalQueue groups={critical} engineers={engineers} onAssigned={refreshCritical} />
    </div>
  );
}
