import { useEffect, useState } from 'react';
import {
  apiAssignTicket,
  apiOverrideBatch,
  apiOverridePreview,
  apiZoneEngineers,
  DeferralConflictError,
  OverrideConflictError,
  type OverrideCommand,
  type OverrideConflict,
  type OverrideImpact,
  type ZoneEngineer,
} from '../../../api/schedules';
import { placeHold, releaseHold, type HoldResult } from '../../../api/schedulerPreview';
import { OverrideImpactPanel } from '../../../components/domain';
import { Badge, Button } from '../../../components/ui';
import { Input } from '../../../components/ui/Input';
import { Select } from '../../../components/ui/Select';
import { engineerOptionLabel } from '../../../lib/capacity';

/**
 * **ACTIONS — the Inspector's write band** (Scheduler Console Phase 2.3/2.4, operator ruling D1).
 *
 * ## What this is, and what it is not
 *
 * On 2026-08-25 the operator was asked whether the cockpit should grow move controls, and said no —
 * because the proposal at the time was to build a **second** set beside Schedule Detail's, which
 * `#282 R5` forbids. On 2026-08-27 they approved the Console, whose premise is different: this band
 * **absorbs** those controls rather than duplicating them. The number of implementations stays at one.
 *
 * So there is exactly one rule governing this file, and it is a maintenance rule as much as a design
 * one: **every action here commits through the endpoint that already owns it.** No new write path was
 * created for the Console, and none may be. `POST /batches/:id/override` takes all six overrides;
 * `POST /schedules/assign`, `/holds` and `/holds/release` take the rest.
 *
 * ## The four properties that are not negotiable
 *
 * 1. **Every override writes immediately and requires a reason.** `OverrideCommand` makes
 *    `reasonCode` mandatory on all six actions; Confirm stays disabled until it is non-empty. There is
 *    no draft, no staging and no "commit all" — `#272 R8` rules per-item commit and per-item results.
 * 2. **Two of the confirms are two-gate.** `CONFLICT_ON_SITE` and `CONFLICT_DEFERRED` come back as
 *    populated 409s to be re-sent with `confirm: true`. They render as a **second deliberate step**,
 *    never as an error toast — and they say *which* conflict they are, which the old shared client
 *    could not, because it typed both as ON_SITE.
 * 3. **Impact is previewed where projectable, and its absence never removes Confirm.** Only the three
 *    two-lane moves (Reassign / Swap / Split) have a two-lane impact; the endpoint refuses the other
 *    three with `NOT_PROJECTABLE` rather than answering zeros, because `0 → 0` would read as "removing
 *    this person's work costs nothing". A projection that simply fails loses the panel and keeps the
 *    Confirm — the preview is information, not a gate (#258 Q2).
 * 4. **The legal set is rendered, and the rest is hidden.** Not greyed out. An action absent from this
 *    band is an action this object cannot take in this state.
 *
 * ## Preview keying
 *
 * The impact is a function of *which engineer the work moves to* and *which work moves* — never of the
 * reason typed beside it. Keying on the reason would fire a projection per keystroke while a manager
 * writes their justification. `reasonCode` is still sent, because the preview and the confirm take the
 * identical body and drifting into two vocabularies is how a preview ends up disagreeing with the write
 * it precedes.
 */

/**
 * A drag-initiated action (correction §12, D10). A drop **never commits** — it opens the same
 * authoritative dialog the typed path uses, with the target engineer or date seeded, and the same
 * validation, impact preview, mandatory reason and Confirm still stand between release and any write.
 */
export type ActionPrefill =
  | { action: 'REASSIGN'; seId: string }
  | { action: 'DEFER_TICKET'; date: string }
  | { action: 'REMOVE_TICKET' }
  | { action: 'ASSIGN'; seId: string }
  | { action: 'SWAP_SE'; seId: string };

