import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { auditActor, AuditService } from '../audit/audit.service';
import type { RequestActor } from '../common/request-actor';
import { $Enums } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { resolveActiveOverrides, resolveEffectiveTier } from './effective-tier';

const TIERS = new Set<string>(Object.values($Enums.CompanyTier));
const MIN_REASON_LENGTH = 10;
const MAX_EXPIRY_MONTHS = 2;

export interface TierOverrideView {
  id: string;
  companyId: number;
  companyName: string;
  zoneId: number;
  zoneName: string | null;
  tier: string;
  reason: string;
  expiresAt: Date;
  status: string;
  createdBy: string | null;
  createdAt: Date;
  /** True for the single live effective override of this (company, zone) pair — newest ACTIVE, unexpired (Q-A). */
  isWinning: boolean;
}

export interface CreateTierOverrideInput {
  companyId: number;
  zoneId: number;
  tier: string;
  reason: string;
  expiresAt: string;
}

export interface ListTierOverridesParams {
  status?: string;
  zoneId?: number;
  /** `YYYY-MM` — filters to overrides created within that calendar month (the monthly report read). */
  month?: string;
}

/** A positive-integer id, else 400. Bodies/queries carry ids as JSON, so `BigInt(NaN)` would throw uncaught. */
function parseId(value: number, field: string): bigint {
  if (!Number.isInteger(value) || value <= 0) {
    throw new BadRequestException(`Invalid ${field}: ${value}`);
  }
  return BigInt(value);
}

/**
 * Scoped, expiring company tier overrides (Issue 157 S2) — the CSM/ZM authority extension over
 * the OH-owned global `companies.company_tier` (#46). A ZONAL_MANAGER is clamped to their home
 * zone at this layer (the zone travels in the request body/query, not the params/query `zoneId`
 * that `ZoneScopeGuard` reads — the #102 install-scope precedent). Stacking is allowed (Q-A):
 * creating a new override never conflicts with an existing ACTIVE one for the same pair.
 */
