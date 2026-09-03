import { Logger } from '@nestjs/common';
import { transitionOrConflict } from '../common/transition-or-conflict';
import type { NotifyInput } from '../notifications/notification.service';
import type {
  InstallFailedActivationEvent,
  InstallNotifier,
  InstallVerifiedEvent,
} from '../ticketing/install-notifier';
import type {
  RecoveryClosedEvent,
  RecoveryNotifier,
  RecoveryUnableToCollectEvent,
} from '../ticketing/recovery-notifier';
import type { PrismaService } from '../prisma/prisma.service';
import type { DayPlanDispatchedEvent, DayPlanNotifier, DayPlanOverriddenEvent } from './day-plan-notifier';

const logger = new Logger('DayPlanNotificationOutbox');

/** Rows this many attempts old stay visible (`last_error`) rather than being retried forever. */
export const MAX_OUTBOX_ATTEMPTS = 5;
/** Sent rows older than this are pruned by the daily partition-maintenance tick (#264 AC, #104 family). */
export const OUTBOX_RETENTION_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

type OutboxWriteClient = Pick<PrismaService, 'dayPlanNotificationOutbox'>;
type OutboxReadClient = Pick<PrismaService, 'dayPlanNotificationOutbox'>;

/**
 * Write a dispatch's "Day Plan is live" intent INSIDE the caller's own writing transaction (#262's
 * per-SE tx for the morning batch), so the intent commits with the plan or not at all. Returns the
 * row id for the caller's post-commit drain.
 */
export async function queueDayPlanDispatched(
  tx: OutboxWriteClient,
  event: DayPlanDispatchedEvent,
): Promise<bigint> {
  const row = await tx.dayPlanNotificationOutbox.create({
    data: {
      eventType: 'DAY_PLAN_DISPATCHED',
      seId: event.seId,
      scheduleId: event.scheduleId,
      zoneId: event.zoneId,
      payload: { stops: event.stops, tickets: event.tickets },
    },
    select: { id: true },
  });
  return row.id;
}

/**
 * The one `DAY_PLAN_OVERRIDDEN` action that no Zonal Manager performed (#345).
 *
 * Every other action in this vocabulary is a ZM override command verbatim (`REMOVE_TICKET`,
 * `DEFER_TICKET`, `REORDER`, `SWAP_SE`, `REASSIGN`, `SPLIT_BATCH`, `MOVE_TICKET`) — the manager who
 * changed the plan is the one who typed it. A plant deactivation is an Operations-Head act on the
 * *plant*, and the SE's stop disappears as a consequence (`plant-deactivation.service.ts` strips the
 * `batch_assignment_tickets` rows in the same transaction, #241). Naming it here rather than at the
 * producer keeps the closed set of things a Day Plan notice can say in one readable place, beside the
 * writer that puts them on the wire — and it is why {@link DayPlanOverriddenEvent} grew `plantName`:
 * this is the first action whose sentence is useless without a noun.
 */
export const DAY_PLAN_ACTION_PLANT_DEACTIVATED = 'PLANT_DEACTIVATED';

/**
 * Write an override's "Day Plan updated" intent INSIDE the caller's existing `withAudit` transaction
 * (#264 AC — `dayPlanOverridden` shares the same commit-fragility as the dispatch path and must not
 * be left on the old post-commit-call mechanism).
 */
export async function queueDayPlanOverridden(
  tx: OutboxWriteClient,
  event: DayPlanOverriddenEvent,
): Promise<bigint> {
  const row = await tx.dayPlanNotificationOutbox.create({
    data: {
      eventType: 'DAY_PLAN_OVERRIDDEN',
      seId: event.seId,
      scheduleId: event.scheduleId,
      zoneId: null,
      // `plantName` is stored, not re-derived at delivery: the row has to say what the plant was
      // called *when the plan changed*, and a rename (or a master-sync) between the enqueue and the
      // drain would otherwise silently rewrite history in the notice the SE finally receives.
      payload: { batchId: event.batchId.toString(), action: event.action, plantName: event.plantName ?? null },
    },
    select: { id: true },
  });
  return row.id;
}

/** The discriminator for a general notification row (#338). */
export const NOTIFY_EVENT_TYPE = 'NOTIFY';

/**
 * Write a general notification's intent INSIDE the caller's own writing transaction (#338), so the
 * notice commits with the change it announces or not at all.
 *
 * Twelve `notify()` sites used to fire post-commit with nothing durable behind them: a crash between
 * the commit and the call lost the notice with no trace, and a *throw* in the call could take the
 * caller's own outcome with it. Both stop being possible once the row is written in the transaction.
 *
 * The payload is the **resolved** `NotifyInput` — recipients included. Resolving them here rather
 * than at drain time is deliberate: the producing service knows who the notice is for (cross-zone
 * resolves managers by role), and a row that records its own recipients can be read afterwards to
 * answer "who was told", which a row that re-derives them at delivery cannot.
 */
