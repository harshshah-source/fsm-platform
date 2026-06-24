import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  apiOverrideBatch,
  apiScheduleDetail,
  apiZoneEngineers,
  OverrideConflictError,
  type OverrideCommand,
  type OverrideConflict,
  type ScheduleDetail,
  type ScheduleStop,
  type ScheduleStopTicket,
  type ZoneEngineer,
} from '../../api/schedules';

/**
 * ZM Schedule detail (Issue 13b AC#2/#3/#4). The ordered stop list for one SE's Work Schedule, each
 * stop showing plant + device count and its tickets with a "Why suggested?" reasoning chip. ZM override
 * controls (Remove / Defer per ticket; Swap SE / Split per stop; Reassign per ticket) commit
 * immediately via `POST /api/batches/:id/override` with a mandatory free-text reason; the page refetches
 * to reflect the OVERRIDDEN flip — no approval gate. The SE-moving actions pick a target from the
 * zone-scoped engineer list. Reorder is slice 4; the ON_SITE conflict banner is slice 5.
 */
const STATUS_CLASS: Record<string, string> = {
  AUTO_ASSIGNED: 'bg-slate-200 text-slate-700',
  OVERRIDDEN: 'bg-amber-100 text-amber-800',
};

export function ScheduleDetailPage() {
  const { engineerId = '' } = useParams();
  const [detail, setDetail] = useState<ScheduleDetail | null>(null);
  const [engineers, setEngineers] = useState<ZoneEngineer[]>([]);
  const [error, setError] = useState<string | null>(null);
  // A pending override held back by an ON_SITE conflict — awaiting explicit confirm (AC#5).
  const [conflict, setConflict] = useState<{ batchId: string; cmd: OverrideCommand; info: OverrideConflict } | null>(
    null,
  );

  const load = useCallback(() => {
    return apiScheduleDetail(engineerId)
      .then(setDetail)
      .catch(() => setError('Failed to load schedule'));
  }, [engineerId]);

  useEffect(() => {
    let alive = true;
    apiScheduleDetail(engineerId)
      .then((d) => alive && setDetail(d))
      .catch(() => alive && setError('Failed to load schedule'));
    apiZoneEngineers()
      .then((e) => alive && setEngineers(e))
      .catch(() => undefined); // pickers degrade to empty; reads above own the error surface
    return () => {
      alive = false;
    };
  }, [engineerId]);

  const onOverride = useCallback(
    async (batchId: string, cmd: OverrideCommand) => {
      try {
        await apiOverrideBatch(batchId, cmd);
        await load();
      } catch (e) {
        if (e instanceof OverrideConflictError) {
          // Hold the command; the SE's ON_SITE is never silently cleared — require explicit confirm.
          setConflict({ batchId, cmd, info: e.conflict });
          return;
        }
        throw e;
      }
    },
    [load],
  );

  const confirmOverride = useCallback(async () => {
    if (!conflict) return;
    await apiOverrideBatch(conflict.batchId, { ...conflict.cmd, confirm: true });
    setConflict(null);
    await load();
  }, [conflict, load]);

  if (error) {
    return (
      <p role="alert" className="text-sm text-red-700">
        {error}
      </p>
    );
  }
  if (!detail) {
    return <p className="text-sm text-slate-500">Loading…</p>;
  }

  // The current SE is never a swap/reassign target for their own work.
  const targets = engineers.filter((e) => e.engineerId !== detail.seId);

  return (
    <div>
      <Link to="/schedules" className="text-sm text-slate-500 hover:underline">
        ← Schedules
      </Link>
      <h2 className="mb-1 mt-2 text-xl font-semibold">{detail.seId}</h2>
      <p className="mb-4 flex items-center gap-2 text-sm text-slate-500">
        <span>
          {detail.dateFrom === detail.dateTo ? detail.dateFrom : `${detail.dateFrom} – ${detail.dateTo}`}
        </span>
        <span
          data-testid={`schedule-status-${detail.status}`}
          className={`rounded px-2 py-0.5 text-xs ${STATUS_CLASS[detail.status] ?? 'bg-slate-200 text-slate-700'}`}
        >
          {detail.status}
        </span>
      </p>

      {conflict && (
        <div
          role="alert"
          data-testid="onsite-conflict-banner"
          className="mb-4 rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900"
        >
          <p className="font-semibold">SE is ON_SITE on affected work</p>
          <p className="mt-1">{conflict.info.message}</p>
          <p className="mt-1 text-xs">Affected tickets: {conflict.info.ticketIds.join(', ')}</p>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              onClick={confirmOverride}
              className="rounded border border-amber-400 px-2 py-0.5 text-xs text-amber-900 hover:bg-amber-100"
            >
              Confirm override
            </button>
            <button
              type="button"
              onClick={() => setConflict(null)}
              className="rounded border px-2 py-0.5 text-xs text-slate-600 hover:bg-slate-50"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <ol className="flex flex-col gap-3">
        {detail.stops.map((stop) => (
          <Stop key={stop.batchId} stop={stop} targets={targets} onOverride={onOverride} />
        ))}
      </ol>
    </div>
  );
}

function Stop({
  stop,
  targets,
  onOverride,
}: {
  stop: ScheduleStop;
  targets: ZoneEngineer[];
  onOverride: (batchId: string, cmd: OverrideCommand) => Promise<void>;
}) {
  const [open, setOpen] = useState<null | 'swap' | 'split' | 'reorder'>(null);
  const [newSeId, setNewSeId] = useState('');
  const [reason, setReason] = useState('');
  const [position, setPosition] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const commit = async (cmd: OverrideCommand) => {
    setBusy(true);
    try {
      await onOverride(stop.batchId, cmd);
    } finally {
      setBusy(false);
    }
  };

  return (
    <li data-testid="schedule-stop" className="rounded border p-3">
      <div className="mb-2 flex items-center justify-between">
        <div>
          <span className="text-xs text-slate-400">Stop {stop.stopSequence}</span>
          <span className="ml-2 font-semibold">{stop.plantName}</span>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-slate-500">{stop.deviceCount} devices</span>
          <button
            type="button"
            onClick={() => setOpen((v) => (v === 'swap' ? null : 'swap'))}
            className="rounded border px-1.5 py-0.5 text-xs text-slate-500 hover:bg-slate-50"
          >
            Swap SE
          </button>
          <button
            type="button"
            onClick={() => setOpen((v) => (v === 'split' ? null : 'split'))}
            className="rounded border px-1.5 py-0.5 text-xs text-slate-500 hover:bg-slate-50"
          >
            Split batch
          </button>
          <button
            type="button"
            onClick={() => setOpen((v) => (v === 'reorder' ? null : 'reorder'))}
            className="rounded border px-1.5 py-0.5 text-xs text-slate-500 hover:bg-slate-50"
          >
            Reorder
          </button>
        </div>
      </div>

      {open === 'reorder' && (
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1 text-xs">
            Move to position
            <input
              type="number"
              min={1}
              value={position}
              onChange={(e) => setPosition(e.target.value)}
              className="w-16 rounded border px-1 py-0.5 text-xs"
            />
          </label>
          <ReasonInput value={reason} onChange={setReason} />
          <button
            type="button"
            disabled={position === '' || reason.trim() === '' || busy}
            onClick={() => commit({ action: 'REORDER', stopSequence: Number(position), reasonCode: reason })}
            className="rounded border px-1.5 py-0.5 text-xs text-amber-800 disabled:text-slate-300"
          >
            Confirm reorder
          </button>
        </div>
      )}

      {open === 'swap' && (
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <SePicker label="Target SE" value={newSeId} onChange={setNewSeId} targets={targets} />
          <ReasonInput value={reason} onChange={setReason} />
          <button
            type="button"
            disabled={newSeId === '' || reason.trim() === '' || busy}
            onClick={() => commit({ action: 'SWAP_SE', newSeId, reasonCode: reason })}
            className="rounded border px-1.5 py-0.5 text-xs text-amber-800 disabled:text-slate-300"
          >
            Confirm swap
          </button>
        </div>
      )}

      {open === 'split' && (
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <span className="text-xs text-slate-500">Tick the tickets to move:</span>
          <SePicker label="Target SE" value={newSeId} onChange={setNewSeId} targets={targets} />
          <ReasonInput value={reason} onChange={setReason} />
          <button
            type="button"
            disabled={selected.size === 0 || newSeId === '' || reason.trim() === '' || busy}
            onClick={() =>
              commit({ action: 'SPLIT_BATCH', ticketIds: [...selected], newSeId, reasonCode: reason })
            }
            className="rounded border px-1.5 py-0.5 text-xs text-amber-800 disabled:text-slate-300"
          >
            Confirm split
          </button>
        </div>
      )}

      <ul className="flex flex-col gap-1 text-sm">
        {stop.tickets.map((t) => (
          <TicketRow
            key={t.ticketId}
            batchId={stop.batchId}
            ticket={t}
            targets={targets}
            onOverride={onOverride}
            splitSelect={
              open === 'split'
                ? { checked: selected.has(t.ticketId), onToggle: () => toggle(t.ticketId) }
                : undefined
            }
          />
        ))}
      </ul>
    </li>
  );
}

function TicketRow({
  batchId,
  ticket,
  targets,
  onOverride,
  splitSelect,
}: {
  batchId: string;
  ticket: ScheduleStopTicket;
  targets: ZoneEngineer[];
  onOverride: (batchId: string, cmd: OverrideCommand) => Promise<void>;
  splitSelect?: { checked: boolean; onToggle: () => void };
}) {
  const [open, setOpen] = useState<null | 'remove' | 'defer' | 'reassign'>(null);
  const [reason, setReason] = useState('');
  const [deferTo, setDeferTo] = useState('');
  const [newSeId, setNewSeId] = useState('');
  const [busy, setBusy] = useState(false);

  const commit = async (cmd: OverrideCommand) => {
    setBusy(true);
    try {
      await onOverride(batchId, cmd);
    } finally {
      setBusy(false);
    }
  };

  return (
    <li data-testid={`ticket-row-${ticket.ticketId}`} className="flex flex-wrap items-center gap-2">
      {splitSelect && (
        <input
          type="checkbox"
          aria-label={`Select ticket ${ticket.ticketId}`}
          checked={splitSelect.checked}
          onChange={splitSelect.onToggle}
        />
      )}
      <span>Ticket {ticket.ticketId}</span>
      <WhySuggested ticket={ticket} />
      <button
        type="button"
        onClick={() => setOpen((v) => (v === 'remove' ? null : 'remove'))}
        className="rounded border px-1.5 py-0.5 text-xs text-slate-500 hover:bg-slate-50"
      >
        Remove
      </button>
      <button
        type="button"
        onClick={() => setOpen((v) => (v === 'defer' ? null : 'defer'))}
        className="rounded border px-1.5 py-0.5 text-xs text-slate-500 hover:bg-slate-50"
      >
        Defer
      </button>
      <button
        type="button"
        onClick={() => setOpen((v) => (v === 'reassign' ? null : 'reassign'))}
        className="rounded border px-1.5 py-0.5 text-xs text-slate-500 hover:bg-slate-50"
      >
        Reassign
      </button>

      {open === 'remove' && (
        <span className="flex items-center gap-2">
          <ReasonInput value={reason} onChange={setReason} />
          <button
            type="button"
            disabled={reason.trim() === '' || busy}
            onClick={() => commit({ action: 'REMOVE_TICKET', ticketId: ticket.ticketId, reasonCode: reason })}
            className="rounded border px-1.5 py-0.5 text-xs text-red-700 disabled:text-slate-300"
          >
            Confirm remove
          </button>
        </span>
      )}

      {open === 'defer' && (
        <span className="flex items-center gap-2">
          <label className="flex items-center gap-1 text-xs">
            Defer to
            <input
              type="date"
              value={deferTo}
              onChange={(e) => setDeferTo(e.target.value)}
              className="rounded border px-1 py-0.5 text-xs"
            />
          </label>
          <ReasonInput value={reason} onChange={setReason} />
          <button
            type="button"
            disabled={deferTo === '' || reason.trim() === '' || busy}
            onClick={() =>
              commit({
                action: 'DEFER_TICKET',
                ticketId: ticket.ticketId,
                deferredToDate: deferTo,
                reasonCode: reason,
              })
            }
            className="rounded border px-1.5 py-0.5 text-xs text-amber-800 disabled:text-slate-300"
          >
            Confirm defer
          </button>
        </span>
      )}

      {open === 'reassign' && (
        <span className="flex items-center gap-2">
          <SePicker label="Target SE" value={newSeId} onChange={setNewSeId} targets={targets} />
          <ReasonInput value={reason} onChange={setReason} />
          <button
            type="button"
            disabled={newSeId === '' || reason.trim() === '' || busy}
            onClick={() =>
              commit({ action: 'REASSIGN', ticketId: ticket.ticketId, newSeId, reasonCode: reason })
            }
            className="rounded border px-1.5 py-0.5 text-xs text-amber-800 disabled:text-slate-300"
          >
            Confirm reassign
          </button>
        </span>
      )}
    </li>
  );
}

/** The mandatory free-text override reason field (v1 — no controlled vocabulary yet). */
function ReasonInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <label className="flex items-center gap-1 text-xs">
      Reason
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded border px-1 py-0.5 text-xs"
      />
    </label>
  );
}

