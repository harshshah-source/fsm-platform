import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  apiOverrideBatch,
  apiOverridePreview,
  apiScheduleDetail,
  apiZoneEngineers,
  OverrideConflictError,
  type OverrideCommand,
  type OverrideConflict,
  type OverrideImpact,
  type ScheduleDetail,
  type ScheduleStop,
  type ScheduleStopTicket,
  type ZoneEngineer,
} from '../../api/schedules';
import { Badge, Button } from '../../components/ui';
import type { BadgeTone } from '../../components/ui/Badge';
import { OverrideImpactPanel, PlantName } from '../../components/domain';
import { engineerOptionLabel } from '../../lib/capacity';

/**
 * ZM Schedule detail (Issue 13b AC#2/#3/#4 · FE-12 parity, reference 12). The ordered stop list for one
 * SE's Work Schedule, each stop showing plant + device count and its tickets with a "Why suggested?"
 * reasoning chip. ZM override controls (Remove / Defer per ticket; Swap SE / Split per stop; Reassign per
 * ticket) commit immediately via `POST /api/batches/:id/override` with a mandatory free-text reason; the
 * page refetches to reflect the OVERRIDDEN flip — no approval gate. The SE-moving actions pick a target
 * from the zone-scoped engineer list.
 *
 * FE-12 is a presentation-only refactor onto the design tokens + `Button` / `Badge`; every test id
 * (`schedule-stop`, `ticket-row-*`, `schedule-status-*`, `onsite-conflict-banner`), the override-control
 * labels, the mandatory-reason gating, the override commands, and the conflict-confirm flow are all
 * preserved. The per-ticket Recommender *reasoning* stays gated behind "Why suggested?"; the ungated
 * ticket-state badges (SLA bucket / Company Tier / PARTIAL_RECOVERY) are a separate payload leg (#79).
 *
 * **#281 AC8 (#280 R8) — present → past, per record.** Each stop IS a batch, and `/batches/:batchId`
 * is the dispatch record that produced it: the decision trace, the candidates considered, the run's
 * configuration. That was reachable only by walking down from the runs ledger, which meant an operator
 * asking "why is this stop on their day?" had to find the run first. The reverse direction — batch
 * back to the day plan — is #281 AC6, on `DispatchBatchDetailPage`.
 */
