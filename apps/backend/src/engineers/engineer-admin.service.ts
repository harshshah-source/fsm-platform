import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { auditActor, AuditService } from '../audit/audit.service';
import type { RequestActor } from '../common/request-actor';
import { $Enums, Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const MANAGER_ROLES = new Set(['ZONAL_MANAGER', 'CENTRAL_SERVICE_MANAGER', 'OPERATIONS_HEAD']);
const COVERAGE_TYPES = new Set<string>(Object.values($Enums.CoverageType));
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^\+?[0-9][0-9\s-]{5,}$/;

/** The caller's real zone authority for SE management (Phase 4), mirroring the #102 install scope: a
 *  ZONAL_MANAGER is clamped to their home zone; CSM / OH act cross-zone; SERVICE_ENGINEER has no access. */
export interface EngineerAdminScope {
  role: string;
  zoneId: number | null;
  userId: string;
}

export interface CreateSeInput {
  name: string;
  phone: string;
  email: string;
  address?: string | null;
  zoneId: number;
  coverageType: string;
  dailyCapacity: number;
}

export interface UpdateSeInput {
  name?: string;
  phone?: string;
  email?: string;
  address?: string | null;
  zoneId?: number;
  coverageType?: string;
  dailyCapacity?: number;
}

export interface SeManagementRow {
  seId: string;
  name: string;
  phone: string;
  email: string;
  address: string | null;
  zoneId: number;
  coverageType: string;
  dailyCapacity: number;
  isActive: boolean;
  /** Mapped plants (SE→plant coverage); `coverageId` is the se_coverage row id (for removal). */
  plants: { id: number; name: string; coverageId: number }[];
  /** SE→company mapping is not modeled (Plant carries no company FK); always empty — the UI renders "—". */
  companies: { id: number; name: string }[];
}

export interface SeCoverageRow {
  id: number;
  seId: string;
  plantId: number;
  coverageType: string;
}

type EngineerWithRels = Prisma.EngineerMasterGetPayload<{
  include: {
    user: { select: { name: true; phone: true; email: true; status: true } };
    coverage: { include: { plant: { select: { plantId: true; name: true } } } };
  };
}>;

const ENGINEER_INCLUDE = {
  user: { select: { name: true, phone: true, email: true, status: true } },
  coverage: { include: { plant: { select: { plantId: true, name: true } } } },
} as const;

/**
 * SE Management writes (Phase 4). Service Engineers are created and maintained by admins in the app —
 * there is no external feed. This owns the SE lifecycle over the EXISTING model (`users` +
 * `engineer_master` + `se_coverage`, the exact tables the recommender's hard filters consume): create
 * (a SERVICE_ENGINEER user + its profile in one audited transaction), edit, deactivate-not-delete, and
 * the plant-coverage mappings. Authority is server-side and mirrors the #102 zone-clamp: OH / CSM act
 * cross-zone; a ZM is clamped to their home zone (out-of-zone → FORBIDDEN on create, NOT_FOUND on
 * edit/deactivate/coverage so a ticket's existence never leaks); SERVICE_ENGINEER has no access. Every
 * mutation is audited. Cross-zone SE→plant coverage is rejected even for OH — CONTEXT models coverage
 * within a zone and handles cross-zone capacity via escalation, not mapping.
 */
@Injectable()
export class EngineerAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(scope: EngineerAdminScope): Promise<SeManagementRow[]> {
    this.assertManager(scope);
    const rows = await this.prisma.engineerMaster.findMany({
      where: this.zoneFilter(scope),
      include: ENGINEER_INCLUDE,
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(toRow);
  }

  async createSe(input: CreateSeInput, scope: EngineerAdminScope, actor: RequestActor): Promise<SeManagementRow> {
    this.assertManager(scope);
    const name = (input.name ?? '').trim();
    const phone = (input.phone ?? '').trim();
    const email = (input.email ?? '').trim().toLowerCase();
    if (!name) throw new BadRequestException({ code: 'NAME_REQUIRED' });
    if (!EMAIL_RE.test(email)) throw new BadRequestException({ code: 'INVALID_EMAIL' });
    if (!PHONE_RE.test(phone)) throw new BadRequestException({ code: 'INVALID_PHONE' });
    this.assertCoverageType(input.coverageType);
    this.assertCapacity(input.dailyCapacity);

    // A ZM may only create an SE in their own zone; OH/CSM anywhere.
    if (!this.managerZoneOk(scope, BigInt(input.zoneId))) throw new ForbiddenException({ code: 'ZONE_FORBIDDEN' });
    const zone = await this.prisma.zone.findUnique({ where: { zoneId: BigInt(input.zoneId) } });
    if (!zone) throw new BadRequestException({ code: 'ZONE_NOT_FOUND' });

    const seId = randomUUID();
    try {
      await this.audit.withAudit(
        { ...auditActor(actor), action: 'SE_CREATED', entityType: 'engineer_master', entityId: seId },
        async (tx) => {
          await tx.user.create({
            data: { userId: seId, name, role: 'SERVICE_ENGINEER', phone, email, zoneId: BigInt(input.zoneId), status: 'ACTIVE' },
          });
          await tx.engineerMaster.create({
            data: {
              engineerId: seId,
              coverageType: input.coverageType as $Enums.CoverageType,
              zoneId: BigInt(input.zoneId),
              dailyCapacity: input.dailyCapacity,
              address: input.address?.trim() || null,
            },
          });
        },
      );
    } catch (e) {
      if (isUnique(e)) throw new ConflictException({ code: 'SE_IDENTITY_TAKEN' });
      throw e;
    }
    return (await this.getRow(seId, scope))!;
  }

  async updateSe(seId: string, patch: UpdateSeInput, scope: EngineerAdminScope, actor: RequestActor): Promise<SeManagementRow> {
    this.assertManager(scope);
    const eng = await this.prisma.engineerMaster.findFirst({ where: { engineerId: seId, ...this.zoneFilter(scope) } });
    if (!eng) throw new NotFoundException({ code: 'SE_NOT_FOUND' });

    const userData: Prisma.UserUpdateInput = {};
    const engData: Prisma.EngineerMasterUpdateInput = {};

    if (patch.name !== undefined) {
      const name = patch.name.trim();
      if (!name) throw new BadRequestException({ code: 'NAME_REQUIRED' });
      userData.name = name;
    }
    if (patch.email !== undefined) {
      const email = patch.email.trim().toLowerCase();
      if (!EMAIL_RE.test(email)) throw new BadRequestException({ code: 'INVALID_EMAIL' });
      userData.email = email;
    }
    if (patch.phone !== undefined) {
      const phone = patch.phone.trim();
      if (!PHONE_RE.test(phone)) throw new BadRequestException({ code: 'INVALID_PHONE' });
      userData.phone = phone;
    }
    if (patch.address !== undefined) engData.address = patch.address?.trim() || null;
    if (patch.dailyCapacity !== undefined) {
      this.assertCapacity(patch.dailyCapacity);
      engData.dailyCapacity = patch.dailyCapacity;
    }
    if (patch.coverageType !== undefined) {
      this.assertCoverageType(patch.coverageType);
      engData.coverageType = patch.coverageType as $Enums.CoverageType;
    }
    if (patch.zoneId !== undefined && patch.zoneId !== Number(eng.zoneId)) {
      // A ZM cannot move an SE out of their zone. OH/CSM can — but only if the SE has no plant coverage
      // yet, since every se_coverage row must stay in-zone (see addCoverage) — remove coverage first.
      if (scope.role === 'ZONAL_MANAGER') throw new ForbiddenException({ code: 'ZONE_FORBIDDEN' });
      const zone = await this.prisma.zone.findUnique({ where: { zoneId: BigInt(patch.zoneId) } });
      if (!zone) throw new BadRequestException({ code: 'ZONE_NOT_FOUND' });
      const coverageCount = await this.prisma.seCoverage.count({ where: { seId } });
      if (coverageCount > 0) throw new BadRequestException({ code: 'ZONE_CHANGE_WITH_COVERAGE' });
      userData.zone = { connect: { zoneId: BigInt(patch.zoneId) } };
      engData.zone = { connect: { zoneId: BigInt(patch.zoneId) } };
    }

    try {
      await this.audit.withAudit(
        { ...auditActor(actor), action: 'SE_UPDATED', entityType: 'engineer_master', entityId: seId },
        async (tx) => {
          if (Object.keys(userData).length) await tx.user.update({ where: { userId: seId }, data: userData });
          if (Object.keys(engData).length) await tx.engineerMaster.update({ where: { engineerId: seId }, data: engData });
        },
      );
    } catch (e) {
      if (isUnique(e)) throw new ConflictException({ code: 'SE_IDENTITY_TAKEN' });
      throw e;
    }
    return (await this.getRow(seId, scope))!;
  }

  /**
   * Deactivate (or reactivate) an SE — never delete: an SE with ticket / schedule / recommendation
   * history must stay referenceable. `engineer_master.is_active=false` is what the recommender's hard
   * filter reads (an inactive SE is UNAVAILABLE), and the user is DISABLED in lockstep.
   */
  async setActive(seId: string, active: boolean, scope: EngineerAdminScope, actor: RequestActor): Promise<SeManagementRow> {
    this.assertManager(scope);
    const eng = await this.prisma.engineerMaster.findFirst({ where: { engineerId: seId, ...this.zoneFilter(scope) } });
    if (!eng) throw new NotFoundException({ code: 'SE_NOT_FOUND' });
    await this.audit.withAudit(
      {
        ...auditActor(actor),
        action: active ? 'SE_REACTIVATED' : 'SE_DEACTIVATED',
        entityType: 'engineer_master',
        entityId: seId,
      },
      async (tx) => {
        await tx.engineerMaster.update({ where: { engineerId: seId }, data: { isActive: active } });
        await tx.user.update({ where: { userId: seId }, data: { status: active ? 'ACTIVE' : 'DISABLED' } });
      },
    );
    return (await this.getRow(seId, scope))!;
  }

  /** Map a DEDICATED / MULTI_PLANT SE to an IN-ZONE plant (audited). FLOATING uses the territory table. */
  async addCoverage(
    seId: string,
    plantId: number,
    coverageType: string,
    scope: EngineerAdminScope,
    actor: RequestActor,
  ): Promise<SeCoverageRow> {
    this.assertManager(scope);
    this.assertCoverageType(coverageType);
    if (coverageType === 'FLOATING') throw new BadRequestException({ code: 'FLOATING_USES_TERRITORY' });
    const eng = await this.prisma.engineerMaster.findFirst({ where: { engineerId: seId, ...this.zoneFilter(scope) } });
    if (!eng) throw new NotFoundException({ code: 'SE_NOT_FOUND' });
    const plant = await this.prisma.plant.findUnique({ where: { plantId: BigInt(plantId) } });
    if (!plant) throw new NotFoundException({ code: 'PLANT_NOT_FOUND' });
    // In-zone-only coverage (CONTEXT §5 / RBAC): coverage is within the SE's zone; cross-zone capacity is
    // handled by escalation, not by mapping an SE onto another zone's plant. Enforced even for OH/CSM.
    if (plant.zoneId !== eng.zoneId) throw new BadRequestException({ code: 'CROSS_ZONE_COVERAGE_FORBIDDEN' });

    try {
      return await this.audit.withAudit(
        { ...auditActor(actor), action: 'SE_COVERAGE_ADDED', entityType: 'se_coverage', entityId: `${seId}:${plantId}` },
        async (tx) => {
          const row = await tx.seCoverage.create({
            data: { seId, plantId: BigInt(plantId), coverageType: coverageType as $Enums.CoverageType },
          });
          return { id: Number(row.id), seId, plantId, coverageType };
        },
      );
    } catch (e) {
      if (isUnique(e)) throw new ConflictException({ code: 'COVERAGE_EXISTS' });
      throw e;
    }
  }

  async removeCoverage(seId: string, coverageId: number, scope: EngineerAdminScope, actor: RequestActor): Promise<{ id: number }> {
    this.assertManager(scope);
    const cov = await this.prisma.seCoverage.findUnique({
      where: { id: BigInt(coverageId) },
      include: { engineer: { select: { zoneId: true } } },
    });
    // Out-of-zone (for a ZM) or mismatched SE → NOT_FOUND (never leak another zone's coverage).
    if (!cov || cov.seId !== seId || !this.managerZoneOk(scope, cov.engineer.zoneId)) {
      throw new NotFoundException({ code: 'COVERAGE_NOT_FOUND' });
    }
    await this.audit.withAudit(
      { ...auditActor(actor), action: 'SE_COVERAGE_REMOVED', entityType: 'se_coverage', entityId: String(coverageId) },
      async (tx) => {
        await tx.seCoverage.delete({ where: { id: BigInt(coverageId) } });
      },
    );
    return { id: coverageId };
  }

  // ---- internals ----------------------------------------------------------

  private async getRow(seId: string, scope: EngineerAdminScope): Promise<SeManagementRow | null> {
    const e = await this.prisma.engineerMaster.findFirst({
      where: { engineerId: seId, ...this.zoneFilter(scope) },
      include: ENGINEER_INCLUDE,
    });
    return e ? toRow(e) : null;
  }

  private assertManager(scope: EngineerAdminScope): void {
    if (!MANAGER_ROLES.has(scope.role)) throw new ForbiddenException({ code: 'FORBIDDEN' });
  }

  /** ZM writes are clamped to their home zone; OH/CSM pass for any zone. */
  private managerZoneOk(scope: EngineerAdminScope, zoneId: bigint | null): boolean {
    if (scope.role !== 'ZONAL_MANAGER') return true;
    return scope.zoneId != null && zoneId != null && BigInt(scope.zoneId) === zoneId;
  }

  private zoneFilter(scope: EngineerAdminScope): { zoneId?: bigint } {
    return scope.role === 'ZONAL_MANAGER' && scope.zoneId != null ? { zoneId: BigInt(scope.zoneId) } : {};
  }

  private assertCoverageType(coverageType: string): void {
    if (!COVERAGE_TYPES.has(coverageType)) throw new BadRequestException({ code: 'INVALID_COVERAGE_TYPE' });
  }

  private assertCapacity(cap: number): void {
    if (!Number.isInteger(cap) || cap <= 0) throw new BadRequestException({ code: 'INVALID_DAILY_CAPACITY' });
  }
}

const isUnique = (e: unknown): boolean =>
  e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';

function toRow(e: EngineerWithRels): SeManagementRow {
  return {
    seId: e.engineerId,
    name: e.user.name,
    phone: e.user.phone,
    email: e.user.email,
    address: e.address,
    zoneId: Number(e.zoneId),
    coverageType: e.coverageType,
    dailyCapacity: e.dailyCapacity,
    isActive: e.isActive,
    plants: e.coverage.map((c) => ({ id: Number(c.plantId), name: c.plant.name, coverageId: Number(c.id) })),
    companies: [],
  };
}
