import { Injectable } from '@nestjs/common';
import { istDate } from '../common/ist-day';
import { Prisma } from '../generated/prisma/client';
import { NotificationService } from '../notifications/notification.service';
import { PrismaService } from '../prisma/prisma.service';
import { drainProducerRows, queueNotification } from '../scheduling/day-plan-notification-outbox';
import { liveScheduleFilter } from '../scheduling/schedule-status';

/** What one unavailability did to one engineer's day. */
export interface StrandedWorkOutcome {
  /** Tickets that gained an `ESCALATION_REQUIRED` row on this call. */
  escalated: number;
  ticketIds: string[];
}

/** The insertion-ledger `insertion_type` this path writes — a plain TEXT column, so no migration. */
export const SE_UNAVAILABLE_INSERTION_TYPE = 'SE_UNAVAILABLE';

/**
 * #288 — an SE who becomes unavailable mid-day does not silently strand their work.
 *
 * **Escalate-only, ruled by the operator on 2026-08-25 (#282 R4).** Nothing here re-plans: no
 * assignment row is written, removed or moved, the day plan is not rewritten, and no capacity is
 * bypassed. The plan history stays intact and auditable — a human redistributes through the manual
 * paths that already exist. What this adds is *visibility*: the SE's remaining committed work becomes
 * work a human has been asked to decide about, instead of sitting on a plan nobody will execute.
 *
 * **It re-uses the escalation surface rather than inventing one.** An `intraday_insertions` row at
 * `ESCALATION_REQUIRED` is already the system's way of saying "this ticket needs a manager", already
 * the Intra-day Queue's contents, and already what `manualAssign` resolves. A second escalation
 * vocabulary would mean a ZM had two queues to watch, one of which nobody built a screen for.
 *
 * **Why this replaces nothing that still exists.** `hard-filters.ts` retired the ADR-0016 heartbeat
 * filter pointing at "Acceptance Timeout + reroute (Issue 29/30)" — machinery #268 deleted — so the
 * documented recovery path for intra-day unreachability had no implementation at all, and no
 * replacement was filed. This is the replacement, in the shape the operator chose.
 */