export async function queueNotification(tx: OutboxWriteClient, input: NotifyInput): Promise<bigint> {
  const row = await tx.dayPlanNotificationOutbox.create({
    data: {
      eventType: NOTIFY_EVENT_TYPE,
      // A general notice belongs to no engineer and no schedule. These are the two columns #338's
      // migration made nullable, and leaving them null is the point.
      seId: null,
      scheduleId: null,
      zoneId: null,
      payload: input as unknown as object,
    },
    select: { id: true },
  });
  return row.id;
}

/**
 * The four **port-delivered** event types (#338).
 *
 * `InstallNotifier` and `RecoveryNotifier` are seams with their own implementations and DI bindings,
 * not thin wrappers: `RecoveryNotifier.escalatedToOh` deliberately logs and notifies nobody, and both
 * ports resolve their own recipients. Flattening them into a resolved `NotifyInput` would therefore
 * delete a documented seam rather than convert a call — so these rows carry the *event*, and the
 * drain hands it to the port, exactly as {@link queueDayPlanDispatched}'s rows have always been
 * handed to `DayPlanNotifier`. `NOTIFY` stays the right shape for the sites that call
 * `NotificationService` directly and own no port.
 */
export const INSTALL_VERIFIED_EVENT_TYPE = 'INSTALL_VERIFIED';
export const INSTALL_FAILED_ACTIVATION_EVENT_TYPE = 'INSTALL_FAILED_ACTIVATION';
export const RECOVERY_CLOSED_EVENT_TYPE = 'RECOVERY_CLOSED';
export const RECOVERY_UNABLE_TO_COLLECT_EVENT_TYPE = 'RECOVERY_UNABLE_TO_COLLECT';

/** Write one port event inside the caller's transaction. The payload is the event, verbatim. */
async function queuePortEvent(tx: OutboxWriteClient, eventType: string, event: object): Promise<bigint> {
  const row = await tx.dayPlanNotificationOutbox.create({
    data: {
      eventType,
      // As for a general notice: a port event belongs to no engineer's schedule. `se_id` stays null
      // even when the event names an SE, because that column means "this row is that SE's day plan".
      seId: null,
      scheduleId: null,
      zoneId: null,
      payload: event as unknown as object,
    },
    select: { id: true },
  });
  return row.id;
}

/** #338 — "installation verified, ticket closed", written in the transaction that closed it. */
export function queueInstallVerified(tx: OutboxWriteClient, event: InstallVerifiedEvent): Promise<bigint> {
  return queuePortEvent(tx, INSTALL_VERIFIED_EVENT_TYPE, event);
}

/** #338 — "no ping in the activation window", written in the transaction that failed the activation. */
export function queueInstallFailedActivation(
  tx: OutboxWriteClient,
  event: InstallFailedActivationEvent,
): Promise<bigint> {
  return queuePortEvent(tx, INSTALL_FAILED_ACTIVATION_EVENT_TYPE, event);
}

/** #338 — "recovery closed on warehouse receipt", written in the transaction that closed it. */
export function queueRecoveryClosed(tx: OutboxWriteClient, event: RecoveryClosedEvent): Promise<bigint> {
  return queuePortEvent(tx, RECOVERY_CLOSED_EVENT_TYPE, event);
}

/** #338 — "unable to collect → ZM decision queue", written in the transaction that recorded it. */
export function queueRecoveryUnableToCollect(
  tx: OutboxWriteClient,
  event: RecoveryUnableToCollectEvent,
): Promise<bigint> {
  return queuePortEvent(tx, RECOVERY_UNABLE_TO_COLLECT_EVENT_TYPE, event);
}

/** The bits of one outbox row `drainRow` needs — a subset of the generated model type. */
interface OutboxRow {
  id: bigint;
  eventType: string;
  seId: string | null;
  scheduleId: bigint | null;
  zoneId: bigint | null;
  payload: unknown;
}

/**
 * The generic half of the drain (#338). Only the sweep supplies one — the post-commit `drainRows`
 * calls in `override.service` and `batch-assignment` exist to flush the day-plan rows they just
 * wrote and have no business resolving a general notice.
 */
export interface OutboxNotifyDeliverer {
  notify(input: NotifyInput): Promise<unknown>;
}

