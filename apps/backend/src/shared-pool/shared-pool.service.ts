import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

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
  constructor(private readonly prisma: PrismaService) {}

  async getSharedPool(seId: string): Promise<SharedPoolTicket[]> {
    const plantIds = await this.coveredPlantIds(seId);
    if (plantIds.length === 0) return [];

    const tickets = await this.prisma.ticket.findMany({
      where: { plantId: { in: plantIds }, status: 'OPEN', assignmentState: 'UNASSIGNED' },
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

  /** Union of se_coverage (Dedicated/Multi-Plant) and the Floating-territory MV. */
  private async coveredPlantIds(seId: string): Promise<bigint[]> {
    const coverage = await this.prisma.seCoverage.findMany({ where: { seId }, select: { plantId: true } });
    const floating = await this.prisma.$queryRaw<{ plant_id: bigint }[]>(
      Prisma.sql`SELECT plant_id FROM plant_eligible_floating_se WHERE se_id = ${seId}::uuid`,
    );
    const ids = new Set<bigint>();
    for (const c of coverage) ids.add(c.plantId);
    for (const f of floating) ids.add(f.plant_id);
    return [...ids];
  }
}
