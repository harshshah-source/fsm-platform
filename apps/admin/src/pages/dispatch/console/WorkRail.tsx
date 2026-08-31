import { useMemo, useState } from 'react';
import type { DispatchChangesTodayView, DispatchTodayView } from '../../../api/dispatchToday';
import { Badge } from '../../../components/ui';
import { cn } from '../../../lib/cn';
import type { DropIntent } from './BoardGrid';
import type { Selection } from './selection';
import { DRAG_MIME, type ChipDragPayload } from './WorkChip';

type PoolTab = 'unassignable' | 'held' | 'changes';

/**
 * **WORK POOL / WORK — the Console's right rail** (approved structure, 2026-08-27).
 *
 * The board shows work that landed. This rail shows everything that did not, plus what a human has
 * changed since the run — the four populations that together answer *"what is not on anybody's plan,
 * and why?"*
 *
 * Every row here **selects the same underlying ticket the board would have selected**, and drives the
 * same single Inspector below. One object, one Inspector, regardless of which door was used (§3.2) —
 * a rail row is a different door to the same ticket, not a different kind of thing.
 *
 * **Three contract rules the rail must not break, all of them the engine's and not ours:**
 *
 * 1. **`policyWithheld` is a count and never becomes a list.** `{count, itemised: false}` is the
 *    published contract: the engine counts this work and never itemises it, so those tickets have no
 *    recommendation, no row and no trace. There is nothing to list, and a truncated-looking list would
 *    be an invention. It is deliberately rendered as a panel rather than a tab for exactly this
 *    reason — a tab beside three itemised tabs invites someone to "finish" it.
 * 2. **`poolEmptyReason: null` renders as "reason not recorded", never as a guess.** Absence is a
 *    fact about the record, and the whole provenance grammar exists to stop absence being drawn as
 *    knowledge.
 * 3. **The chronic filter is built on the predicate the data supports, not the one the plan assumed.**
 *    Phase 0.3 measured both readings: `repeat_failure` (the existing escalation service's) selects
 *    **zero devices**, the plain ≥3-failure-cycles reading selects **113**. A chip that can never light
 *    is worse than no chip, so the filter counts failure cycles. Its threshold comes from the payload
 *    (`chronicThreshold`), never from a constant here — #244's precedent, and the reason a verdict is
 *    always shown beside the rule that produced it.
 *
 *    **It is a toggle across the current tab, not a fourth tab.** The other three answer *where is this
 *    work*; chronic answers *what kind of device is this*, which is a different axis. Making it a tab
 *    would imply chronic work is neither unassigned nor held, and it is usually one of them.
 */
