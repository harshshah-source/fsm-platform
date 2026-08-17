import { useAuth } from '../../auth/AuthProvider';
import { DateRangeChips, PageHeader } from '../../components/data';
import { Badge } from '../../components/ui';
import { AssignmentThresholdSection } from '../settings/AssignmentThresholdSection';

/**
 * #238 — a routed home for the SE-assignment threshold, because the CSM co-owns it and the Settings
 * console is Operations-Head-only (`AppRoutes`, and the role-access matrix that documents it).
 *
 * Rather than widen Settings — which would hand the CSM zone, plant, user, company, SLA and scoring
 * CRUD to reach one dropdown — the single co-owned control gets its own route. The Operations Head
 * still reaches the identical control as a Settings tab; both render the same component, so the two
 * surfaces cannot drift, and the authority rules stay where they belong (the API).
 */
export function AssignmentThresholdPage() {
  const { session } = useAuth();
  return (
    <div>
      <PageHeader
        title="SE Assignment Threshold"
        subtitle="How long a device stays silent before the platform opens a ticket and assigns a Service Engineer."
        actions={
          <>
            <DateRangeChips />
            {session?.role && <Badge tone="neutral">{session.role}</Badge>}
          </>
        }
      />
      <AssignmentThresholdSection />
    </div>
  );
}
