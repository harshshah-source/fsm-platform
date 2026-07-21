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

    // The FLOATING leg re-validates identity against `engineer_master` LIVE (Issue 138). The
    // `plant_eligible_floating_se` MV is a territory-geometry index only — its definition joins
    // plants × engineer_territory_coverage and cannot express `coverage_type` / `is_active`, and it is
    // refreshed only on territory edits (never on an SE coverage-type flip or deactivate via
    // /engineers/manage). Trusting it alone would resurrect a now-DEDICATED or inactive SE as a floating
    // candidate. Joining the source table here makes the leg correct regardless of MV freshness.
    const floatingRows = await this.prisma.$queryRaw<{ se_id: string }[]>(
      Prisma.sql`
        SELECT pefs.se_id
        FROM plant_eligible_floating_se pefs
        JOIN engineer_master em ON em.engineer_id = pefs.se_id
        WHERE pefs.plant_id = ${plantId}
          AND em.coverage_type = 'FLOATING'
          AND em.is_active = true
        ORDER BY pefs.se_id ASC`,
    );
    const floating = floatingRows.map((r) => ({ seId: r.se_id, coverageType: 'FLOATING' as const }));

    return [...dedicated, ...multi, ...floating];
  }
}