const STATUS_TONE: Record<string, BadgeTone> = {
  AUTO_ASSIGNED: 'neutral',
  OVERRIDDEN: 'warning',
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
      <p role="alert" className="text-sm text-critical">
        {error}
      </p>
    );
  }
  if (!detail) {
    return <p className="text-sm text-ink-muted">Loading…</p>;
  }

  // The current SE is never a swap/reassign target for their own work.
  const targets = engineers.filter((e) => e.engineerId !== detail.seId);

  return (
    <div>
      <Link to="/schedules" className="text-sm text-ink-muted hover:underline">
        ← Schedules
      </Link>
      <h2 className="mb-1 mt-2 text-xl font-semibold text-ink-strong">
        {detail.seName ?? detail.seId}
        <span className="ml-2 align-middle font-mono text-xs font-normal text-ink-muted">
          {detail.seId.slice(0, 8)}
        </span>
      </h2>
      <p className="mb-1 flex items-center gap-2 text-sm text-ink-muted">
        <span>
          {detail.dateFrom === detail.dateTo ? detail.dateFrom : `${detail.dateFrom} – ${detail.dateTo}`}
        </span>
        <span data-testid={`schedule-status-${detail.status}`}>
          <Badge tone={STATUS_TONE[detail.status] ?? 'neutral'}>{detail.status}</Badge>
        </span>
      </p>
      <p className="mb-5 text-xs text-ink-muted">
        The SE visits the stops below in order; each stop is one plant with its assigned tickets. Every
        change here (remove / defer / reassign / swap / split / reorder) commits immediately with a
        mandatory reason and flags the plan OVERRIDDEN.
      </p>

      {conflict && (
        <div
          role="alert"
          data-testid="onsite-conflict-banner"
          className="mb-4 rounded-card border border-warning/40 bg-warning-bg p-3 text-sm text-warning"
        >
          {/* Two distinct 409s reach here, and until now both printed the ON_SITE headline — telling an
              operator the engineer was at the site when the real blocker was a future vehicle-return
              date. The server has always sent which one it is; the client simply never read it. */}
          <p className="font-semibold">
            {conflict.info.code === 'CONFLICT_DEFERRED'
              ? 'Affected work is held to a future vehicle-return date'
              : 'SE is ON_SITE on affected work'}
          </p>
          <p className="mt-1">{conflict.info.message}</p>
          <p className="mt-1 text-xs">Affected tickets: {conflict.info.ticketIds.join(', ')}</p>
          <div className="mt-2 flex gap-2">
            <Button type="button" size="sm" variant="primary" onClick={confirmOverride}>
              Confirm override
            </Button>
            <Button type="button" size="sm" variant="secondary" onClick={() => setConflict(null)}>
              Cancel
            </Button>
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

/**
 * #289 — the preview between the choice and the commit.
 *
 * **Keyed on the target, not on the form.** The impact is a function of *which engineer the work
 * moves to* and *which work moves* — never of the reason typed beside it, so a manager writing three
 * sentences of justification does not fire three projections. `reasonCode` is still sent, because the
 * preview and the confirm take the identical body and drifting into two vocabularies is how a preview
 * ends up disagreeing with the write it precedes.
 *
 * A failed projection resolves to `null` and the panel simply does not appear. The preview is an aid,
 * not a gate (#258 Q2): a manager whose network hiccuped keeps their Confirm, and the 409 conflict
 * path (AC4) stays exactly where it was — on the commit.
 */
function useOverridePreview(batchId: string, cmd: OverrideCommand | null): OverrideImpact | null {
  const [impact, setImpact] = useState<OverrideImpact | null>(null);
  // Reason deliberately excluded: see above. Stringified so the effect compares by value, not identity.
  const key = cmd ? JSON.stringify({ ...cmd, reasonCode: '' }) : null;

  useEffect(() => {
    if (!cmd || key === null) {
      setImpact(null);
      return;
    }
    let alive = true;
    setImpact(null); // never show the previous target's numbers under the new target's name
    apiOverridePreview(batchId, cmd)
      .then((i) => alive && setImpact(i))
      .catch(() => alive && setImpact(null));
    return () => {
      alive = false;
    };
    // `cmd` is intentionally not a dependency — `key` is its value-identity minus the reason.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batchId, key]);

  return impact;
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
  // Both two-lane moves off this stop. Split waits for a selection as well as a target: which work
  // moves is as much the projection's input as who it moves to, and an empty set moves nothing.
  const impact = useOverridePreview(
    stop.batchId,
    open === 'swap' && newSeId !== ''
      ? { action: 'SWAP_SE', newSeId, reasonCode: reason }
      : open === 'split' && newSeId !== '' && selected.size > 0
        ? { action: 'SPLIT_BATCH', ticketIds: [...selected], newSeId, reasonCode: reason }
        : null,
  );

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
    <li data-testid="schedule-stop" className="rounded-card border border-line bg-surface-card p-3 shadow-sm">
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-xs text-ink-caps">Stop {stop.stopSequence}</span>
          <PlantName code={stop.plantName} variant="inline" className="font-semibold text-ink-strong" />
          <Badge tone={stop.status === 'OVERRIDDEN' ? 'warning' : 'neutral'}>
            {stop.status === 'AUTO_ASSIGNED' ? 'AUTO' : stop.status}
          </Badge>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-ink-muted">{stop.deviceCount} devices</span>
          {/* A link, not a control: the batch record is read-only history (#280 R3 / #281 AC5). It sits
              before the override buttons so "see why this was assigned" reads ahead of "change it". */}
          <Link
            to={`/batches/${stop.batchId}`}
            data-testid={`stop-to-batch-${stop.batchId}`}
            className="whitespace-nowrap text-xs text-link hover:underline"
          >
            Why dispatch chose this →
          </Link>
          <Button type="button" size="sm" variant="secondary" onClick={() => setOpen((v) => (v === 'swap' ? null : 'swap'))}>
            Swap SE
          </Button>
          <Button type="button" size="sm" variant="secondary" onClick={() => setOpen((v) => (v === 'split' ? null : 'split'))}>
            Split batch
          </Button>
          <Button type="button" size="sm" variant="secondary" onClick={() => setOpen((v) => (v === 'reorder' ? null : 'reorder'))}>
            Reorder
          </Button>
        </div>
      </div>

      {open === 'reorder' && (
        <div className="mb-2 flex flex-wrap items-center gap-2 rounded-md bg-surface-sunken/60 p-2">
          <label className="flex items-center gap-1 text-xs text-ink-muted">
            Move to position
            <input
              type="number"
              min={1}
              value={position}
              onChange={(e) => setPosition(e.target.value)}
              className="w-16 rounded-md border border-line px-2 py-1 text-xs"
            />
          </label>
          <ReasonInput value={reason} onChange={setReason} />
          <Button
            type="button"
            size="sm"
            disabled={position === '' || reason.trim() === '' || busy}
            onClick={() => commit({ action: 'REORDER', stopSequence: Number(position), reasonCode: reason })}
          >
            Confirm reorder
          </Button>
        </div>
      )}

      {open === 'swap' && (
        <div className="mb-2 flex flex-wrap items-center gap-2 rounded-md bg-surface-sunken/60 p-2">
          <SePicker label="Target SE" value={newSeId} onChange={setNewSeId} targets={targets} />
          <ReasonInput value={reason} onChange={setReason} />
          <Button
            type="button"
            size="sm"
            disabled={newSeId === '' || reason.trim() === '' || busy}
            onClick={() => commit({ action: 'SWAP_SE', newSeId, reasonCode: reason })}
          >
            Confirm swap
          </Button>
          {impact && <OverrideImpactPanel impact={impact} />}
        </div>
      )}

      {open === 'split' && (
        <div className="mb-2 flex flex-wrap items-center gap-2 rounded-md bg-surface-sunken/60 p-2">
          <span className="text-xs text-ink-muted">Tick the tickets to move:</span>
          <SePicker label="Target SE" value={newSeId} onChange={setNewSeId} targets={targets} />
          <ReasonInput value={reason} onChange={setReason} />
          <Button
            type="button"
            size="sm"
            disabled={selected.size === 0 || newSeId === '' || reason.trim() === '' || busy}
            onClick={() => commit({ action: 'SPLIT_BATCH', ticketIds: [...selected], newSeId, reasonCode: reason })}
          >
            Confirm split
          </Button>
          {impact && <OverrideImpactPanel impact={impact} />}
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
  // Only Reassign hands work to another engineer; Remove and Defer have one lane and no two-lane
  // impact to project (the endpoint refuses them with NOT_PROJECTABLE rather than answering zeros).
  const impact = useOverridePreview(
    batchId,
    open === 'reassign' && newSeId !== ''
      ? { action: 'REASSIGN', ticketId: ticket.ticketId, newSeId, reasonCode: reason }
      : null,
  );

  const commit = async (cmd: OverrideCommand) => {
    setBusy(true);
    try {
      await onOverride(batchId, cmd);
    } finally {
      setBusy(false);
    }
  };

  return (
    <li
      data-testid={`ticket-row-${ticket.ticketId}`}
      className="flex flex-wrap items-center gap-2 rounded-md px-2 py-1 hover:bg-surface-sunken/50"
    >
      {splitSelect && (
        <input
          type="checkbox"
          aria-label={`Select ticket ${ticket.ticketId}`}
          checked={splitSelect.checked}
          onChange={splitSelect.onToggle}
        />
      )}
      <span className="font-medium text-ink-strong" title={ticket.ticketId}>
        Ticket <span className="font-mono">#{ticket.ticketId.slice(0, 8)}</span>
      </span>
      <TicketStateBadges ticket={ticket} />
      <WhySuggested ticket={ticket} />
      <Button type="button" size="sm" variant="ghost" onClick={() => setOpen((v) => (v === 'remove' ? null : 'remove'))}>
        Remove
      </Button>
      <Button type="button" size="sm" variant="ghost" onClick={() => setOpen((v) => (v === 'defer' ? null : 'defer'))}>
        Defer
      </Button>
      <Button type="button" size="sm" variant="ghost" onClick={() => setOpen((v) => (v === 'reassign' ? null : 'reassign'))}>
        Reassign
      </Button>

      {open === 'remove' && (
        <span className="flex items-center gap-2">
          <ReasonInput value={reason} onChange={setReason} />
          <Button
            type="button"
            size="sm"
            variant="danger"
            disabled={reason.trim() === '' || busy}
            onClick={() => commit({ action: 'REMOVE_TICKET', ticketId: ticket.ticketId, reasonCode: reason })}
          >
            Confirm remove
          </Button>
        </span>
      )}

      {open === 'defer' && (
        <span className="flex items-center gap-2">
          <label className="flex items-center gap-1 text-xs text-ink-muted">
            Defer to
            <input
              type="date"
              value={deferTo}
              onChange={(e) => setDeferTo(e.target.value)}
              className="rounded-md border border-line px-2 py-1 text-xs"
            />
          </label>
          <ReasonInput value={reason} onChange={setReason} />
          <Button
            type="button"
            size="sm"
            disabled={deferTo === '' || reason.trim() === '' || busy}
            onClick={() =>
              commit({
                action: 'DEFER_TICKET',
                ticketId: ticket.ticketId,
                deferredToDate: deferTo,
                reasonCode: reason,
              })
            }
          >
            Confirm defer
          </Button>
        </span>
      )}

      {open === 'reassign' && (
        <div className="flex w-full flex-wrap items-center gap-2">
          <SePicker label="Target SE" value={newSeId} onChange={setNewSeId} targets={targets} />
          <ReasonInput value={reason} onChange={setReason} />
          <Button
            type="button"
            size="sm"
            disabled={newSeId === '' || reason.trim() === '' || busy}
            onClick={() => commit({ action: 'REASSIGN', ticketId: ticket.ticketId, newSeId, reasonCode: reason })}
          >
            Confirm reassign
          </Button>
          {impact && <OverrideImpactPanel impact={impact} />}
        </div>
      )}
    </li>
  );
}

/** The mandatory free-text override reason field (v1 — no controlled vocabulary yet). */
function ReasonInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <label className="flex items-center gap-1 text-xs text-ink-muted">
      Reason
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-md border border-line px-2 py-1 text-xs"
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
    <label className="flex items-center gap-1 text-xs text-ink-muted">
      {label}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-md border border-line px-2 py-1 text-xs"
      >
        <option value="">Select…</option>
        {/* #269 — the Swap / Reassign / Split target picker carries the same `n/cap` label as every
            other assign surface, and marks over-capacity without ever disabling it (#258 Q2). */}
        {targets.map((e) => (
          <option key={e.engineerId} value={e.engineerId}>
            {engineerOptionLabel(e)}
          </option>
        ))}
      </select>
    </label>
  );
}

/** SLA-bucket → badge tone: the severe end of the ladder is critical, the risk band is warning. */
const SLA_TONE: Record<string, BadgeTone> = {
  CRITICAL: 'critical',
  HIGH_CRITICAL: 'critical',
  SEVERE: 'critical',
  VERY_SEVERE: 'critical',
  LONG_PENDING: 'critical',
  RISK: 'warning',
  EARLY_RISK: 'warning',
  WARNING: 'warning',
};

/**
 * Ungated per-ticket state badges (Issue 79 · reference 12) — SLA bucket, Company Tier, and a
 * PARTIAL_RECOVERY marker. Always visible: unlike "Why suggested?", these are the un-gated ticket state,
 * not the Recommender scoring reasoning. Each guarded so the pre-#79 payload (no fields) renders nothing.
 */
function TicketStateBadges({ ticket }: { ticket: ScheduleStopTicket }) {
  return (
    <span className="flex items-center gap-1">
      {ticket.slaBucket && (
        <span data-testid={`ticket-sla-${ticket.ticketId}`}>
          <Badge tone={SLA_TONE[ticket.slaBucket] ?? 'neutral'}>{ticket.slaBucket}</Badge>
        </span>
      )}
      {ticket.companyTier && (
        <span data-testid={`ticket-tier-${ticket.ticketId}`}>
          <Badge tone="brand">{ticket.companyTier}</Badge>
        </span>
      )}
      {ticket.partialRecovery && (
        <span data-testid={`ticket-partial-${ticket.ticketId}`}>
          <Badge tone="warning">PARTIAL</Badge>
        </span>
      )}
    </span>
  );
}

/** Collapsed "Why suggested?" chip → expands to the per-ticket Recommender reasoning. */
function WhySuggested({ ticket }: { ticket: ScheduleStopTicket }) {
  const [open, setOpen] = useState(false);
  const r = ticket.reasoning;

  return (
    <span>
      <Button type="button" size="sm" variant="ghost" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        Why suggested?
      </Button>
      {open && (
        <span className="ml-2 text-xs text-ink-muted">
          {r
            ? `Tier ${r.companyTier ?? '—'} · Bucket ${r.deviceBucket ?? '—'} · Rank ${r.companyPriorityRank ?? '—'} · Cluster ×${r.clusterMultiplier ?? '—'}`
            : 'No recommendation reasoning recorded.'}
        </span>
      )}
    </span>
  );
}
