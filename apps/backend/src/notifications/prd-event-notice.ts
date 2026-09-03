import { istDate } from '../common/ist-day';
import type { Prisma } from '../generated/prisma/client';
import { queueNotification } from '../scheduling/day-plan-notification-outbox';
// Type-only, both of them: this module is imported BY the notification producers, so a runtime edge
// back to the service (or to Prisma's client) would be a cycle for nothing.
import type { NotificationService, NotifyInput } from './notification.service';
import type { PrismaService } from '../prisma/prisma.service';

/**
 * #361 — the notification **types** for the PRD events that had no producer, in one place.
 *
 * PRD story 72 names a set of things somebody is supposed to be told about. Most of them wrote an
 * audit row and stopped there, and one of them — the voucher decision — had a page saying "the SE is
 * notified" over code that notified nobody. A promise in the UI that the code does not keep is worse
 * than silence: it stops anyone chasing the gap.
 *
 * The strings live here rather than at the eight producers because a notification `type` is a
 * **contract with the clients** — the mobile tap-router and the admin notification list both switch on
 * it, and an unknown type lands in whatever their `default` branch does. Naming them together also
 * makes the one rule this slice has to keep visible: *one notice per event, to the role the PRD
 * names.* A notice sent to everybody is read by nobody.
 */
export const PRD_NOTICE_TYPES = {
  /** → SE. The WM approved the component this engineer is waiting on. */
  componentRequestApproved: 'COMPONENT_REQUEST_APPROVED',
  /** → SE. It has shipped, with a tracking reference and a destination. */
  componentRequestShipped: 'COMPONENT_REQUEST_SHIPPED',
  /** → SE. It was refused, with the WM's reason — the engineer has to do something else. */
  componentRequestRejected: 'COMPONENT_REQUEST_REJECTED',
  /** → WM. A new request is sitting in the warehouse queue waiting for a decision. */
  componentRequestRaised: 'COMPONENT_REQUEST_RAISED',
  /** → SE. The Common Kit is short, so the recommender is skipping this engineer for that work. */
  commonKitShort: 'COMMON_KIT_SHORT',
  /** → ZM. A component request has been waiting more than {@link WAITING_COMPONENT_OVERDUE_DAYS}. */
  componentRequestOverdue: 'COMPONENT_REQUEST_WAITING_OVERDUE',
  /** → ZM. A device left the deployed fleet and its open tickets were auto-closed. */
  deviceDepartureAutoClose: 'DEVICE_DEPARTURE_AUTO_CLOSE',
  /** → OH. Ingestion is wedged: the streak threshold or a repeating poison chunk. */
  ingestionSnapshotFailed: 'INGESTION_SNAPSHOT_FAILED',
  /** → OH. Ingestion has gone silent: no SUCCESS run inside the configured cadence window. */
  ingestionSnapshotOverdue: 'INGESTION_SNAPSHOT_OVERDUE',
  /** → SE. A ZM review decision on an Expense Voucher. */
  voucherReviewed: 'VOUCHER_REVIEWED',
  /** → SE. The Operations Head marked an APPROVED voucher PAID. */
  voucherPaid: 'VOUCHER_PAID',
} as const;

/**
 * The age at which a component request the SE is still waiting on becomes the ZM's problem (INV-G4).
 *
 * Seven days, matching `dashboard.service.ts`'s `waiting_component_overdue` card and
 * `InventoryService.componentBlockedQueue`'s `warehouseOverdue` flag exactly. The card is the
 * *surfacing* and already existed; this slice adds only the push. If the two numbers ever disagree, a
 * ZM is pushed about a row their own dashboard does not yet flag — which is the fastest way to teach
 * somebody that the notice is noise.
 */
export const WAITING_COMPONENT_OVERDUE_DAYS = 7;

/** The metadata key carrying a sweep notice's day, so the dedup can key on it exactly (see below). */
export const NOTICE_DAY_KEY = 'noticeDay';

/** The IST calendar day a sweep notice belongs to, as `YYYY-MM-DD`. */
export function noticeDayKey(now: Date): string {
  return istDate(now).toISOString().slice(0, 10);
}

/** The outbox client {@link queueNoticeOnce} needs — the same subset {@link queueNotification} takes. */
type OutboxWriteClient = Pick<PrismaService, 'dayPlanNotificationOutbox'>;

