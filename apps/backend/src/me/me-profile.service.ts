import { Injectable } from '@nestjs/common';
import type { SeProfileView } from '@fsm/shared';
import { PrismaService } from '../prisma/prisma.service';

/**
 * #161 `/api/me` SE profile enrichment — see `SeProfileView`'s doc comment (`@fsm/shared`) for the
 * scope rationale (built from the two mobile reference images, not the issue's earlier pre-image-
 * review field guess).
 */
@Injectable()
export class MeProfileService {
  constructor(private readonly prisma: PrismaService) {}

  /** `null` when the caller has no `EngineerMaster` row — a real state in some dev/test fixtures
   *  (every production SE has one, created alongside the user by `engineer-admin.service.ts`), and
   *  the controller treats it the same as "no profile" rather than erroring. */
  async getSeProfile(seId: string): Promise<SeProfileView | null> {
    const engineer = await this.prisma.engineerMaster.findUnique({
      where: { engineerId: seId },
      include: {
        user: { select: { name: true, phone: true, email: true } },
        zone: { select: { name: true, zonalManagerUserId: true } },
      },
    });
    if (!engineer) return null;

    const [homePlant, reportsTo] = await Promise.all([
      this.homePlant(seId, engineer.coverageType),
      this.reportsTo(engineer.zone.zonalManagerUserId),
    ]);

    return {
      name: engineer.user.name,
      phone: engineer.user.phone,
      email: engineer.user.email,
      zoneName: engineer.zone.name,
      coverageType: engineer.coverageType,
      homePlant,
      reportsTo,
    };
  }

  /** Only `DEDICATED` coverage has a well-defined single "home" plant (CONTEXT.md). MULTI_PLANT and
   *  FLOATING SEs cover several plants/a territory with no "home" among them — `null`, not a guess. */
  private async homePlant(seId: string, coverageType: string): Promise<{ plantId: string; name: string } | null> {
    if (coverageType !== 'DEDICATED') return null;

    const coverage = await this.prisma.seCoverage.findFirst({
      where: { seId },
      orderBy: { createdAt: 'asc' },
      select: { plant: { select: { plantId: true, name: true } } },
    });
    return coverage ? { plantId: String(coverage.plant.plantId), name: coverage.plant.name } : null;
  }

  private async reportsTo(zmUserId: string | null): Promise<SeProfileView['reportsTo']> {
    if (!zmUserId) return null;
    const zm = await this.prisma.user.findUnique({
      where: { userId: zmUserId },
      select: { name: true, role: true, phone: true, email: true },
    });
    if (!zm) return null;
    return { name: zm.name, role: zm.role, phone: zm.phone, email: zm.email };
  }
}
