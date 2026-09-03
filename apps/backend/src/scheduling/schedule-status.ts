import { type BatchStatus, type WorkScheduleStatus } from '../generated/prisma/enums';

/**
 * #153 — the one definition of "is this work schedule live today?".
 *
 * `WorkScheduleStatus` conflates two things: **lifecycle** (is the SE still expected to work this
 * plan?) and **provenance** (did a ZM adjust it?). Every ZM override — swap, split, remove, defer,
 * reorder, reassign — flips the schedule to `OVERRIDDEN` (`override.service.ts:487-490`) purely to
 * record the second, but the business workflow (`fsm-business-technical-workflow.md:1913`) transitions
 * `AUTO_ASSIGNED → OVERRIDDEN → COMPLETED | PARTIAL`: an overridden schedule is still today's work.
 *
 * Readers that hand-wrote `status: 'ACTIVE'` therefore made the SE's whole day plan and their entire
 * committed capacity vanish the moment a ZM touched anything. Every such filter now reads from here,
 * so the liveness set cannot drift apart across call sites again. `COMPLETED` and `PARTIAL` are
 * terminal and stay out: widening past those would resurrect finished work onto today's plan.
 *
 * Provenance is available without overloading lifecycle — `lastOverriddenAt` / `lastOverriddenBy` are
 * already on the row. Dropping the `OVERRIDDEN` lifecycle value in favour of those columns is the
 * cleaner end state, but it changes the meaning of a persisted enum that reports and the admin UI read
 * (see #153's design note); it needs a full consumer sweep first and is deliberately not done here.
 */
export const LIVE_SCHEDULE_STATUSES: readonly WorkScheduleStatus[] = ['ACTIVE', 'OVERRIDDEN'];

/**
 * Prisma `where` fragment for a live schedule. Spread or nest it; never re-spell the status list.
 * A factory, not a shared constant: Prisma's generated `in` filter takes a mutable array, so each
 * call site gets its own copy rather than a single array every query could reach into.
 */
export const liveScheduleFilter = (): { status: { in: WorkScheduleStatus[] } } => ({
  status: { in: [...LIVE_SCHEDULE_STATUSES] },
});

/**
 * The same liveness question one level down: is this stop still on the plan?
 *
 * `PlantBatchAssignment.status` runs `AUTO_ASSIGNED | OVERRIDDEN | COMPLETED | PARTIAL` and carries the
 * same conflation as its parent — `OVERRIDDEN` means a ZM adjusted the stop, not that it is finished —
 * so every reader that asks "what is on this SE's day plan" takes the first two.
 *
 * Named here, beside its schedule sibling, because #321 made two call sites *have* to agree: the
 * notification's stop and ticket counts are asserted against `DayPlanQueryService`, on the ground that
 * a number the SE can contradict by opening the screen the notification sent them to is worse than
 * either basis alone. Two hand-written copies of a status list is exactly how that agreement would rot.
 *
 * Seven other readers (`engineers-query`, `me-tickets-query`, `se-ticket-access`,
 * `dispatch-today-query`, `zm-schedule-query` ×2) still spell the pair inline. They answer different
 * questions on different screens and were deliberately left alone rather than swept in on a payload
 * slice; folding them in is a tidy follow-up, not a correctness one.
 */
export const LIVE_BATCH_STATUSES: readonly BatchStatus[] = ['AUTO_ASSIGNED', 'OVERRIDDEN'];

/** Prisma `where` fragment for a live stop. Same factory reasoning as {@link liveScheduleFilter}. */
export const liveBatchFilter = (): { status: { in: BatchStatus[] } } => ({
  status: { in: [...LIVE_BATCH_STATUSES] },
});

/**
 * The status the partial unique index `work_schedules_one_active_per_se_zone_day` is predicated on
 * (`... WHERE status = 'ACTIVE'`, migration `20260708120000_dispatch_idempotency_backstops`).
 *
 * Deliberately NOT `LIVE_SCHEDULE_STATUSES`: this is the *index predicate*, not a liveness question,
 * and it exists so code that reasons about a P2002 on that index names the same rows the database
 * does. Widening it here without also widening the index would report SEs that cannot be the cause of
 * the collision.
 */
export const UNIQUE_ACTIVE_SCHEDULE_INDEX_STATUS = 'ACTIVE' as const;
