import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/** Postgres unique-violation → Prisma P2002. Here it means invariant I1 already holds (an active
 *  Failure Cycle exists for the device), so this device is silently skipped. */
const isUniqueViolation = (e: unknown): boolean =>
  e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';

/** Repeat window (ADR-0021): a re-failure within 24h of a prior VERIFIED closure is a REPEAT. */
const REPEAT_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * TicketCreationService — the raw-telemetry-to-open-Ticket step (LLD TicketCreation, schema D6).
 *
 * Scans `device_states` for devices that are newly **inactive**, **eligible**, and have **no open
 * episode**, and for each opens one `failure_cycle` (OPEN) plus its one parented `ticket`
 * (work_type=TROUBLESHOOT, status=OPEN, `company_tier` denormalised from `company_master`), then
 * flips `has_open_failure_cycle`. All three writes commit in one transaction so a device never ends
 * up with a cycle but no ticket. The active-cycle partial-unique (invariant I1) backstops the
 * `has_open_failure_cycle` filter against races/staleness — a duplicate just skips that device.
 */
@Injectable()
export class TicketCreationService {
  constructor(private readonly prisma: PrismaService) {}

  async createForInactiveEligible(now: Date = new Date()): Promise<{ created: number }> {
    const candidates = await this.prisma.deviceState.findMany({
      where: {
        isInactive: true,
        eligibleForUptime: true,
        hasOpenFailureCycle: false,
        // A Troubleshoot Ticket needs a plant + company; a device with no current fitment can't be ticketed.
        plantId: { not: null },
        companyId: { not: null },
      },
    });
    if (candidates.length === 0) return { created: 0 };

    const companyIds = [...new Set(candidates.map((c) => c.companyId!))];
    const companies = await this.prisma.company.findMany({
      where: { companyId: { in: companyIds } },
      select: { companyId: true, companyTier: true },
    });
    const tierByCompany = new Map(companies.map((c) => [c.companyId, c.companyTier]));

    let created = 0;
    for (const ds of candidates) {
      const companyTier = tierByCompany.get(ds.companyId!);
      if (!companyTier) continue; // company row missing — skip defensively rather than violate the FK

      // Repeat detection (ADR-0021, event-driven): a prior VERIFIED cycle closed within the last 24h
      // makes this a REPEAT. "Repair completion" is GPS-verified closure, not form submission.
      const priorVerified = await this.prisma.failureCycle.findFirst({
        where: {
          deviceId: ds.deviceId,
          state: 'VERIFIED',
          closedAt: { gte: new Date(now.getTime() - REPEAT_WINDOW_MS) },
        },
        orderBy: { closedAt: 'desc' },
        select: { cycleId: true },
      });
      const isRepeat = priorVerified !== null;

      try {
        await this.prisma.$transaction(async (tx) => {
          const cycle = await tx.failureCycle.create({
            data: {
              deviceId: ds.deviceId,
              state: isRepeat ? 'REPEAT' : 'OPEN',
              openedAt: now,
              repeatFailure: isRepeat,
              previousFailureCycleId: priorVerified?.cycleId ?? null,
            },
          });
          const ticket = await tx.ticket.create({
            data: {
              workType: 'TROUBLESHOOT',
              status: 'OPEN',
              failureCycleId: cycle.cycleId,
              deviceId: ds.deviceId,
              vehicleId: ds.vehicleId,
              plantId: ds.plantId!,
              companyId: ds.companyId!,
              companyTier,
              repeatFailure: isRepeat,
              lastStateChangedAt: now,
            },
          });
          // Opening transition on the lifecycle timeline (schema D6). System-generated creation, so
          // there is no human actor; later issues append their transitions with actor/role.
          await tx.ticketEvent.create({
            data: { ticketId: ticket.ticketId, fromState: null, toState: 'OPEN', at: now },
          });
          await tx.deviceState.update({
            where: { deviceId: ds.deviceId },
            data: { hasOpenFailureCycle: true },
          });
        });
        created++;
      } catch (e) {
        if (isUniqueViolation(e)) continue; // invariant I1: an active cycle already exists — skip.
        throw e;
      }
    }

    return { created };
  }
}