/**
 * Enqueue a **sweep-driven** notice at most once per (event, entity, IST day) — inside the caller's
 * own transaction, like every other #338 enqueue. Returns the outbox row id, or `null` when today's
 * notice for this entity already exists.
 *
 * **Why this exists at all.** Three of this slice's events are produced by something that runs on a
 * timer, not by a person doing something: the Common-Kit short (every recommender run, ~daily but
 * re-runnable), the 7-day waiting-component escalation (a nightly sweep over rows that stay overdue
 * for as long as nobody acts), and the ingestion alert (a sweep whose whole point is that it fires
 * while the condition persists). Without a dedup each of those re-fires on **every tick** for as long
 * as the underlying condition lasts — and a snapshot-overdue notice arriving every few minutes does
 * not make an Operations Head act faster, it makes them mute the channel. That mute then costs every
 * *future* alert too, including the ones that would have mattered. One notice a day, per thing, is the
 * cadence a human can actually act on.
 *
 * **Why the day is in the payload rather than read off `created_at`.** `created_at` is the database
 * clock and is not injectable, so a dedup keyed on it would be un-pinnable against a frozen `now` —
 * exactly the sweep property AC3 asks to be proven by running the sweep twice. Stamping the IST day
 * the *sweep* believes it is makes the key explicit, and makes the row say afterwards which day it was
 * suppressing duplicates for.
 *
 * The read and the write are both on `tx`, so two sweeps racing inside overlapping transactions
 * serialise on the same rows the second one is about to insert — and the losing sweep's notice, if it
 * slips through, is a duplicate of one already delivered rather than a lost one. Erring towards a rare
 * double notice beats erring towards silence.
 */
export async function queueNoticeOnce(
  tx: OutboxWriteClient,
  // `entityId` is required here where `NotifyInput` leaves it optional: it is half the dedup key, and
  // a notice with nothing to key on has no "per entity" to be deduplicated per. The type says so
  // rather than the helper silently degrading to "one of these a day, globally".
  input: NotifyInput & { entityId: string },
  now: Date,
): Promise<bigint | null> {
  const day = noticeDayKey(now);
  const existing = await tx.dayPlanNotificationOutbox.findFirst({
    where: {
      eventType: 'NOTIFY',
      AND: [
        { payload: { path: ['type'], equals: input.type } },
        { payload: { path: ['entityId'], equals: input.entityId } },
        { payload: { path: ['metadata', NOTICE_DAY_KEY], equals: day } },
      ],
    },
    select: { id: true },
  });
  if (existing) return null;

  return queueNotification(tx, {
    ...input,
    metadata: { ...(input.metadata ?? {}), [NOTICE_DAY_KEY]: day },
  });
}

/**
 * #361 (INV-G3) — the "a component request is waiting for your decision" notice to the Warehouse
 * Manager, enqueued inside the raise's own transaction.
 *
 * **It lives here rather than at the raise site** because the raise is in
 * `troubleshoot-submission.service.ts`, a file this slice otherwise has no business reshaping: keeping
 * the recipient policy and the copy here reduces the edit there to one call, and puts this notice
 * beside the three component-request notices it is the counterpart of.
 *
 * **The role, not a stored id.** The warehouse queue is not zone-scoped —
 * `ComponentRequestService.queue()` carries no zone filter, deliberately, because the warehouse serves
 * every zone — so "the WM" means everyone active in the role. That is the PRD's audience, and it is
 * not a broadcast: it is one role, resolved inside the transaction so the row records who was told.
 * A vacancy is logged as `NO_RECIPIENT` by {@link NotificationService.recipientsInRoles} rather than
 * silently dropped.
 */
export async function queueWarehouseNotice(
  tx: Prisma.TransactionClient,
  notifications: NotificationService,
  request: { requestId: string; ticketId: string; seId: string },
): Promise<bigint[]> {
  const recipients = await notifications.recipientsInRoles({ role: 'WAREHOUSE_MANAGER' }, tx);
  if (recipients.length === 0) return [];
  return [
    await queueNotification(tx, {
      recipients,
      type: PRD_NOTICE_TYPES.componentRequestRaised,
      title: 'New component request',
      body:
        'An engineer reported a component unavailable and raised a request. ' +
        "The ticket's SLA clock is paused until it is approved and shipped.",
      entityType: 'component_request',
      entityId: request.requestId,
      deliveryModel: 'GENERAL',
      metadata: { ticketId: request.ticketId, seId: request.seId },
    }),
  ];
}

/** "3 days" / "1 day" — the difference between a sentence and a template with a bug in it. */
export function pluralDays(n: number): string {
  return `${n} day${n === 1 ? '' : 's'}`;
}