@Injectable()
export class TierOverridesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async create(
    input: CreateTierOverrideInput,
    actor: RequestActor,
    actorHomeZoneId: number | null,
  ): Promise<TierOverrideView> {
    if (!TIERS.has(input.tier)) {
      throw new BadRequestException(`Invalid tier: ${input.tier}`);
    }
    const reason = input.reason?.trim() ?? '';
    if (reason.length < MIN_REASON_LENGTH) {
      throw new BadRequestException(`A reason of at least ${MIN_REASON_LENGTH} characters is required.`);
    }
    if (actor.role === 'ZONAL_MANAGER' && actorHomeZoneId !== input.zoneId) {
      throw new ForbiddenException('ZONE_SCOPE_VIOLATION');
    }

    const now = new Date();
    const expiresAt = new Date(input.expiresAt);
    if (Number.isNaN(expiresAt.getTime()) || expiresAt <= now) {
      throw new BadRequestException('expiresAt must be a valid date in the future.');
    }
    const maxExpiry = new Date(now);
    maxExpiry.setMonth(maxExpiry.getMonth() + MAX_EXPIRY_MONTHS);
    if (expiresAt > maxExpiry) {
      throw new BadRequestException(`expiresAt cannot be more than ${MAX_EXPIRY_MONTHS} months from now.`);
    }

    const companyId = parseId(input.companyId, 'companyId');
    const zoneId = parseId(input.zoneId, 'zoneId');
    const company = await this.prisma.company.findUnique({ where: { companyId } });
    if (!company) throw new BadRequestException(`Company ${input.companyId} does not exist`);
    const zone = await this.prisma.zone.findUnique({ where: { zoneId } });
    if (!zone) throw new BadRequestException(`Zone ${input.zoneId} does not exist`);

    const prevEffectiveTier = await resolveEffectiveTier(this.prisma, companyId, zoneId, now);

    return this.audit.withAudit(
      {
        ...auditActor(actor),
        action: 'TIER_OVERRIDE_SET',
        entityType: 'company_tier_overrides',
        entityId: `${input.companyId}:${input.zoneId}`,
        metadata: {
          companyId: input.companyId,
          zoneId: input.zoneId,
          prevEffectiveTier,
          newTier: input.tier,
          reason,
          expiresAt: expiresAt.toISOString(),
        },
      },
      async (tx) =>
        // A just-created override is the newest ACTIVE, unexpired row for its (company, zone) pair,
        // so under newest-wins (Q-A) it is the live winning override by construction.
        toView(
          await tx.companyTierOverride.create({
            data: {
              companyId,
              zoneId,
              tier: input.tier as $Enums.CompanyTier,
              reason,
              expiresAt,
              createdBy: actor.userId,
            },
            include: { company: { select: { name: true } }, zone: { select: { name: true } } },
          }),
          true,
        ),
    );
  }

  async cancel(id: bigint, actor: RequestActor, actorHomeZoneId: number | null): Promise<void> {
    const existing = await this.prisma.companyTierOverride.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException(`Tier override ${id} not found`);
    if (actor.role === 'ZONAL_MANAGER' && actorHomeZoneId !== Number(existing.zoneId)) {
      throw new ForbiddenException('ZONE_SCOPE_VIOLATION');
    }
    if (existing.status !== 'ACTIVE') {
      throw new BadRequestException(`Tier override ${id} is already ${existing.status}`);
    }

    await this.audit.withAudit(
      {
        ...auditActor(actor),
        action: 'TIER_OVERRIDE_CANCELLED',
        entityType: 'company_tier_overrides',
        entityId: id.toString(),
        metadata: {
          companyId: Number(existing.companyId),
          zoneId: Number(existing.zoneId),
          tier: existing.tier,
          reason: existing.reason,
          expiresAt: existing.expiresAt.toISOString(),
        },
      },
      async (tx) => {
        await tx.companyTierOverride.update({
          where: { id },
          data: { status: 'CANCELLED', cancelledBy: actor.userId, cancelledAt: new Date() },
        });
      },
    );
  }

  /** The monthly active-overrides report read (Q1). A ZM is clamped to their home zone regardless of `params.zoneId`. */
  async list(
    params: ListTierOverridesParams,
    actor: RequestActor,
    actorHomeZoneId: number | null,
  ): Promise<TierOverrideView[]> {
    const zoneFilter =
      actor.role === 'ZONAL_MANAGER'
        ? actorHomeZoneId != null
          ? BigInt(actorHomeZoneId)
          : undefined
        : params.zoneId != null
          ? BigInt(params.zoneId)
          : undefined;
    const monthRange = params.month ? monthBounds(params.month) : null;

    const rows = await this.prisma.companyTierOverride.findMany({
      where: {
        ...(zoneFilter !== undefined ? { zoneId: zoneFilter } : {}),
        ...(params.status ? { status: params.status as $Enums.CompanyTierOverrideStatus } : {}),
        ...(monthRange ? { createdAt: { gte: monthRange.start, lt: monthRange.end } } : {}),
      },
      include: { company: { select: { name: true } }, zone: { select: { name: true } } },
      orderBy: [{ companyId: 'asc' }, { zoneId: 'asc' }, { createdAt: 'desc' }],
    });

    // Mark the winning override per (company, zone) pair (AC-6). The winner is the LIVE effective
    // override resolved by the shared predicate (`resolveActiveOverrides` — newest ACTIVE, unexpired),
    // computed against the whole table, not just the filtered/paged rows: a row shown under a `month`
    // filter is winning only if it is still the live winner, and an ACTIVE-but-expired row (status not
    // yet swept) is never winning. Resolving over the returned rows' distinct zones covers every pair
    // on screen while reusing the engine's exact precedence rather than re-deriving it here.
    const zoneIds = [...new Set(rows.map((r) => r.zoneId))];
    const winners = await resolveActiveOverrides(this.prisma, zoneIds, new Date());
    const winningIds = new Set([...winners.values()].map((w) => w.overrideId));
    return rows.map((row) => toView(row, winningIds.has(row.id.toString())));
  }
}

function monthBounds(month: string): { start: Date; end: Date } {
  const [year, mon] = month.split('-').map(Number);
  return { start: new Date(Date.UTC(year, mon - 1, 1)), end: new Date(Date.UTC(year, mon, 1)) };
}

function toView(row: {
  id: bigint;
  companyId: bigint;
  zoneId: bigint;
  tier: string;
  reason: string;
  expiresAt: Date;
  status: string;
  createdBy: string | null;
  createdAt: Date;
  company?: { name: string };
  zone?: { name: string } | null;
}, isWinning: boolean): TierOverrideView {
  return {
    id: row.id.toString(),
    companyId: Number(row.companyId),
    companyName: row.company?.name ?? '',
    zoneId: Number(row.zoneId),
    zoneName: row.zone?.name ?? null,
    tier: row.tier,
    reason: row.reason,
    expiresAt: row.expiresAt,
    status: row.status,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    isWinning,
  };
}
