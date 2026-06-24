import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export type CoverageType = 'DEDICATED' | 'MULTI_PLANT' | 'FLOATING';

export interface CandidateSe {
  seId: string;
  coverageType: CoverageType;
}

/**
 * Strict-precedence candidate ordering for a plant (ADR-0001). Dedicated SE first, then Multi-Plant
 * (both from `se_coverage`), then Floating (from the `plant_eligible_floating_se` MV). Within a
 * coverage tier, ordered by `se_id` for determinism — the floating distance/capacity tie-break
 * (ADR-0006) and the availability fallback are applied by the orchestrator's hard-filter pass over
 * this ordered list. The Zonal Manager can override precedence at approval time (Issue 13).
 */
@Injectable()
export class CandidateSelectionService {
  constructor(private readonly prisma: PrismaService) {}

  async orderedCandidatesForPlant(plantId: bigint): Promise<CandidateSe[]> {
    const coverage = await this.prisma.seCoverage.findMany({
      where: { plantId },
      orderBy: { seId: 'asc' },
    });
    const dedicated = coverage
      .filter((c) => c.coverageType === 'DEDICATED')
      .map((c) => ({ seId: c.seId, coverageType: 'DEDICATED' as const }));
    const multi = coverage
      .filter((c) => c.coverageType === 'MULTI_PLANT')
      .map((c) => ({ seId: c.seId, coverageType: 'MULTI_PLANT' as const }));

    const floatingRows = await this.prisma.$queryRaw<{ se_id: string }[]>(
      Prisma.sql`SELECT se_id FROM plant_eligible_floating_se WHERE plant_id = ${plantId} ORDER BY se_id ASC`,
    );
    const floating = floatingRows.map((r) => ({ seId: r.se_id, coverageType: 'FLOATING' as const }));

    return [...dedicated, ...multi, ...floating];
  }
}