/** What the Console can do to a ticket, given where that ticket currently sits. */
export type TicketPlacement =
  /** On somebody's plan today — the six overrides apply, through the batch that holds it. */
  | { kind: 'PLACED'; batchId: string; seId: string }
  /** Unassignable rail: nobody holds it, so Assign is the door and there is no batch to override. */
  | { kind: 'UNPLACED' }
  /** Held rail: the only live action is releasing the hold. */
  | { kind: 'HELD'; heldUntil: string };

type Draft =
  | { action: 'REASSIGN' }
  | { action: 'REMOVE_TICKET' }
  | { action: 'DEFER_TICKET' }
  | { action: 'ASSIGN' }
  | { action: 'HOLD' }
  | null;

export function TicketActions({
  ticketId,
  placement,
  currentSeId,
  onCommitted,
  prefill,
}: {
  ticketId: string;
  placement: TicketPlacement;
  /** Excluded from the target list: an engineer is never a reassign target for their own work. */
  currentSeId: string | null;
  /** The Console's single lifted fetch. Called on every successful write, without exception. */
  onCommitted: () => void;
  /** Opens the named dialog pre-seeded — a drop initiates; only Confirm commits. */
  prefill?: ActionPrefill | null;
}) {
  const [draft, setDraft] = useState<Draft>(null);

  // A drop opens the dialog it maps to — but only when the action is legal for where the ticket
  // actually is. A stale drag (the payload moved between drag start and drop) opens nothing.
  useEffect(() => {
    if (!prefill) return;
    const legal =
      placement.kind === 'PLACED'
        ? prefill.action === 'REASSIGN' || prefill.action === 'DEFER_TICKET' || prefill.action === 'REMOVE_TICKET'
        : placement.kind === 'UNPLACED'
          ? prefill.action === 'ASSIGN'
          : false;
    if (legal) setDraft({ action: prefill.action } as Draft);
  }, [prefill, placement.kind]);

  const close = () => setDraft(null);
  const done = () => {
    setDraft(null);
    onCommitted();
  };

  return (
    <div data-testid="inspector-actions" className="flex flex-col gap-2 border-t border-line pt-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-ink-muted">Actions</span>

        {placement.kind === 'PLACED' && (
          <>
            <ActionButton id="reassign" label="Reassign" draft={draft} setDraft={setDraft} action="REASSIGN" />
            <ActionButton id="defer" label="Defer" draft={draft} setDraft={setDraft} action="DEFER_TICKET" />
            <ActionButton id="remove" label="Remove" draft={draft} setDraft={setDraft} action="REMOVE_TICKET" />
          </>
        )}

        {placement.kind === 'UNPLACED' && (
          <>
            <ActionButton id="assign" label="Assign" draft={draft} setDraft={setDraft} action="ASSIGN" />
            <ActionButton id="hold" label="Hold" draft={draft} setDraft={setDraft} action="HOLD" />
          </>
        )}

        {placement.kind === 'HELD' && (
          <ReleaseHoldButton ticketId={ticketId} heldUntil={placement.heldUntil} onDone={done} />
        )}
      </div>

      {placement.kind === 'PLACED' && draft?.action === 'REASSIGN' && (
        <OverrideForm
          batchId={placement.batchId}
          currentSeId={currentSeId}
          title="Reassign this ticket to another engineer"
          build={(seId, reason) => ({ action: 'REASSIGN', ticketId, newSeId: seId, reasonCode: reason })}
          needsTarget
          initialSeId={prefill?.action === 'REASSIGN' ? prefill.seId : undefined}
          onCancel={close}
          onDone={done}
        />
      )}

      {placement.kind === 'PLACED' && draft?.action === 'DEFER_TICKET' && (
        <OverrideForm
          batchId={placement.batchId}
          currentSeId={currentSeId}
          title="Defer this ticket to a later day"
          build={(_seId, reason, date) => ({
            action: 'DEFER_TICKET',
            ticketId,
            deferredToDate: date,
            reasonCode: reason,
          })}
          needsDate
          initialDate={prefill?.action === 'DEFER_TICKET' ? prefill.date : undefined}
          onCancel={close}
          onDone={done}
        />
      )}

      {placement.kind === 'PLACED' && draft?.action === 'REMOVE_TICKET' && (
        <OverrideForm
          batchId={placement.batchId}
          currentSeId={currentSeId}
          title="Remove this ticket from the plan"
          build={(_seId, reason) => ({ action: 'REMOVE_TICKET', ticketId, reasonCode: reason })}
          danger
          onCancel={close}
          onDone={done}
        />
      )}

      {placement.kind === 'UNPLACED' && draft?.action === 'ASSIGN' && (
        <AssignForm
          ticketId={ticketId}
          initialSeId={prefill?.action === 'ASSIGN' ? prefill.seId : undefined}
          onCancel={close}
          onDone={done}
        />
      )}

      {placement.kind === 'UNPLACED' && draft?.action === 'HOLD' && (
        <HoldForm ticketId={ticketId} onCancel={close} onDone={done} />
      )}
    </div>
  );
}

