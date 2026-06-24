import { useState } from 'react';
import type { CriticalQueueGroup } from '../../api/dashboard';
import { apiAssignTicket, type ZoneEngineer } from '../../api/schedules';
import { BUCKET_CLASS, BUCKET_LABEL, type SlaBucket } from '../../lib/slaBucket';

/**
 * Grouped Critical Work Queue (Issue 06 AC#4 + Issue 13b AC#6). CRITICAL+ open tickets grouped by
 * company/plant with a plant-cluster size signal. The "Assign" control picks a target SE from the
 * zone-scoped engineer list and creates a Formal Assignment for each ticket in the cluster via the
 * one-click assign endpoint. The picker is empty (and Assign disabled) until engineers are supplied.
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
      <h3 id="critical-queue-heading" className="mb-2 text-lg font-semibold">
        Grouped Critical Work Queue
      </h3>
      {groups.length === 0 ? (
        <p className="text-sm text-slate-500">No CRITICAL+ work in scope.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {groups.map((g) => (
            <li
              key={`${g.companyId}:${g.plantId}`}
              data-testid="critical-group"
              className="rounded border p-3"
            >
              <div className="mb-2 flex items-center justify-between">
                <div>
                  <span className="font-semibold">{g.companyName}</span>
                  <span className="ml-2 rounded bg-slate-200 px-1 text-xs">{g.companyTier}</span>
                  <span className="mx-2 text-slate-400">·</span>
                  <span className="text-slate-600">{g.plantName}</span>
                </div>
                <span className="text-xs text-slate-500">Cluster: {g.clusterSize}</span>
              </div>
              <ul className="mb-2 flex flex-col gap-1 text-sm">
                {g.tickets.map((t) => {
                  const bucket = t.slaBucket as SlaBucket;
                  return (
                    <li key={t.ticketId} className="flex items-center gap-2">
                      <span className={`rounded px-1 text-xs ${BUCKET_CLASS[bucket] ?? ''}`}>
                        {BUCKET_LABEL[bucket] ?? t.slaBucket}
                      </span>
                      <span>Device {t.deviceId}</span>
                    </li>
                  );
                })}
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
    <div className="flex items-center gap-3 text-xs text-slate-500">
      <label className="flex items-center gap-1">
        Assign to
        <select
          value={seId}
          onChange={(e) => setSeId(e.target.value)}
          className="rounded border px-1 py-0.5 text-xs"
        >
          <option value="">Select SE…</option>
          {engineers.map((e) => (
            <option key={e.engineerId} value={e.engineerId}>
              {e.engineerId}
            </option>
          ))}
        </select>
      </label>
      <button
        type="button"
        disabled={seId === '' || busy}
        onClick={assign}
        className="rounded border px-2 py-0.5 text-xs text-slate-700 disabled:text-slate-300"
      >
        Assign
      </button>
    </div>
  );
}
