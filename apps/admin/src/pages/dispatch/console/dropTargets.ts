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
 * ## The full matrix, stated once
 *
 * | drag  | target column | target engineer | opens          |
 * |-------|---------------|-----------------|----------------|
 * | chip  | today         | same            | — (a no-op)    |
 * | chip  | today         | different       | `REASSIGN`     |
 * | chip  | future        | same            | `MOVE_TICKET`  |
 * | chip  | future        | different       | `MOVE_TICKET`  |
 * | chip  | past          | any             | —              |
 * | stop  | today         | different       | `SWAP_SE`      |
 * | stop  | anything else | any             | —              |
 * | pool  | today         | any             | `ASSIGN`       |
 * | pool  | anything else | any             | —              |
 *
 * ## Why the future row changed, and what it used to say
 *
 * Dropping a chip on a later day used to open **`DEFER_TICKET`**, and only when the target engineer
 * was the same one. Both halves of that were wrong.
 *
 * A defer *unassigns*: it sets `deferred_until`, returns the ticket to `UNASSIGNED`, and leaves who
 * does the work on that date to the run that will decide it. So the gesture "put this on Wednesday
 * for this engineer" was answered by "take it off everyone and reconsider it on Wednesday" — and
 * since a deferred ticket belongs to nobody, it could not appear in the cell it was dropped on. The
 * operator saw their ticket vanish from today, an `adjusted` badge on the stop it left, and nothing
 * at all on the day they aimed at. It read as the system ignoring them. It was the system doing a
 * different thing and not saying so.
 *
 * `MOVE_TICKET` is that gesture's actual meaning: the assignment relocates and stays an assignment.
 *
 * **The diagonal is now legal**, and it is not two changes at once — it is one, stated in the two
 * coordinates a cell has. `MOVE_TICKET` carries `newSeId` *and* `targetDate` in one command, one
 * transaction and one confirm, so nothing has to be split into a reassignment followed by a move.
 *
 * ## Defer did not go anywhere
 *
 * It stays a **typed** action on the Inspector's Actions band, which is the right home for it: defer
 * is a decision about *whether* work happens ("not today, and I'm not saying who"), and the board's
 * day axis is about *when and by whom*. A gesture that names a cell should not be able to produce an
 * outcome that belongs to no cell.
 */
export function dropAction(
  p: ChipDragPayload,
  seId: string,
  day: string,
  today: string,
): ActionPrefill | null {
  const sem = semanticOf(day, today);
  if (p.type === 'ticket') {
    if (sem === 'today') return seId !== p.fromSeId ? { action: 'REASSIGN', seId } : null;
    // A later day — for this engineer or another one. Both coordinates the drop named are carried.
    if (sem === 'future') return { action: 'MOVE_TICKET', seId, date: day };
    return null;
  }
  if (p.type === 'pool') return sem === 'today' ? { action: 'ASSIGN', seId } : null;
  // A whole stop is deliberately not movable across days: it is several tickets at one plant, and
  // splitting the day question from the who question for a set is a different dialog than any that
  // exists. Refused as a cursor state, never silently downgraded into something else.
  if (p.type === 'stop') return sem === 'today' && seId !== p.fromSeId ? { action: 'SWAP_SE', seId } : null;
  return null;
}

/** Pair a legal action with the object the Inspector should open on. */
export function intentFor(p: ChipDragPayload, prefill: ActionPrefill): DropIntent | null {
  if (p.type === 'stop' && p.batchId) return { sel: { kind: 'stop', id: p.batchId }, prefill };
  if (p.ticketId) return { sel: { kind: 'ticket', id: p.ticketId }, prefill };
  return null;
}