@Injectable()
export class StrandedWorkEscalationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationService = new NotificationService(prisma),
  ) {}

  /**
   * Raise one escalation per live remaining ticket on `seId`'s day plan for the operating day.
   *
   * "Remaining" is deliberately the same two facts the rest of the system uses, not a third
   * definition: a `batch_assignment_tickets` row still `removed_at IS NULL` on a **live** schedule
   * covering the day (`committedDayPlan`'s predicate — #269's one definition of committed), and a
   * ticket still `OPEN`. A ticket already submitted, verified, closed or removed from the plan is not
   * work anybody still has to go and do, which is AC2.
   *
   * The existing re-escalation guard is reused verbatim — `intradayInsertions: { none: { status:
   * 'ESCALATION_REQUIRED' } }`. A live escalation row is that ticket's "a human already knows" marker,
   * so an SE whose availability is written twice (a leave approval, then a window edit) does not
   * produce a second ledger row or a second alert (AC4).
   */
  async escalateStrandedWork(seId: string, now: Date = new Date()): Promise<StrandedWorkOutcome> {
    const day = istDate(now);
    const rows = await this.prisma.batchAssignmentTicket.findMany({
      where: {
        removedAt: null,
        batch: { seId, schedule: { ...liveScheduleFilter(), dateFrom: { lte: day }, dateTo: { gte: day } } },
        ticket: {
          status: 'OPEN',
          // The guard #268 wrote, for the reason #268 wrote it: one unavailability, one alert.
          intradayInsertions: { none: { status: 'ESCALATION_REQUIRED' } },
        },
      },
      select: {
        ticketId: true,
        batch: { select: { schedule: { select: { zoneId: true } } } },
        ticket: { select: { device: { select: { state: { select: { slaBucket: true } } } } } },
      },
      orderBy: { id: 'asc' },
    });
    if (rows.length === 0) return { escalated: 0, ticketIds: [] };

    const seName = (
      await this.prisma.user.findUnique({ where: { userId: seId }, select: { name: true } })
    )?.name;

    // #338 — one transaction over the whole unavailability: every ledger row, and the alert that says
    // they exist. This path had none, and the partial state that allowed is the one #288's own
    // re-escalation guard then *hides* — a live `ESCALATION_REQUIRED` row is its "a human already
    // knows" marker, so a crash after row three left the rest of the day unescalated AND unescalatable
    // on the next availability write, with nobody having been told about the three.
    const queuedNotices = await this.prisma.$transaction(async (tx) => {
      const byZone = new Map<bigint, string[]>();
      for (const row of rows) {
        const zoneId = row.batch.schedule.zoneId;
        await tx.intradayInsertion.create({
          data: {
            ticketId: row.ticketId,
            zoneId,
            insertionType: SE_UNAVAILABLE_INSERTION_TYPE,
            slaBucket: row.ticket.device?.state?.slaBucket ?? null,
            // No SE was offered this work — the engineer named below is the one it is being taken
            // *from*. Writing them here would say the opposite of what happened (#268's own reason
            // for the null).
            offeredSeId: null,
            offeredAt: now,
            acceptanceDeadline: null,
            respondedAt: now,
            status: 'ESCALATION_REQUIRED',
          },
        });
        byZone.set(zoneId, [...(byZone.get(zoneId) ?? []), row.ticketId]);
      }

      const queued: bigint[] = [];
      for (const [zoneId, ticketIds] of byZone) {
        const outboxId = await this.alertZm(tx, zoneId, seId, seName ?? null, ticketIds);
        if (outboxId !== null) queued.push(outboxId);
      }
      return queued;
    });

    // Delivered post-commit: the escalations are the durable fact, the push is an attempt at it.
    await drainProducerRows(this.prisma, { notify: this.notifications }, queuedNotices, now);

    return { escalated: rows.length, ticketIds: rows.map((r) => r.ticketId) };
  }

  /**
   * **One alert per unavailability, not one per ticket.** The ledger needs a row each — that is what
   * the queue lists and what the guard keys on — but the *decision* is a single one: this engineer's
   * day has to be redistributed. Eight notifications for eight stops would be the storm the guard
   * exists to prevent, arriving by a different door.
   *
   * `INTRADAY_ESCALATION_REQUIRED` is reused rather than given a new type: it is the ZM's existing
   * "manual assignment needed" channel, and a new type would land in whatever a client's `default`
   * branch does with an unknown one.
   *
   * **#356 AC4 (absorbing #331 AC1).** Recipients come from
   * {@link NotificationService.zoneManagerRecipients} — designated manager, else the zone's role
   * holders, else a logged miss — where this used to read `zones.zonal_manager_user_id` and return on
   * null. That silence was worse here than at the sweep's own escalation site: this path writes a
   * ledger row per stranded ticket, and #288's re-escalation guard keys on those rows. A zone with no
   * designated ZM therefore got the "a human already knows" marker for work no human had been told
   * about, and the next availability write on that engineer would decline to escalate it again. The
   * day's work went quiet in a way nothing could reopen.
   */
  private async alertZm(
    tx: Prisma.TransactionClient,
    zoneId: bigint,
    seId: string,
    seName: string | null,
    ticketIds: string[],
  ): Promise<bigint | null> {
    const recipients = await this.notifications.zoneManagerRecipients(zoneId, tx);
    if (recipients.length === 0) return null;
    const who = seName ?? seId;
    return queueNotification(tx, {
      recipients,
      type: 'INTRADAY_ESCALATION_REQUIRED',
      title: 'Engineer unavailable — work needs reassignment',
      body: `${who} is unavailable for the rest of today. ${ticketIds.length} committed ticket${
        ticketIds.length === 1 ? '' : 's'
      } still need an engineer — nothing has been reassigned automatically.`,
      entityType: 'engineer_master',
      entityId: seId,
      deliveryModel: 'GENERAL',
      metadata: { seId, ticketIds, zoneId: String(zoneId) },
    });
  }
}
