import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { utcDayStart } from '../common/utc-day';
import { notDeferredOn } from '../ticketing/deferral';
import { SeCoverageService } from './se-coverage.service';

export interface SharedPoolTicket {
  ticketId: string;
  workType: string;
  plantId: string;
  plantName: string;
  companyTier: string;
  slaBucket: string | null;
  deviceId: string;
}

/**
 * The SE Shared Pool read model (Issue 12) — always-visible secondary work. Returns OPEN, not-yet-
 * assigned Tickets at the SE's covered plants, regardless of how many Formal Assignments the SE
 * holds. "Covered plants" is the union of `se_coverage` (Dedicated / Multi-Plant) and the
 * `plant_eligible_floating_se` MV (Floating territory). Coverage scoping is enforced here, server-
 * side — an SE never sees out-of-coverage tickets (CONTEXT.md Shared Pool; LLD CoverageScopeGuard).
 * Read-only: there is no Reject/pick mutation on the pool.
 */
@Injectable()
export class SharedPoolService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly coverage: SeCoverageService,
  ) {}

  /**
   * `now` is injectable so the deferral gate below is testable against a fixed timeline and so a
   * caller can ask "what would this SE's pool look like on day X" — the same idiom the intraday and
   * cross-zone sweeps already use. Defaults to the wall clock for the controller.
   */
  async getSharedPool(seId: string, now: Date = new Date()): Promise<SharedPoolTicket[]> {
    const plantIds = await this.coverage.coveredPlantIds(seId);
    if (plantIds.length === 0) return [];

    const tickets = await this.prisma.ticket.findMany({
      where: {
        plantId: { in: plantIds },
        status: 'OPEN',
        assignmentState: 'UNASSIGNED',
        // #146 — a deferred ticket returns to UNASSIGNED so it can be re-planned later; offering it
        // here would hand it straight back to an SE as pickable work on the day it was deferred off.
        ...notDeferredOn(utcDayStart(now)),
      },
      orderBy: [{ plantId: 'asc' }, { createdAt: 'asc' }],
      include: {
        plant: { select: { name: true } },
        device: { select: { state: { select: { slaBucket: true } } } },
      },
    });

    return tickets.map((t) => ({
      ticketId: t.ticketId,
      workType: t.workType,
      plantId: String(t.plantId),
      plantName: t.plant.name,
      companyTier: t.companyTier,
      slaBucket: t.device.state?.slaBucket ?? null,
      deviceId: String(t.deviceId),
    }));
  }
}