/** Stop-level actions: Swap the whole stop to another engineer, Split part of it off, Reorder it. */
export function StopActions({
  batchId,
  currentSeId,
  ticketIds,
  stopSequence,
  onCommitted,
  prefill,
}: {
  batchId: string;
  currentSeId: string | null;
  ticketIds: string[];
  stopSequence: number;
  onCommitted: () => void;
  /** A drag-initiated SWAP_SE opens pre-seeded; other prefills mean nothing to a stop. */
  prefill?: ActionPrefill | null;
}) {
  const [draft, setDraft] = useState<'SWAP_SE' | 'SPLIT_BATCH' | 'REORDER' | null>(null);

  useEffect(() => {
    if (prefill?.action === 'SWAP_SE') setDraft('SWAP_SE');
  }, [prefill]);
  const close = () => setDraft(null);
  const done = () => {
    setDraft(null);
    onCommitted();
  };

  return (
    <div data-testid="inspector-actions" className="flex flex-col gap-2 border-t border-line pt-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-ink-muted">Actions</span>
        <Button size="sm" variant="secondary" data-testid="action-swap" onClick={() => setDraft((v) => (v === 'SWAP_SE' ? null : 'SWAP_SE'))}>
          Swap engineer
        </Button>
        <Button size="sm" variant="secondary" data-testid="action-split" onClick={() => setDraft((v) => (v === 'SPLIT_BATCH' ? null : 'SPLIT_BATCH'))}>
          Split stop
        </Button>
        <Button size="sm" variant="secondary" data-testid="action-reorder" onClick={() => setDraft((v) => (v === 'REORDER' ? null : 'REORDER'))}>
          Reorder
        </Button>
      </div>

      {draft === 'SWAP_SE' && (
        <OverrideForm
          batchId={batchId}
          currentSeId={currentSeId}
          title="Move this whole stop to another engineer"
          build={(seId, reason) => ({ action: 'SWAP_SE', newSeId: seId, reasonCode: reason })}
          needsTarget
          initialSeId={prefill?.action === 'SWAP_SE' ? prefill.seId : undefined}
          onCancel={close}
          onDone={done}
        />
      )}

      {draft === 'SPLIT_BATCH' && (
        <OverrideForm
          batchId={batchId}
          currentSeId={currentSeId}
          title="Move some of this stop's devices to another engineer"
          build={(seId, reason, _date, selected) => ({
            action: 'SPLIT_BATCH',
            ticketIds: selected,
            newSeId: seId,
            reasonCode: reason,
          })}
          needsTarget
          /* The one place multi-select exists in the whole product: `SPLIT_BATCH` takes `ticketIds[]`.
             Everywhere else it would imply a bulk write the backend does not offer. */
          selectable={ticketIds}
          onCancel={close}
          onDone={done}
        />
      )}

      {draft === 'REORDER' && (
        <OverrideForm
          batchId={batchId}
          currentSeId={currentSeId}
          title={`Move this stop to a different position (currently #${stopSequence})`}
          build={(_seId, reason, _date, _sel, position) => ({
            action: 'REORDER',
            stopSequence: Number(position),
            reasonCode: reason,
          })}
          needsPosition
          onCancel={close}
          onDone={done}
        />
      )}
    </div>
  );
}

