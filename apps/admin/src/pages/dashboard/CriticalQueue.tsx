import { useState } from 'react';
import type { CriticalQueueGroup } from '../../api/dashboard';
import {
  apiAssignTicket,
  DeferralConflictError,
  type DeferralConflict,
  type DeferralOverride,
  type ZoneEngineer,
} from '../../api/schedules';
import { DeferralConfirm, DurationBadge, PlantName, TierBadge } from '../../components/domain';
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
                  <PlantName code={g.plantName} className="mt-0.5 text-xs text-ink-muted" />
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
                    <DurationBadge bucket={t.slaBucket} latestGpsDatetime={t.latestGpsDatetime} />
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
  // #249 — an assign the backend refused because the ticket is held to a future vehicle-return date,
  // parked here until the manager either states a reason or backs out. Held per cluster: the rest of
  // the group is already assigned by then, and re-running them would double-assign.
  const [conflict, setConflict] = useState<DeferralConflict | null>(null);
  /** The remainder of the cluster, from the held ticket onward — what a confirm resumes. */
  const [pending, setPending] = useState<{ ticketId: string }[] | null>(null);

  /** Assign each ticket in the cluster, stopping at the first return-date hold. */
  const assignFrom = async (tickets: { ticketId: string }[], deferral?: DeferralOverride) => {
    setBusy(true);
    try {
      for (let i = 0; i < tickets.length; i += 1) {
        try {
          // The confirm applies to the ticket that raised it, never to the rest of the cluster: a
          // manager who overrode one hold has said nothing about any other.
          await apiAssignTicket(tickets[i].ticketId, seId, i === 0 ? deferral : undefined);
        } catch (e) {
          if (e instanceof DeferralConflictError) {
            setPending(tickets.slice(i));
            setConflict(e.conflict);
            return;
          }
          throw e;
        }
      }
      setConflict(null);
      setPending(null);
      onAssigned?.();
    } finally {
      setBusy(false);
    }
  };

  const assign = () => assignFrom(group.tickets);

  return (
    <div className="flex flex-col items-end gap-2">
      {conflict && (
        <DeferralConfirm
          conflict={conflict}
          busy={busy}
          onConfirm={(reasonCode) => {
            void assignFrom(pending ?? [], { confirm: true, reasonCode });
          }}
          onCancel={() => {
            setConflict(null);
            setPending(null);
          }}
        />
      )}
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
                {e.name ?? e.engineerId}
              </option>
            ))}
          </FilterSelect>
        </label>
        <Button size="sm" disabled={seId === '' || busy} loading={busy} onClick={assign}>
          Assign
        </Button>
      </div>
    </div>
  );
}
