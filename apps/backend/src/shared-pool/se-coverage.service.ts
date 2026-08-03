import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/**
 * The SE coverage-floor predicate (Issue 162, workflow:792/:2011): the union of `se_coverage`
 * (Dedicated / Multi-Plant) and the `plant_eligible_floating_se` MV (Floating territory) — "which
 * plants can this SE touch." One shared definition, reused by the Shared Pool read (Issue 12), the
 * row-scoping floor on the troubleshoot-submit / soft-state writes (#162), and the merged SE
 * ticket-read surface (#161). Assignment to a specific ticket is a separate, narrower question
 * (batch assignment / `assignedSeId`) — this predicate is coverage alone, which is the floor the spec
 * fixes regardless of assignment (the Business-409/Shadow-Use model sanctions covered-plant races).
 */
@Injectable()
export class SeCoverageService {
  constructor(private readonly prisma: PrismaService) {}

  async coveredPlantIds(seId: string): Promise<bigint[]> {
    const coverage = await this.prisma.seCoverage.findMany({ where: { seId }, select: { plantId: true } });
    const floating = await this.prisma.$queryRaw<{ plant_id: bigint }[]>(
      Prisma.sql`SELECT plant_id FROM plant_eligible_floating_se WHERE se_id = ${seId}::uuid`,
    );
    const ids = new Set<bigint>();
    for (const c of coverage) ids.add(c.plantId);
    for (const f of floating) ids.add(f.plant_id);
    return [...ids];
  }

  async isPlantCovered(seId: string, plantId: bigint): Promise<boolean> {
    const ids = await this.coveredPlantIds(seId);
    return ids.some((id) => id === plantId);
  }
}