function ActionButton({
  id,
  label,
  action,
  draft,
  setDraft,
}: {
  id: string;
  label: string;
  action: NonNullable<Draft>['action'];
  draft: Draft;
  setDraft: (d: Draft) => void;
}) {
  return (
    <Button
      size="sm"
      variant="secondary"
      data-testid={`action-${id}`}
      onClick={() => setDraft(draft?.action === action ? null : ({ action } as Draft))}
    >
      {label}
    </Button>
  );
}

/**
 * One override, from choice to commit: target → impact → reason → Confirm → (conflict → Confirm again).
 *
 * The same component serves all six actions because they share that shape exactly; what differs is
 * which inputs are collected, and `build` turns those inputs into the command the endpoint takes.
 */
function OverrideForm({
  batchId,
  currentSeId,
  title,
  build,
  needsTarget,
  needsDate,
  needsPosition,
  selectable,
  danger,
  initialSeId,
  initialDate,
  onCancel,
  onDone,
}: {
  batchId: string;
  currentSeId: string | null;
  title: string;
  build: (
    seId: string,
    reason: string,
    date: string,
    selected: string[],
    position: string,
  ) => OverrideCommand;
  needsTarget?: boolean;
  needsDate?: boolean;
  needsPosition?: boolean;
  selectable?: string[];
  danger?: boolean;
  /** Drag prefill (D10): seeds the field the drop already answered; everything else is still typed. */
  initialSeId?: string;
  initialDate?: string;
  onCancel: () => void;
  onDone: () => void;
}) {
  const [engineers, setEngineers] = useState<ZoneEngineer[]>([]);
  const [seId, setSeId] = useState(initialSeId ?? '');
  const [reason, setReason] = useState('');
  const [date, setDate] = useState(initialDate ?? '');
  const [position, setPosition] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState<OverrideConflict | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!needsTarget) return;
    let live = true;
    // Zone-scoped and acting-aware server-side (#239): the targets offered here are the same engineers
    // the deck shows, never a pan-India list beside a one-zone board.
    void apiZoneEngineers()
      .then((e) => live && setEngineers(e))
      .catch(() => live && setEngineers([]));
    return () => {
      live = false;
    };
  }, [needsTarget]);

  const ready =
    reason.trim() !== '' &&
    (!needsTarget || seId !== '') &&
    (!needsDate || date !== '') &&
    (!needsPosition || position !== '') &&
    (!selectable || selected.length > 0);

  const command = () => build(seId, reason.trim(), date, selected, position);

  // Keyed on the target and the selection, never on the reason — see this file's docblock.
  const impact = useOverridePreview(
    batchId,
    ready && (needsTarget || selectable) ? build(seId, '', date, selected, position) : null,
  );

  const commit = async (confirm: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await apiOverrideBatch(batchId, { ...command(), ...(confirm ? { confirm: true } : {}) });
      onDone();
    } catch (e) {
      if (e instanceof OverrideConflictError) {
        setConflict(e.conflict);
        return;
      }
      setError(e instanceof Error ? e.message : 'The change could not be committed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-md border border-line bg-surface-sunken p-2">
      <p className="text-[11px] font-semibold text-ink">{title}</p>

      <div className="mt-2 flex flex-wrap items-end gap-2">
        {needsTarget && (
          <label className="text-[10px] text-ink-muted">
            Target engineer
            <Select
              aria-label="Target engineer"
              data-testid="action-target-se"
              className="mt-0.5 h-8 w-52 text-xs"
              value={seId}
              onChange={(e) => setSeId(e.target.value)}
            >
              <option value="">Select…</option>
              {/* #269 — the same `n/cap` label as every other assign surface, marking over capacity
                  without ever disabling it: dispatch will not pick an over-capacity engineer, a human
                  may, and the option says both. */}
              {engineers
                .filter((e) => e.engineerId !== currentSeId)
                .map((e) => (
                  <option key={e.engineerId} value={e.engineerId}>
                    {engineerOptionLabel(e)}
                  </option>
                ))}
            </Select>
          </label>
        )}

        {needsDate && (
          <label className="text-[10px] text-ink-muted">
            Defer to
            <Input
              type="date"
              data-testid="action-defer-date"
              className="mt-0.5 h-8 text-xs"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </label>
        )}

        {needsPosition && (
          <label className="text-[10px] text-ink-muted">
            New position
            <Input
              type="number"
              min={1}
              data-testid="action-position"
              className="mt-0.5 h-8 w-20 text-xs"
              value={position}
              onChange={(e) => setPosition(e.target.value)}
            />
          </label>
        )}

        <label className="min-w-[12rem] flex-1 text-[10px] text-ink-muted">
          Reason (required — recorded on the ticket)
          <Input
            data-testid="action-reason"
            className="mt-0.5 h-8 text-xs"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </label>
      </div>

      {selectable && (
        <fieldset className="mt-2">
          <legend className="text-[10px] text-ink-muted">Devices to move</legend>
          <div className="mt-1 flex flex-wrap gap-2">
            {selectable.map((id) => (
              <label key={id} className="flex items-center gap-1 text-[11px] text-ink">
                <input
                  type="checkbox"
                  aria-label={`Move ticket ${id}`}
                  checked={selected.includes(id)}
                  onChange={() =>
                    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
                  }
                />
                <span className="font-mono">{id.slice(0, 8)}</span>
              </label>
            ))}
          </div>
        </fieldset>
      )}

      {impact && (
        <div className="mt-2">
          <OverrideImpactPanel impact={impact} />
        </div>
      )}

      {/*
        The second gate. Both refusals are populated 409s answered by re-sending with `confirm: true`,
        and they are *different facts* — one says the engineer is standing at the site, the other that
        the work is held to a future vehicle-return date. Rendering either as a toast would lose the
        thing the operator has to decide about.
      */}
      {conflict && (
        <div
          role="alert"
          data-testid="action-conflict"
          className="mt-2 rounded border border-warning bg-warning-bg/40 p-2 text-[11px]"
        >
          <p className="font-semibold text-warning">
            {conflict.code === 'CONFLICT_DEFERRED'
              ? 'This work is held to a future vehicle-return date'
              : 'The engineer is ON_SITE on affected work'}
          </p>
          <p className="mt-0.5 text-ink">{conflict.message}</p>
          {conflict.ticketIds.length > 0 && (
            <p className="mt-0.5 font-mono text-ink-muted">
              {conflict.ticketIds.map((t) => t.slice(0, 8)).join(' · ')}
            </p>
          )}
          <div className="mt-2 flex gap-2">
            <Button size="sm" data-testid="action-conflict-confirm" disabled={busy} onClick={() => void commit(true)}>
              Override anyway
            </Button>
            <Button size="sm" variant="secondary" onClick={onCancel}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {error && (
        <p role="alert" className="mt-2 text-[11px] text-critical">
          {error}
        </p>
      )}

      {!conflict && (
        <div className="mt-2 flex gap-2">
          <Button
            size="sm"
            variant={danger ? 'danger' : 'primary'}
            data-testid="action-confirm"
            disabled={!ready || busy}
            onClick={() => void commit(false)}
          >
            Confirm
          </Button>
          <Button size="sm" variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      )}
    </div>
  );
}

/** Assign work nobody holds. A held ticket comes back as a 409 the operator can confirm through. */
function AssignForm({
  ticketId,
  initialSeId,
  onCancel,
  onDone,
}: {
  ticketId: string;
  /** Drag prefill (D10): the lane the pool row was dropped on. */
  initialSeId?: string;
  onCancel: () => void;
  onDone: () => void;
}) {
  const [engineers, setEngineers] = useState<ZoneEngineer[]>([]);
  const [seId, setSeId] = useState(initialSeId ?? '');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [held, setHeld] = useState<{ message: string; deferredUntil: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void apiZoneEngineers()
      .then((e) => live && setEngineers(e))
      .catch(() => live && setEngineers([]));
    return () => {
      live = false;
    };
  }, []);

  const commit = async (confirm: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await apiAssignTicket(ticketId, seId, confirm ? { confirm: true, reasonCode: reason.trim() } : undefined);
      onDone();
    } catch (e) {
      if (e instanceof DeferralConflictError) {
        setHeld({ message: e.conflict.message, deferredUntil: e.conflict.deferredUntil });
        return;
      }
      setError(e instanceof Error ? e.message : 'The assignment could not be committed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-md border border-line bg-surface-sunken p-2">
      <p className="text-[11px] font-semibold text-ink">Assign this ticket to an engineer</p>
      <div className="mt-2 flex flex-wrap items-end gap-2">
        <label className="text-[10px] text-ink-muted">
          Engineer
          <Select
            aria-label="Engineer"
            data-testid="assign-target-se"
            className="mt-0.5 h-8 w-52 text-xs"
            value={seId}
            onChange={(e) => setSeId(e.target.value)}
          >
            <option value="">Select…</option>
            {engineers.map((e) => (
              <option key={e.engineerId} value={e.engineerId}>
                {engineerOptionLabel(e)}
              </option>
            ))}
          </Select>
        </label>
        {held && (
          <label className="min-w-[12rem] flex-1 text-[10px] text-ink-muted">
            Reason (required to assign over a hold)
            <Input
              data-testid="assign-reason"
              className="mt-0.5 h-8 text-xs"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
        )}
      </div>

      {held && (
        <div role="alert" data-testid="assign-conflict" className="mt-2 rounded border border-warning bg-warning-bg/40 p-2 text-[11px]">
          <p className="font-semibold text-warning">This ticket is held until {held.deferredUntil}</p>
          <p className="mt-0.5 text-ink">{held.message}</p>
          <Button
            className="mt-2"
            size="sm"
            data-testid="assign-conflict-confirm"
            disabled={busy || reason.trim() === ''}
            onClick={() => void commit(true)}
          >
            Assign anyway
          </Button>
        </div>
      )}

      {error && (
        <p role="alert" className="mt-2 text-[11px] text-critical">
          {error}
        </p>
      )}

      {!held && (
        <div className="mt-2 flex gap-2">
          <Button size="sm" data-testid="assign-confirm" disabled={seId === '' || busy} onClick={() => void commit(false)}>
            Assign
          </Button>
          <Button size="sm" variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * Hold a ticket back from the next run.
 *
 * `heldUntil` is the day the ticket **returns** — the deferral check is inclusive — so holding it off
 * tomorrow means naming the day after. The field says so rather than leaving an operator to discover
 * it by holding something for a day less than they meant.
 */
function HoldForm({
  ticketId,
  onCancel,
  onDone,
}: {
  ticketId: string;
  onCancel: () => void;
  onDone: () => void;
}) {
  const [until, setUntil] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<Exclude<HoldResult, { result: 'OK' } | { result: 'NOT_FOUND' }> | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);

  const commit = async (confirm: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const res = await placeHold({ ticketId, heldUntil: until, reasonCode: reason.trim(), confirm });
      if (res.result === 'NOT_HOLDABLE' || res.result === 'CONFLICT_VEHICLE_UNAVAILABLE') {
        setRefusal(res);
        return;
      }
      if (res.result === 'NOT_FOUND') {
        setError('That ticket no longer exists on this zone’s plan.');
        return;
      }
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The hold could not be placed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-md border border-line bg-surface-sunken p-2">
      <p className="text-[11px] font-semibold text-ink">Hold this ticket back from the next run</p>
      <div className="mt-2 flex flex-wrap items-end gap-2">
        <label className="text-[10px] text-ink-muted">
          Returns on
          <Input
            type="date"
            data-testid="hold-until"
            className="mt-0.5 h-8 text-xs"
            value={until}
            onChange={(e) => setUntil(e.target.value)}
          />
        </label>
        <label className="min-w-[12rem] flex-1 text-[10px] text-ink-muted">
          Reason (required)
          <Input
            data-testid="hold-reason"
            className="mt-0.5 h-8 text-xs"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </label>
      </div>
      <p className="mt-1 text-[10px] text-ink-muted">
        The ticket re-enters dispatch on the day named above, not the day after it.
      </p>

      {refusal && (
        <div role="alert" data-testid="hold-conflict" className="mt-2 rounded border border-warning bg-warning-bg/40 p-2 text-[11px]">
          <p className="font-semibold text-warning">
            {refusal.result === 'CONFLICT_VEHICLE_UNAVAILABLE'
              ? `A vehicle-unavailability report already returns this vehicle on ${refusal.expectedFrom}`
              : 'This ticket cannot be held'}
          </p>
          <p className="mt-0.5 text-ink">{refusal.message}</p>
          {refusal.result === 'CONFLICT_VEHICLE_UNAVAILABLE' && (
            <Button
              className="mt-2"
              size="sm"
              data-testid="hold-conflict-confirm"
              disabled={busy}
              onClick={() => void commit(true)}
            >
              Override the reported date
            </Button>
          )}
        </div>
      )}

      {error && (
        <p role="alert" className="mt-2 text-[11px] text-critical">
          {error}
        </p>
      )}

      {!refusal && (
        <div className="mt-2 flex gap-2">
          <Button
            size="sm"
            data-testid="hold-confirm"
            disabled={until === '' || reason.trim() === '' || busy}
            onClick={() => void commit(false)}
          >
            Place hold
          </Button>
          <Button size="sm" variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      )}
    </div>
  );
}

/** Releasing a hold takes no reason and has no conflict — the ticket re-enters the very next run. */
function ReleaseHoldButton({
  ticketId,
  heldUntil,
  onDone,
}: {
  ticketId: string;
  heldUntil: string;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <span className="flex flex-wrap items-center gap-2">
      <Badge tone="info">held until {heldUntil}</Badge>
      <Button
        size="sm"
        variant="secondary"
        data-testid="action-release-hold"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setError(null);
          void releaseHold(ticketId)
            .then(onDone)
            .catch((e: unknown) => setError(e instanceof Error ? e.message : 'The hold could not be released.'))
            .finally(() => setBusy(false));
        }}
      >
        Release hold
      </Button>
      <span className="text-[10px] text-ink-muted">re-enters the very next run</span>
      {error && (
        <span role="alert" className="text-[11px] text-critical">
          {error}
        </span>
      )}
    </span>
  );
}

/** See this file's docblock on preview keying: the target and the selection, never the reason. */
function useOverridePreview(batchId: string, cmd: OverrideCommand | null): OverrideImpact | null {
  const [impact, setImpact] = useState<OverrideImpact | null>(null);
  const key = cmd ? JSON.stringify(cmd) : null;

  useEffect(() => {
    if (key === null) {
      setImpact(null);
      return;
    }
    let live = true;
    setImpact(null); // never show the previous target's numbers under the new target's name
    void apiOverridePreview(batchId, JSON.parse(key) as OverrideCommand)
      .then((i) => live && setImpact(i))
      // NOT_PROJECTABLE and a network failure both land here, and both correctly lose the panel while
      // keeping the Confirm. The preview is information, not a gate (#258 Q2).
      .catch(() => live && setImpact(null));
    return () => {
      live = false;
    };
  }, [batchId, key]);

  return impact;
}
