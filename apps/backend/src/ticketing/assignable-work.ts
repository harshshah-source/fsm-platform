import type { Prisma } from '../generated/prisma/client';
import { istDate } from '../common/ist-day';
import { notDeferredOn } from './deferral';

/**
 * **"Assignable work at a plant"** — the one definition, #273 (decision #272 **R3**).
 *
 * A ticket a manual assign will actually move: `OPEN`, `UNASSIGNED`, and not held to a future date.
 * All three clauses are load-bearing and none is obvious from the outside — which is why they were
 * spelled differently in the two places that mattered, and why the console could not have been fed
 * from either without first picking one.
 *
 * **The fork this closes.** `assignPlants` writes exactly this set (`override.service.ts`), while
 * `plantDeviceStats` counts a plant's tickets **by `assignment_state` alone**
 * (`dispatch-transparency-query.service.ts`) — no status clause beyond #178's resolved carve-out, and
 * no deferral clause at all. Feeding the work pool from the second while committing through the first
 * would put a number on screen the button beside it cannot move: every `VERIFICATION_PENDING` ticket
 * and every deliberately deferred one would be counted as work waiting to be handed out. The console
 * exists to make "how much is left" answerable, so its arithmetic has to be the write's arithmetic.
 *
 * `day` is normalised with {@link istDate} here rather than at each call site — the operating day is
 * IST (CONTEXT.md Decisions §19) and `deferred_until` is a `@db.Date`. `istDate` is idempotent, so a
 * caller that already normalised is unaffected.
 *
 * @see heldAtPlants — the exact complement, so "held" is never inferred by subtraction.
 */
export function assignableTickets(day: Date): Prisma.TicketWhereInput {
  return { status: 'OPEN', assignmentState: 'UNASSIGNED', ...notDeferredOn(istDate(day)) };
}

/**
 * The work a manual assign will deliberately **not** move: open and unassigned, but held to a future
 * date by a human decision or by a vehicle's return date (#146/#246).
 *
 * Reported beside {@link assignableTickets} rather than left to subtraction. A dispatcher who can see
 * 12 devices at a plant and is offered 9 needs the missing 3 accounted for on screen; without it the
 * console reads as though work vanished, and the natural next move is to go looking for it. Deriving
 * it as `total − assignable` would also quietly absorb any future exclusion into "held", which is the
 * kind of number that is wrong for a year before anyone notices.
 */
export function heldTickets(day: Date): Prisma.TicketWhereInput {
  return { status: 'OPEN', assignmentState: 'UNASSIGNED', deferredUntil: { gt: istDate(day) } };
}
