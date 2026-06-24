import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/** Escalation window (ADR-0021): 3+ repeat episodes within 7 days escalates the device. */
const ESCALATION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const REPEAT_THRESHOLD = 3;

/** A cycle is the device's current episode (not a closure) while in one of these states. */
const ACTIVE_NON_ESCALATED = ['OPEN', 'WAITING_COMPONENT', 'SUBMITTED', 'REPEAT'] as const;

/**
 * RepeatEscalationService (CONTEXT "Repeat Failure", Issue 08 AC#5, ADR-0021). The daily batch that
 * surfaces chronically-failing devices: it counts each device's repeat episodes
 * (`failure_cycle.repeat_failure = true`, immutable so closed episodes still count) opened in the
 * last 7 days, and at the 3-in-7-days threshold escalates the device's active Failure Cycle + Ticket
 * to ESCALATED (notify ZM + Warehouse Manager — wired when the notification spine lands), recording a
 * lifecycle event. Escalation does **not** close the episode: the device is still down, so
 * `has_open_failure_cycle` stays set and invariant I1 (widened to cover ESCALATED) holds. Idempotent:
 * a device whose active cycle is already ESCALATED has no non-escalated cycle to transition, so a
 * re-run is a no-op. Scheduling (cron) is deferred, same posture as Issue 04's BullMQ.
 */
@Injectable()
export class RepeatEscalationService {
  constructor(private readonly prisma: PrismaService) {}

  async runEscalationScan(now: Date = new Date()): Promise<{ escalated: number }> {
    const windowStart = new Date(now.getTime() - ESCALATION_WINDOW_MS);

    const counts = await this.prisma.failureCycle.groupBy({
      by: ['deviceId'],
      where: { repeatFailure: true, openedAt: { gte: windowStart } },
      _count: { _all: true },
    });
    const chronic = counts.filter((c) => c._count._all >= REPEAT_THRESHOLD).map((c) => c.deviceId);

    let escalated = 0;
    for (const deviceId of chronic) {
      const cycle = await this.prisma.failureCycle.findFirst({
        where: { deviceId, state: { in: [...ACTIVE_NON_ESCALATED] } },
        include: { ticket: true },
      });
      if (!cycle || !cycle.ticket) continue; // already escalated, or no active episode — idempotent skip.

      await this.escalate(cycle.cycleId, cycle.ticket.ticketId, cycle.ticket.status, now);
      escalated++;
    }
    return { escalated };
  }

  /** Drive an active cycle + its ticket to ESCALATED with a lifecycle event, in one transaction. */
  private async escalate(
    cycleId: string,
    ticketId: string,
    fromStatus: string,
    now: Date,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.failureCycle.update({ where: { cycleId }, data: { state: 'ESCALATED' } });
      await tx.ticket.update({
        where: { ticketId },
        data: { status: 'ESCALATED', lastStateChangedAt: now },
      });
      await tx.ticketEvent.create({
        data: {
          ticketId,
          fromState: fromStatus,
          toState: 'ESCALATED',
          at: now,
          reasonCode: 'REPEAT_ESCALATION',
        },
      });
    });
  }
}