/**
 * Everything a drain can deliver *through*, named rather than positional (#338).
 *
 * A bag, not three more optional trailing parameters: the one defect this slice found in its own
 * infrastructure was a `useFactory` that stopped one positional argument short of the deliverer, and
 * every deliverer added the old way widens exactly that hole. A producer passes only its own port;
 * the sweep, which retries everybody's rows, passes all of them.
 */
export interface OutboxDeliverers {
  notify?: OutboxNotifyDeliverer;
  install?: InstallNotifier;
  recovery?: RecoveryNotifier;
}

/**
 * The row is claimed *before* delivery, so a missing deliverer must throw and never skip: a quiet
 * skip would mark a notice sent that nobody sent. Throwing un-claims the row for a drain that does
 * carry the port — the sweep.
 */
function missingDeliverer(rowId: bigint, eventType: string, which: string): Error {
  return new Error(`outbox row ${rowId} is a ${eventType} row and this drain was given no ${which} deliverer`);
}

async function deliver(notifier: DayPlanNotifier, row: OutboxRow, deliverers: OutboxDeliverers): Promise<void> {
  const payload = (row.payload ?? {}) as Record<string, unknown>;
  if (row.eventType === 'DAY_PLAN_DISPATCHED') {
    await notifier.dayPlanDispatched({
      seId: row.seId!,
      scheduleId: row.scheduleId!,
      zoneId: row.zoneId!,
      stops: Number(payload.stops ?? 0),
      tickets: Number(payload.tickets ?? 0),
    });
    return;
  }
  if (row.eventType === 'DAY_PLAN_OVERRIDDEN') {
    await notifier.dayPlanOverridden({
      seId: row.seId!,
      scheduleId: row.scheduleId!,
      batchId: BigInt(String(payload.batchId ?? '0')),
      action: String(payload.action ?? ''),
      // Absent on every row written before #345, and null on every action that names no plant.
      plantName: payload.plantName == null ? null : String(payload.plantName),
    });
    return;
  }
  if (row.eventType === NOTIFY_EVENT_TYPE) {
    if (!deliverers.notify) throw missingDeliverer(row.id, NOTIFY_EVENT_TYPE, 'notify');
    await deliverers.notify.notify(payload as unknown as NotifyInput);
    return;
  }
  if (row.eventType === INSTALL_VERIFIED_EVENT_TYPE) {
    if (!deliverers.install) throw missingDeliverer(row.id, row.eventType, 'install');
    await deliverers.install.installVerified(payload as unknown as InstallVerifiedEvent);
    return;
  }
  if (row.eventType === INSTALL_FAILED_ACTIVATION_EVENT_TYPE) {
    if (!deliverers.install) throw missingDeliverer(row.id, row.eventType, 'install');
    await deliverers.install.failedActivation(payload as unknown as InstallFailedActivationEvent);
    return;
  }
  if (row.eventType === RECOVERY_CLOSED_EVENT_TYPE) {
    if (!deliverers.recovery) throw missingDeliverer(row.id, row.eventType, 'recovery');
    await deliverers.recovery.recoveryClosed(payload as unknown as RecoveryClosedEvent);
    return;
  }
  if (row.eventType === RECOVERY_UNABLE_TO_COLLECT_EVENT_TYPE) {
    if (!deliverers.recovery) throw missingDeliverer(row.id, row.eventType, 'recovery');
    await deliverers.recovery.unableToCollect(payload as unknown as RecoveryUnableToCollectEvent);
    return;
  }
  // Unreachable under the two writers above — logged, not thrown, so one malformed row can never wedge
  // a drain pass over the rows after it.
  logger.error(`outbox row ${row.id} has unknown event_type '${row.eventType}' — skipped`);
}

/**
 * Deliver one row: claim it first (guarded `sentAt IS NULL` update — the `transitionOrConflict`
 * idiom), THEN attempt delivery. Claiming before delivering is what makes "duplicate drain (sweep
 * racing post-commit drain) delivers once" true — a losing racer sees `count: 0` and returns before
 * ever calling the notifier. A delivery failure un-claims the row (clears `sentAt`, stamps
 * `lastError`) so a LATER drain can retry it; the narrow window this reopens is only ever visible to
 * a drain that starts after this one already failed, never to a concurrent one (which already lost
 * the claim and returned).
 */