/** Target-SE selector for SE-moving overrides, sourced from the zone-scoped engineer list. */
function SePicker({
  label,
  value,
  onChange,
  targets,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  targets: ZoneEngineer[];
}) {
  return (
    <label className="flex items-center gap-1 text-xs">
      {label}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded border px-1 py-0.5 text-xs"
      >
        <option value="">Select…</option>
        {targets.map((e) => (
          <option key={e.engineerId} value={e.engineerId}>
            {e.engineerId}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Collapsed "Why suggested?" chip → expands to the per-ticket Recommender reasoning. */
function WhySuggested({ ticket }: { ticket: ScheduleStopTicket }) {
  const [open, setOpen] = useState(false);
  const r = ticket.reasoning;

  return (
    <span>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="rounded border px-1.5 py-0.5 text-xs text-slate-500 hover:bg-slate-50"
      >
        Why suggested?
      </button>
      {open && (
        <span className="ml-2 text-xs text-slate-600">
          {r
            ? `Tier ${r.companyTier ?? '—'} · Bucket ${r.deviceBucket ?? '—'} · Rank ${r.companyPriorityRank ?? '—'} · Cluster ×${r.clusterMultiplier ?? '—'}`
            : 'No recommendation reasoning recorded.'}
        </span>
      )}
    </span>
  );
}
