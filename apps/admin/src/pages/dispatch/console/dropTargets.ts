import type { ActionPrefill } from './ActionsBand';
import { semanticOf } from './dayAxis';
import type { Selection } from './selection';
import type { ChipDragPayload } from './WorkChip';

/**
 * **Where a dragged thing may be dropped, and what that opens** (composition correction §12, D10).
 *
 * Extracted from `BoardGrid` on 2026-08-31 when the People rail became a drop target too. It was
 * always one predicate; it is now one predicate in one file, because the alternative was two copies
 * of "is this drop legal" that have to agree forever — and the day they stop agreeing, the board and
 * the roster offer different answers about the same gesture.
 *
 * The contract this serves, unchanged:
 *
 * ```
 * drag  →  drop  →  NOTHING IS WRITTEN
 *       →  the authoritative action dialog opens, PREFILLED
 *       →  the same validation, impact preview, mandatory reason and Confirm as the typed path
 *       →  the existing endpoint — no new write path
 * ```
 *
 * **Refusal is a cursor state during the drag, never an error after it.** A cell or row that returns
 * `null` here simply never becomes a drop target, so the browser shows the no-drop cursor while the
 * operator is still deciding rather than a toast once they have committed to the gesture.
 */

/** A legal drop: which object it selects, and which dialog it opens pre-seeded. */
export interface DropIntent {
  sel: Selection;
  prefill: ActionPrefill;
}

/**
 * What a drop on `(engineer, day)` would legally initiate — or `null`, which refuses the drop.
 *
 * The asymmetry between the two ticket rules is deliberate and worth stating, because it is the one
 * an operator is most likely to trip over: moving a ticket to **someone else** is a *today* action
 * (that is a reassignment), and moving it to **another day** is a *same-engineer* action (that is a
 * deferral — "do it then, not today"). Dropping a ticket on a different engineer on a different day
 * would be two changes at once, and the dialog it would have to open does not exist.
 */
export function dropAction(
  p: ChipDragPayload,
  seId: string,
  day: string,
  today: string,
): ActionPrefill | null {
  const sem = semanticOf(day, today);
  if (p.type === 'ticket') {
    if (sem === 'today' && seId !== p.fromSeId) return { action: 'REASSIGN', seId };
    // Same engineer, a later day = "do it then, not today" — the DEFER_TICKET override, date prefilled.
    if (sem === 'future' && seId === p.fromSeId) return { action: 'DEFER_TICKET', date: day };
    return null;
  }
  if (p.type === 'pool') return sem === 'today' ? { action: 'ASSIGN', seId } : null;
  if (p.type === 'stop') return sem === 'today' && seId !== p.fromSeId ? { action: 'SWAP_SE', seId } : null;
  return null;
}

/** Pair a legal action with the object the Inspector should open on. */
export function intentFor(p: ChipDragPayload, prefill: ActionPrefill): DropIntent | null {
  if (p.type === 'stop' && p.batchId) return { sel: { kind: 'stop', id: p.batchId }, prefill };
  if (p.ticketId) return { sel: { kind: 'ticket', id: p.ticketId }, prefill };
  return null;
}