export async function drainRow(
  prisma: OutboxWriteClient,
  notifier: DayPlanNotifier,
  row: OutboxRow,
  now: Date,
  deliverers: OutboxDeliverers = {},
): Promise<void> {
  const claim = await transitionOrConflict(
    prisma.dayPlanNotificationOutbox,
    { id: row.id, sentAt: null },
    { sentAt: now, attempts: { increment: 1 } },
  );
  if (!claim.won) return; // already sent, or another drain just claimed it

  try {
    await deliver(notifier, row, deliverers);
  } catch (e) {
    // The dispatch/override this row belongs to has ALREADY committed — a delivery failure here must
    // never propagate into that outcome (#264's core guarantee). Un-claim so the sweep retries it.
    const message = e instanceof Error ? e.message : String(e);
    await prisma.dayPlanNotificationOutbox.update({
      where: { id: row.id },
      data: { sentAt: null, lastError: message },
    });
    logger.warn(`outbox row ${row.id} (${row.eventType}) delivery failed, will retry: ${message}`);
  }
}

/** Drain a specific set of rows — the post-commit "attempt delivery for the rows just written" step. */
export async function drainRows(
  prisma: OutboxReadClient & OutboxWriteClient,
  notifier: DayPlanNotifier,
  rowIds: bigint[],
  now: Date = new Date(),
  deliverers: OutboxDeliverers = {},
): Promise<void> {
  if (rowIds.length === 0) return;
  const rows = await prisma.dayPlanNotificationOutbox.findMany({ where: { id: { in: rowIds } } });
  for (const row of rows) await drainRow(prisma, notifier, row, now, deliverers);
}

/**
 * The day-plan half of a drain that will never see a day-plan row (#338).
 *
 * A producer of general notices has no `DayPlanNotifier` and no business acquiring one — injecting
 * the port into eight services so each can pass it to a drain that ignores it would be wiring for
 * nothing. It throws rather than no-ops for the same reason the missing-deliverer branch above does:
 * the claim precedes the delivery, so a quiet skip would mark a notice sent that nobody sent, while a
 * throw un-claims the row for the sweep, which carries both halves.
 */
const NOTIFY_ONLY_DRAIN: DayPlanNotifier = {
  dayPlanDispatched: () => {
    throw new Error('a day-plan row reached a drain that carries no day-plan notifier');
  },
  dayPlanOverridden: () => {
    throw new Error('a day-plan row reached a drain that carries no day-plan notifier');
  },
};

/**
 * Attempt delivery of rows a producer just wrote inside its own mutation transaction (#338) — the
 * post-commit half of the pattern, and the reason converting a `notify()` site does not delay its
 * notice to the next sweep tick. The producer passes the one deliverer its own rows need.
 *
 * A failure here is not the caller's problem and never propagates: {@link drainRow} swallows it and
 * un-claims the row, so the sweep retries it. That is the whole point of the conversion — the notice
 * survives, and a push that cannot be delivered can no longer damage the outcome it announces.
 */
export async function drainProducerRows(
  prisma: OutboxReadClient & OutboxWriteClient,
  deliverers: OutboxDeliverers,
  rowIds: bigint[],
  now: Date = new Date(),
): Promise<void> {
  await drainRows(prisma, NOTIFY_ONLY_DRAIN, rowIds, now, deliverers);
}

/**
 * The re-drain sweep (`business-notification-outbox`): retries unsent rows with bounded `attempts`.
 * Exhausted rows (>= {@link MAX_OUTBOX_ATTEMPTS}) stay visible via `lastError` rather than being
 * retried forever or silently dropped.
 */
export async function drainUnsent(
  prisma: OutboxReadClient & OutboxWriteClient,
  notifier: DayPlanNotifier,
  now: Date = new Date(),
  limit = 200,
  deliverers: OutboxDeliverers = {},
): Promise<{ drained: number }> {
  const rows = await prisma.dayPlanNotificationOutbox.findMany({
    where: { sentAt: null, attempts: { lt: MAX_OUTBOX_ATTEMPTS } },
    orderBy: { createdAt: 'asc' },
    take: limit,
  });
  for (const row of rows) await drainRow(prisma, notifier, row, now, deliverers);
  return { drained: rows.length };
}

/** Prune sent rows older than the retention window — rides the daily partition-maintenance tick
 *  (#264 AC, #104 family posture), not a cron of its own. */
export async function pruneSentDayPlanOutbox(
  prisma: Pick<PrismaService, 'dayPlanNotificationOutbox'>,
  now: Date = new Date(),
): Promise<number> {
  const horizon = new Date(now.getTime() - OUTBOX_RETENTION_DAYS * DAY_MS);
  const { count } = await prisma.dayPlanNotificationOutbox.deleteMany({
    where: { sentAt: { not: null, lt: horizon } },
  });
  if (count > 0) logger.log(`pruned ${count} sent day-plan-notification-outbox row(s) older than ${horizon.toISOString()}`);
  return count;
}
