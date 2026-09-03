import { useAuth } from '../../auth/AuthProvider';
import { PageHeader } from '../../components/data';
import { Badge } from '../../components/ui';
import { ManagerAvailabilitySection } from '../settings/ManagerAvailabilitySection';

/**
 * #339 AC4 — a routed home for manager availability, because the CSM co-owns it and the Settings
 * console is Operations-Head-only (`AppRoutes`, and the role-access matrix that documents it).
 *
 * The same treatment, for the same reason, as the SE-assignment threshold (#238): widening Settings
 * would hand the CSM zone, plant, user, company, SLA and scoring CRUD in order to reach one table.
 * Both surfaces render the identical component, so they cannot drift, and the authority rules stay
 * where they belong — the API, which allows only OH and CSM to open or end a window.
 *
 * It matters that the CSM can reach this at all: they are the role the cascade hands a zone *to*, so
 * they are usually the first to know a manager is out.
 */
export function ManagerAvailabilityPage() {
  const { session } = useAuth();
  return (
    <div>
      <PageHeader
        title="Manager Availability"
        subtitle="Who is covering a zone while its Zonal Manager is out — and until when."
        actions={session?.role ? <Badge tone="neutral">{session.role}</Badge> : undefined}
      />
      <ManagerAvailabilitySection />
    </div>
  );
}
