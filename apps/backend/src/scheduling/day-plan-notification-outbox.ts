import { Logger } from '@nestjs/common';
import { transitionOrConflict } from '../common/transition-or-conflict';
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
      payload: { batchId: event.batchId.toString(), action: event.action },
    },
    select: { id: true },
  });
  return row.id;
}

/** The bits of one outbox row `drainRow` needs — a subset of the generated model type. */
interface OutboxRow {
  id: bigint;
  eventType: string;
  seId: string;
  scheduleId: bigint;
  zoneId: bigint | null;
  payload: unknown;
}

async function deliver(notifier: DayPlanNotifier, row: OutboxRow): Promise<void> {
  const payload = (row.payload ?? {}) as Record<string, unknown>;
  if (row.eventType === 'DAY_PLAN_DISPATCHED') {
    await notifier.dayPlanDispatched({
      seId: row.seId,
      scheduleId: row.scheduleId,
      zoneId: row.zoneId!,
      stops: Number(payload.stops ?? 0),
      tickets: Number(payload.tickets ?? 0),
    });
    return;
  }
  if (row.eventType === 'DAY_PLAN_OVERRIDDEN') {
    await notifier.dayPlanOverridden({
      seId: row.seId,
      scheduleId: row.scheduleId,
      batchId: BigInt(String(payload.batchId ?? '0')),
      action: String(payload.action ?? ''),
    });
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
): Promise<void> {
  const claim = await transitionOrConflict(
    prisma.dayPlanNotificationOutbox,
    { id: row.id, sentAt: null },
    { sentAt: now, attempts: { increment: 1 } },
  );
  if (!claim.won) return; // already sent, or another drain just claimed it

  try {
    await deliver(notifier, row);
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
): Promise<void> {
  if (rowIds.length === 0) return;
  const rows = await prisma.dayPlanNotificationOutbox.findMany({ where: { id: { in: rowIds } } });
  for (const row of rows) await drainRow(prisma, notifier, row, now);
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
): Promise<{ drained: number }> {
  const rows = await prisma.dayPlanNotificationOutbox.findMany({
    where: { sentAt: null, attempts: { lt: MAX_OUTBOX_ATTEMPTS } },
    orderBy: { createdAt: 'asc' },
    take: limit,
  });
  for (const row of rows) await drainRow(prisma, notifier, row, now);
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
