import { useState } from 'react';
import type { CriticalQueueGroup } from '../../api/dashboard';
import { apiAssignTicket, type ZoneEngineer } from '../../api/schedules';
import { SLABadge, TierBadge } from '../../components/domain';
import { FilterSelect } from '../../components/data';
import { Badge, Button } from '../../components/ui';

/**
 * Grouped Critical Work Queue (Issue 06 AC#4 + Issue 13b AC#6 · FE-06). CRITICAL+ open tickets grouped
 * by company/plant with a plant-cluster size signal. The "Assign" control picks a target SE from the
 * zone-scoped engineer list and creates a Formal Assignment for each ticket in the cluster via the
 * one-click assign endpoint. The picker is empty (and Assign disabled) until engineers are supplied.
 *
 * Presentation-only refactor (FE-06): re-skinned onto the enterprise card + domain badges; the
 * `critical-group` test id, the "Assign to" label, the disabled-until-picked Assign button, and the
 * `/schedules/assign` wiring are all preserved.
 */
export function CriticalQueue({
  groups,
  engineers = [],
  onAssigned,
}: {
  groups: CriticalQueueGroup[];
  engineers?: ZoneEngineer[];
  onAssigned?: () => void;
}) {
  return (
    <section aria-labelledby="critical-queue-heading" className="mb-8">
      <h3
        id="critical-queue-heading"
        className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-ink-caps"
      >
        Grouped Critical Work Queue
      </h3>
      {groups.length === 0 ? (
        <p className="rounded-card border border-line bg-surface-card px-4 py-6 text-center text-sm text-ink-muted shadow-sm">
          No CRITICAL+ work in scope.
        </p>
      ) : (
        <ul className="grid grid-cols-1 gap-3 xl:grid-cols-2">
          {groups.map((g) => (
            <li
              key={`${g.companyId}:${g.plantId}`}
              data-testid="critical-group"
              className="overflow-hidden rounded-card border border-line border-l-2 border-l-critical bg-surface-card p-4 shadow-sm"
            >
              <div className="mb-3 flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-semibold text-ink-strong">
                      {g.companyName}
                    </span>
                    <TierBadge tier={g.companyTier} />
                  </div>
                  <div className="mt-0.5 text-xs text-ink-muted">{g.plantName}</div>
                </div>
                <Badge tone="critical">Cluster: {g.clusterSize}</Badge>
              </div>
              <ul className="mb-3 flex flex-col gap-1.5">
                {g.tickets.map((t) => (
                  <li
                    key={t.ticketId}
                    className="flex items-center justify-between gap-2 rounded-md bg-surface-sunken/60 px-3 py-1.5 text-sm"
                  >
                    <span className="font-medium text-ink-strong">Device {t.deviceId}</span>
                    <SLABadge bucket={t.slaBucket} />
                  </li>
                ))}
              </ul>
              <AssignControl group={g} engineers={engineers} onAssigned={onAssigned} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Per-group SE picker + Assign: creates a Formal Assignment for each ticket in the cluster. */
function AssignControl({
  group,
  engineers,
  onAssigned,
}: {
  group: CriticalQueueGroup;
  engineers: ZoneEngineer[];
  onAssigned?: () => void;
}) {
  const [seId, setSeId] = useState('');
  const [busy, setBusy] = useState(false);

  const assign = async () => {
    setBusy(true);
    try {
      for (const t of group.tickets) {
        await apiAssignTicket(t.ticketId, seId);
      }
      onAssigned?.();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center justify-end gap-2">
      <label className="flex items-center gap-1.5 text-xs text-ink-muted">
        Assign to
        <FilterSelect
          value={seId}
          onChange={(e) => setSeId(e.target.value)}
          className="h-8 text-xs"
        >
          <option value="">Select SE…</option>
          {engineers.map((e) => (
            <option key={e.engineerId} value={e.engineerId}>
              {e.engineerId}
            </option>
          ))}
        </FilterSelect>
      </label>
      <Button size="sm" disabled={seId === '' || busy} loading={busy} onClick={assign}>
        Assign
      </Button>
    </div>
  );
}
