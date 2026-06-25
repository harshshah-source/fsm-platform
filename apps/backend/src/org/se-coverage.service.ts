import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { auditActor, AuditService } from '../audit/audit.service';
import type { RequestActor } from '../common/request-actor';
import { $Enums, Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface EngineerView {
  engineerId: string;
  coverageType: string;
  zoneId: number;
  dailyCapacity: number;
  isActive: boolean;
}

export interface CreateEngineerInput {
  userId: string;
  coverageType: string;
  zoneId: number;
  dailyCapacity: number;
}

export interface SeCoverageView {
  id: number;
  seId: string;
  plantId: number;
  coverageType: string;
}

export interface CreateSeCoverageInput {
  seId: string;
  plantId: number;
  coverageType: string;
}

const COVERAGE_TYPES = new Set<string>(Object.values($Enums.CoverageType));

/**
 * SE profiles (`engineer_master`) and plant coverage (`se_coverage`) — the Operations-Head-owned
 * coverage map (schema D3). FLOATING SEs carry a profile but no se_coverage rows (territory polygon
 * arrives in Issue 09); the DB enforces that with a CHECK, and we reject it early with 400.
 */
@Injectable()
export class SeCoverageService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async listEngineers(): Promise<EngineerView[]> {
    const rows = await this.prisma.engineerMaster.findMany({ orderBy: { createdAt: 'asc' } });
    return rows.map(toEngineerView);
  }

  /** Registers an SE profile, audited (AC#6). Bad coverage type / capacity → 400; the user must
   * exist and be a SERVICE_ENGINEER → 400; duplicate profile → 409. */
  async createEngineer(input: CreateEngineerInput, actor: RequestActor): Promise<EngineerView> {
    if (!COVERAGE_TYPES.has(input.coverageType)) {
      throw new BadRequestException(`Invalid coverage type: ${input.coverageType}`);
    }
    if (!Number.isInteger(input.dailyCapacity) || input.dailyCapacity <= 0) {
      throw new BadRequestException('dailyCapacity must be a positive integer');
    }
    const user = await this.prisma.user.findUnique({ where: { userId: input.userId } });
    if (!user || user.role !== 'SERVICE_ENGINEER') {
      throw new BadRequestException('userId must reference an existing SERVICE_ENGINEER');
    }
    try {
      return await this.audit.withAudit(
        {
          ...auditActor(actor),
          action: 'ENGINEER_REGISTERED',
          entityType: 'engineer_master',
          entityId: input.userId,
        },
        async (tx) =>
          toEngineerView(
            await tx.engineerMaster.create({
              data: {
                engineerId: input.userId,
                coverageType: input.coverageType as $Enums.CoverageType,
                zoneId: BigInt(input.zoneId),
                dailyCapacity: input.dailyCapacity,
              },
            }),
          ),
      );
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException(`SE profile already exists: ${input.userId}`);
      }
      throw err;
    }
  }

  async listCoverage(seId?: string): Promise<SeCoverageView[]> {
    const rows = await this.prisma.seCoverage.findMany({
      where: seId === undefined ? undefined : { seId },
      orderBy: { id: 'asc' },
    });
    return rows.map(toSeCoverageView);
  }

  /** Maps a Dedicated/Multi-Plant SE to a plant, audited. FLOATING → 400; duplicate (se,plant) or
   * a second DEDICATED row → 409; unknown SE/plant → 404. */
  async addCoverage(input: CreateSeCoverageInput, actor: RequestActor): Promise<SeCoverageView> {
    if (!COVERAGE_TYPES.has(input.coverageType)) {
      throw new BadRequestException(`Invalid coverage type: ${input.coverageType}`);
    }
    if (input.coverageType === 'FLOATING') {
      throw new BadRequestException('FLOATING SEs use the territory table, not se_coverage');
    }
    const engineer = await this.prisma.engineerMaster.findUnique({
      where: { engineerId: input.seId },
    });
    if (!engineer) {
      throw new NotFoundException(`SE profile not found: ${input.seId}`);
    }
    const plant = await this.prisma.plant.findUnique({ where: { plantId: BigInt(input.plantId) } });
    if (!plant) {
      throw new NotFoundException(`Plant not found: ${input.plantId}`);
    }
    try {
      return await this.audit.withAudit(
        {
          ...auditActor(actor),
          action: 'SE_COVERAGE_ADDED',
          entityType: 'se_coverage',
          entityId: `${input.seId}:${input.plantId}`,
        },
        async (tx) =>
          toSeCoverageView(
            await tx.seCoverage.create({
              data: {
                seId: input.seId,
                plantId: BigInt(input.plantId),
                coverageType: input.coverageType as $Enums.CoverageType,
              },
            }),
          ),
      );
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException('Coverage already exists for this SE/plant');
      }
      throw err;
    }
  }

  /** Removes a coverage mapping, audited. Unknown id → 404. */
  async removeCoverage(id: number, actor: RequestActor): Promise<{ id: number }> {
    const existing = await this.prisma.seCoverage.findUnique({ where: { id: BigInt(id) } });
    if (!existing) {
      throw new NotFoundException(`Coverage not found: ${id}`);
    }
    return this.audit.withAudit(
      {
        ...auditActor(actor),
        action: 'SE_COVERAGE_REMOVED',
        entityType: 'se_coverage',
        entityId: String(id),
      },
      async (tx) => {
        await tx.seCoverage.delete({ where: { id: BigInt(id) } });
        return { id };
      },
    );
  }
}

function toEngineerView(row: {
  engineerId: string;
  coverageType: string;
  zoneId: bigint;
  dailyCapacity: number;
  isActive: boolean;
}): EngineerView {
  return {
    engineerId: row.engineerId,
    coverageType: row.coverageType,
    zoneId: Number(row.zoneId),
    dailyCapacity: row.dailyCapacity,
    isActive: row.isActive,
  };
}

function toSeCoverageView(row: {
  id: bigint;
  seId: string;
  plantId: bigint;
  coverageType: string;
}): SeCoverageView {
  return {
    id: Number(row.id),
    seId: row.seId,
    plantId: Number(row.plantId),
    coverageType: row.coverageType,
  };
}