export function WorkRail({
  rails,
  changes,
  selection,
  onSelect,
  filter,
  chronicThreshold,
  drag,
  onDragChange,
  onDropIntent,
}: {
  rails: DispatchTodayView['rails'];
  changes: DispatchChangesTodayView | null;
  selection: Selection | null;
  onSelect: (sel: Selection | null) => void;
  /** The frame's find box, applied to the rail as well as the board (§3.5). */
  filter: string;
  /** From the payload — the server owns the chronic rule, no client re-derives it. */
  chronicThreshold: number;
  /**
   * Drag as initiator (correction §12, D10): an Unassigned row drags onto a lane (→ Assign,
   * prefilled), and a placed chip dropped on this rail opens Remove — nothing commits on release.
   */
  drag?: ChipDragPayload | null;
  onDragChange?: (p: ChipDragPayload | null) => void;
  onDropIntent?: (intent: DropIntent) => void;
}) {
  const [tab, setTab] = useState<PoolTab>('unassignable');
  const [chronicOnly, setChronicOnly] = useState(false);
  const q = filter.trim().toLowerCase();
  const isChronic = (cycles: number | null | undefined) =>
    cycles != null && cycles >= chronicThreshold;
  const match = (...parts: (string | null | undefined)[]) =>
    q === '' || parts.some((p) => (p ?? '').toLowerCase().includes(q));

  const unassignable = useMemo(
    () =>
      rails.unassignable.filter(
        (u) => match(u.ticketId, u.deviceId, u.plantName) && (!chronicOnly || isChronic(u.failureCycles)),
      ),
    [rails.unassignable, q, chronicOnly, chronicThreshold],
  );
  const held = useMemo(
    () =>
      rails.held.filter(
        (h) => match(h.ticketId, h.deviceId, h.plantName) && (!chronicOnly || isChronic(h.failureCycles)),
      ),
    [rails.held, q, chronicOnly, chronicThreshold],
  );
  /** How many rows the toggle would keep, so the chip can carry its own count. */
  const chronicCount =
    rails.unassignable.filter((u) => isChronic(u.failureCycles)).length +
    rails.held.filter((h) => isChronic(h.failureCycles)).length;
  const changeRows = useMemo(
    () => (changes?.changes ?? []).filter((c) => match(c.ticketId, c.reason, c.actorName)),
    [changes, q],
  );

  const TABS: { id: PoolTab; label: string; count: number }[] = [
    { id: 'unassignable', label: 'Unassigned', count: unassignable.length },
    { id: 'held', label: 'Held', count: held.length },
    { id: 'changes', label: 'Changes', count: changeRows.length },
  ];

  const selectedTicket = selection?.kind === 'ticket' ? selection.id : null;
  const rowClass = (id: string) =>
    cn(
      'w-full rounded-md border px-2 py-1.5 text-left text-[11px] transition-colors',
      onDragChange && 'cursor-grab active:cursor-grabbing',
      selectedTicket === id
        ? 'border-brand-600 bg-brand-50/40'
        : 'border-transparent hover:border-line hover:bg-surface-sunken',
    );
  const select = (ticketId: string) =>
    onSelect(selectedTicket === ticketId ? null : { kind: 'ticket', id: ticketId });

  // The rail accepts exactly one drop: a *placed* ticket, which opens Remove prefilled. A pool or
  // stop payload dropped back here means nothing and is refused by never becoming a drop target.
  const removable = drag?.type === 'ticket';

  return (
    <section
      data-testid="console-work-rail"
      aria-label="Work pool"
      className={cn(
        'flex flex-col gap-2 rounded-lg border border-line bg-surface p-3',
        removable && 'outline-dashed outline-1 -outline-offset-2 outline-brand-600',
      )}
      onDragOver={(e) => {
        if (removable) {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
        }
      }}
      onDrop={(e) => {
        const raw = e.dataTransfer.getData(DRAG_MIME);
        const payload: ChipDragPayload | null = raw ? (JSON.parse(raw) as ChipDragPayload) : (drag ?? null);
        onDragChange?.(null);
        if (!payload || payload.type !== 'ticket' || !payload.ticketId || !onDropIntent) return;
        e.preventDefault();
        onDropIntent({
          sel: { kind: 'ticket', id: payload.ticketId },
          prefill: { action: 'REMOVE_TICKET' },
        });
      }}
    >
      <h2 className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">Work pool</h2>

      <div role="tablist" aria-label="Work pool" className="flex gap-1 rounded-md bg-surface-sunken p-0.5">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            type="button"
            aria-selected={tab === t.id}
            data-testid={`pool-tab-${t.id}`}
            onClick={() => setTab(t.id)}
            className={cn(
              'flex-1 rounded px-1.5 py-1 text-[10px] transition-colors',
              tab === t.id ? 'bg-surface font-semibold text-ink shadow-sm' : 'text-ink-muted hover:text-ink',
            )}
          >
            {t.label} <span className="tabular-nums">{t.count}</span>
          </button>
        ))}
      </div>

      {tab === 'unassignable' &&
        (unassignable.length === 0 ? (
          <p className="text-[11px] text-ink-muted">
            {q ? 'Nothing unassigned matches that search.' : 'Everything found an engineer.'}
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {unassignable.map((u) => (
              <li key={u.ticketId}>
                <button
                  type="button"
                  className={rowClass(u.ticketId)}
                  onClick={() => select(u.ticketId)}
                  draggable={!!onDragChange}
                  onDragStart={(e) => {
                    const payload: ChipDragPayload = { type: 'pool', ticketId: u.ticketId };
                    e.dataTransfer.setData(DRAG_MIME, JSON.stringify(payload));
                    e.dataTransfer.effectAllowed = 'move';
                    onDragChange?.(payload);
                  }}
                  onDragEnd={() => onDragChange?.(null)}
                >
                  <span className="block font-mono text-ink">{u.deviceId ?? u.ticketId.slice(0, 8)}</span>
                  <span className="block text-ink-muted">
                    {u.plantName ?? '—'} ·{' '}
                    {u.poolEmptyReason === 'NO_COVERAGE'
                      ? 'no coverage'
                      : u.poolEmptyReason === 'ALL_DROPPED'
                        ? 'all candidates dropped'
                        : 'reason not recorded'}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ))}

      {tab === 'held' &&
        (held.length === 0 ? (
          <p className="text-[11px] text-ink-muted">
            {q ? 'Nothing held matches that search.' : 'Nothing is being held back.'}
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {held.map((h) => (
              <li key={h.ticketId}>
                <button type="button" className={rowClass(h.ticketId)} onClick={() => select(h.ticketId)}>
                  <span className="block font-mono text-ink">{h.deviceId ?? h.ticketId.slice(0, 8)}</span>
                  <span className="block text-ink-muted">
                    {h.plantName ?? '—'} · returns {h.heldUntil}
                    {h.decidedBy ? ' · manager-approved' : ''}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ))}

      {tab === 'changes' &&
        (changeRows.length === 0 ? (
          <p className="text-[11px] text-ink-muted">
            {q ? 'No change matches that search.' : "Nobody has changed today's plan."}
          </p>
        ) : (
          <>
            {changes && (
              <p className="text-[10px] text-ink-muted">
                {changes.counts.adds} adds · {changes.counts.removes} removes · {changes.counts.swaps} swaps
              </p>
            )}
            <ul className="flex flex-col gap-1">
              {changeRows.slice(0, 12).map((c, i) => (
                <li key={`${c.ticketId}-${c.at}-${i}`}>
                  <button type="button" className={rowClass(c.ticketId)} onClick={() => select(c.ticketId)}>
                    <span className="flex items-center gap-1">
                      <Badge tone={c.kind === 'SWAP' ? 'warning' : c.kind === 'ADD' ? 'info' : 'neutral'}>
                        {c.kind.toLowerCase()}
                      </Badge>
                      <span className="font-mono text-ink">{c.ticketId.slice(0, 8)}</span>
                    </span>
                    {/* B7 — "Ravi moved it" is the operator-facing fact; the ledger used to publish
                        only a UUID. Null means the id resolved to no user, so the id stands rather
                        than a fabricated name. */}
                    <span className="block text-ink-muted">
                      {c.actorName ?? c.actorId.slice(0, 8)}
                      {c.reason ? ` · ${c.reason}` : ''}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        ))}

      {/*
        **Chronic device** (3.4 · D6/D8). The framing is deliberate and is the answer to D8: under the
        current engine no visit gets faster for these devices — `repeat_failure_penalty` is a *ticket*
        property in a score that picks an *engineer*, so it shifts every candidate identically and
        decides nothing. Promising urgency here would mis-teach on the screen whose purpose is teaching.
        What is genuinely actionable is the replacement decision, so that is what the copy says.
      */}
      {chronicCount > 0 && (
        <div className="flex flex-col gap-1 rounded-md border border-line bg-surface-sunken p-2">
          <button
            type="button"
            aria-pressed={chronicOnly}
            data-testid="pool-filter-chronic"
            onClick={() => setChronicOnly((v) => !v)}
            className={cn(
              'flex items-center gap-1.5 rounded px-1.5 py-1 text-left text-[10px] transition-colors',
              chronicOnly ? 'bg-surface font-semibold text-ink shadow-sm' : 'text-ink-muted hover:text-ink',
            )}
          >
            <span aria-hidden>⚑</span>
            Chronic device <span className="tabular-nums">{chronicCount}</span>
          </button>
          {chronicOnly && (
            <p data-testid="chronic-framing" className="text-[10px] text-ink-muted">
              {chronicThreshold}+ recorded failures on the same unit. Dispatch treats these normally —
              the question is whether to <strong>replace</strong> the unit rather than repair it again.
            </p>
          )}
        </div>
      )}

      {/* A panel, never a tab — see rule 1 in this file's docblock. */}
      <section className="mt-1 rounded-md border border-line bg-surface-sunken p-2">
        <h3 className="flex items-baseline justify-between text-[10px] font-semibold uppercase tracking-wide text-ink-muted">
          Withheld by policy
          <span className="tabular-nums text-ink">{rails.policyWithheld.count}</span>
        </h3>
        <p className="mt-0.5 text-[10px] text-ink-muted">
          Below the assignment threshold. Counted by the run, not itemised.
        </p>
      </section>
    </section>
  );
}
