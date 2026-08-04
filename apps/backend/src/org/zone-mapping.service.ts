import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { auditActor, AuditService } from '../audit/audit.service';
import type { RequestActor } from '../common/request-actor';
import { type ZoneMappingStatus } from '../generated/prisma/enums';
import {
  normalizeZoneKey,
  UNZONED_ZONE_NAME,
  ZONE_MAPPING_SOURCE_FIELD,
} from '../ingestion/autoplant/mapping-table-zone-resolver';
import { PrismaService } from '../prisma/prisma.service';
import { liveScheduleFilter } from '../scheduling/schedule-status';
import { istDate } from '../common/ist-day';
import { resolveActiveOverrides, tierOverrideKey } from './effective-tier';

export interface ZoneMappingView {
  id: string;
  sourceField: string;
  sourceValueKey: string;
  sourceValueRaw: string | null;
  fsmZoneId: string | null;
  fsmZoneName: string | null;
  status: string;
  seenCount: number;
  lastSeenAt: Date | null;
}

export interface PlantZoneOverrideView {
  sourcePlantId: string;
  fsmZoneId: string;
  fsmZoneName: string | null;
  reason: string | null;
}

/**
 * What moving a plant between zones will actually affect (#158 AC-6). Devices and open tickets carry
 * no zone of their own, so they re-scope the instant `reapply` moves `plants.zone_id` — harmless, but
 * worth showing. `dispatchedTodayCount` is the one that needs a warning: `work_schedules` are keyed by
 * the zone at dispatch time and stay under the OLD zone, so a mid-day move splits today's picture —
 * the old zone's ZM keeps the day plan while the new zone's ZM sees the tickets.
 */
/** A company's live winning tier override in one zone — what a plant move detaches or attaches (#157 AC-9). */
export interface TierOverrideBrief {
  companyId: number;
  companyName: string;
  tier: string;
}

export interface ZoneChangeImpact {
  plantName: string;
  currentZoneName: string | null;
  deviceCount: number;
  openTicketCount: number;
  dispatchedTodayCount: number;
  /** Winning active overrides for the plant's open-ticket companies in the CURRENT zone — these stop applying on a move (#157 AC-9). */
  currentZoneOverrides: TierOverrideBrief[];
  /** Same, in the TARGET zone (when one is supplied) — these start applying after the move. Empty otherwise. */
  targetZoneOverrides: TierOverrideBrief[];
}

export interface ReapplyResult {
  plantsConsidered: number;
  updated: number;
  unchanged: number;
  landedUnzoned: number;
}

/**
 * The FSM-owned, admin-editable zone-mapping crosswalk (R6 translation layer). Backs the
 * `/api/org/zone-mappings` + `/api/org/plant-zone-overrides` admin surface. AutoPlant owns the raw
 * `zone_name`; FSM owns the mapping to an operational Zone — all as data, nothing hardcoded.
 *
 * `reapply` is the load-bearing piece: because master-sync is insert-only on `plants.zone_id`
 * (anti-drift), an admin edit here does NOT take effect on already-synced plants until this runs. It
 * recomputes `plants.zone_id` for every synced plant from the CURRENT overrides + mappings (same
 * precedence as the resolver, minus pending-discovery), using the source values already mirrored on the
 * plant row — no AutoPlant/VPN access needed. This is the one sanctioned FSM-owned write to `zone_id`.
 */
@Injectable()
export class ZoneMappingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async listMappings(status?: string): Promise<ZoneMappingView[]> {
    const rows = await this.prisma.zoneMapping.findMany({
      where: status ? { status: status as ZoneMappingStatus } : undefined,
      include: { zone: { select: { name: true } } },
      orderBy: [{ status: 'asc' }, { seenCount: 'desc' }],
    });
    return rows.map(toMappingView);
  }

  /** The admin work queue: PENDING values first-seen during sync, busiest first. */
  async listPending(): Promise<ZoneMappingView[]> {
    return this.listMappings('PENDING');
  }

  /** Bind a discovered value to an FSM zone (→ MAPPED). Audited. Takes effect after `reapply`. */
  async mapValue(id: bigint, fsmZoneId: bigint, actor: RequestActor): Promise<ZoneMappingView> {
    await this.assertZoneExists(fsmZoneId);
    const existing = await this.prisma.zoneMapping.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException(`Zone mapping ${id} not found`);
    return this.audit.withAudit(
      {
        ...auditActor(actor),
        action: 'ZONE_MAPPING_MAPPED',
        entityType: 'zone_mappings',
        entityId: id.toString(),
      },
      async (tx) =>
        toMappingView(
          await tx.zoneMapping.update({
            where: { id },
            data: { fsmZoneId, status: 'MAPPED', updatedBy: actor.userId },
            include: { zone: { select: { name: true } } },
          }),
        ),
    );
  }

  /** Mark a value junk (→ IGNORED, unmapped). It still lands UNZONED but leaves the work queue. Audited. */
  async ignoreValue(id: bigint, actor: RequestActor): Promise<ZoneMappingView> {
    const existing = await this.prisma.zoneMapping.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException(`Zone mapping ${id} not found`);
    return this.audit.withAudit(
      {
        ...auditActor(actor),
        action: 'ZONE_MAPPING_IGNORED',
        entityType: 'zone_mappings',
        entityId: id.toString(),
      },
      async (tx) =>
        toMappingView(
          await tx.zoneMapping.update({
            where: { id },
            data: { fsmZoneId: null, status: 'IGNORED', updatedBy: actor.userId },
            include: { zone: { select: { name: true } } },
          }),
        ),
    );
  }

  async listOverrides(): Promise<PlantZoneOverrideView[]> {
    const rows = await this.prisma.plantZoneOverride.findMany({
      include: { zone: { select: { name: true } } },
      orderBy: { sourcePlantId: 'asc' },
    });
    return rows.map(toOverrideView);
  }

  /**
   * Pin a specific AutoPlant plant to a zone (highest resolver precedence). Audited. Effective on reapply.
   *
   * A `reason` is mandatory, and the audit row carries prev/new zone, because this is an UPSERT of a
   * single row per plant: re-pinning overwrites `fsm_zone_id` and `reason` in place (and leaves
   * `created_by` at the original author), so `audit_logs` is the ONLY place the previous zone survives.
   */
  async upsertOverride(
    sourcePlantId: bigint,
    fsmZoneId: bigint,
    reason: string | null,
    actor: RequestActor,
  ): Promise<PlantZoneOverrideView> {
    const trimmedReason = reason?.trim();
    if (!trimmedReason) {
      throw new BadRequestException('A reason is required to reassign a plant to a zone.');
    }
    await this.assertZoneExists(fsmZoneId);
    const previous = await this.prisma.plantZoneOverride.findUnique({ where: { sourcePlantId } });
    return this.audit.withAudit(
      {
        ...auditActor(actor),
        action: 'PLANT_ZONE_OVERRIDE_SET',
        entityType: 'plant_zone_overrides',
        entityId: sourcePlantId.toString(),
        metadata: {
          prevFsmZoneId: previous ? previous.fsmZoneId.toString() : null,
          newFsmZoneId: fsmZoneId.toString(),
          reason: trimmedReason,
        },
      },
      async (tx) =>
        toOverrideView(
          await tx.plantZoneOverride.upsert({
            where: { sourcePlantId },
            create: { sourcePlantId, fsmZoneId, reason: trimmedReason, createdBy: actor.userId },
            update: { fsmZoneId, reason: trimmedReason },
            include: { zone: { select: { name: true } } },
          }),
        ),
    );
  }

  /**
   * Blast radius of a pending zone change, for the admin confirmation step. Unknown plant → 404.
   * When `targetZoneId` is supplied, also names the tier overrides that a move would detach (current
   * zone) and attach (target zone) for the plant's open-ticket companies (#157 AC-9) — overrides are
   * keyed (company, zone), so a plant's zone move silently re-attaches them, and the admin should see
   * that before confirming.
   */
  async zoneChangeImpact(sourcePlantId: bigint, targetZoneId?: bigint): Promise<ZoneChangeImpact> {
    const plant = await this.prisma.plant.findUnique({
      where: { sourcePlantId },
      include: { zone: { select: { name: true } } },
    });
    if (!plant) throw new NotFoundException(`No synced plant with source id ${sourcePlantId}`);

    const day = istDate(new Date());
    const [deviceCount, openTicketCount, dispatchedTodayCount, openTicketCompanies] = await Promise.all([
      this.prisma.device.count({ where: { currentVehicle: { plantId: plant.plantId } } }),
      this.prisma.ticket.count({ where: { plantId: plant.plantId, status: 'OPEN' } }),
      this.prisma.batchAssignmentTicket.count({
        where: {
          removedAt: null,
          batch: {
            plantId: plant.plantId,
            schedule: { ...liveScheduleFilter(), dateFrom: { lte: day }, dateTo: { gte: day } },
          },
        },
      }),
      this.prisma.ticket.findMany({
        where: { plantId: plant.plantId, status: 'OPEN' },
        select: { companyId: true },
        distinct: ['companyId'],
      }),
    ]);

    const { currentZoneOverrides, targetZoneOverrides } = await this.overrideBriefs(
      openTicketCompanies.map((t) => t.companyId),
      plant.zoneId,
      targetZoneId,
    );

    return {
      plantName: plant.name,
      currentZoneName: plant.zone?.name ?? null,
      deviceCount,
      openTicketCount,
      dispatchedTodayCount,
      currentZoneOverrides,
      targetZoneOverrides,
    };
  }

  /**
   * The winning active override per (company, zone) for the given companies, split by current vs target
   * zone. Winner is resolved by the SHARED predicate {@link resolveActiveOverrides} (newest ACTIVE,
   * unexpired) so this warning names exactly what the recommender would apply — never a stale/expired row.
   */
  private async overrideBriefs(
    companyIds: bigint[],
    currentZoneId: bigint,
    targetZoneId?: bigint,
  ): Promise<{ currentZoneOverrides: TierOverrideBrief[]; targetZoneOverrides: TierOverrideBrief[] }> {
    if (companyIds.length === 0) return { currentZoneOverrides: [], targetZoneOverrides: [] };

    const zoneIds = targetZoneId != null && targetZoneId !== currentZoneId ? [currentZoneId, targetZoneId] : [currentZoneId];
    const winners = await resolveActiveOverrides(this.prisma, zoneIds, new Date());

    const pick = (zoneId: bigint): Array<{ companyId: bigint; tier: string }> =>
      companyIds.flatMap((companyId) => {
        const w = winners.get(tierOverrideKey(companyId, zoneId));
        return w ? [{ companyId, tier: w.tier }] : [];
      });
    const current = pick(currentZoneId);
    const target = targetZoneId != null ? pick(targetZoneId) : [];

    const named = new Set<bigint>([...current, ...target].map((x) => x.companyId));
    const companies = named.size
      ? await this.prisma.company.findMany({ where: { companyId: { in: [...named] } }, select: { companyId: true, name: true } })
      : [];
    const nameById = new Map(companies.map((c) => [c.companyId, c.name]));
    const toBrief = (x: { companyId: bigint; tier: string }): TierOverrideBrief => ({
      companyId: Number(x.companyId),
      companyName: nameById.get(x.companyId) ?? '',
      tier: x.tier,
    });

    return { currentZoneOverrides: current.map(toBrief), targetZoneOverrides: target.map(toBrief) };
  }

  async deleteOverride(sourcePlantId: bigint, actor: RequestActor): Promise<void> {
    const existing = await this.prisma.plantZoneOverride.findUnique({ where: { sourcePlantId } });
    if (!existing) throw new NotFoundException(`Override for plant ${sourcePlantId} not found`);
    await this.audit.withAudit(
      {
        ...auditActor(actor),
        action: 'PLANT_ZONE_OVERRIDE_CLEARED',
        entityType: 'plant_zone_overrides',
        entityId: sourcePlantId.toString(),
        metadata: {
          prevFsmZoneId: existing.fsmZoneId.toString(),
          newFsmZoneId: null,
          reason: existing.reason,
        },
      },
      async (tx) => {
        await tx.plantZoneOverride.delete({ where: { sourcePlantId } });
      },
    );
  }

  /**
   * Recompute `plants.zone_id` for every synced plant from the current overrides + mappings. Precedence:
   * plant override → MAPPED value-map (on the plant's mirrored `sourceZoneName`) → UNZONED. Only plants
   * whose zone actually changes are written. This is the FSM-owned effect of an admin edit — sync itself
   * never moves an existing plant's zone.
   */
  async reapply(actor: RequestActor): Promise<ReapplyResult> {
    const unzoned = await this.prisma.zone.findFirst({
      where: { name: { equals: UNZONED_ZONE_NAME, mode: 'insensitive' } },
      select: { zoneId: true },
    });
    if (!unzoned) {
      throw new BadRequestException(
        `UNZONED holding zone "${UNZONED_ZONE_NAME}" is not seeded — cannot re-apply zone mappings.`,
      );
    }

    const [overrides, mappings, plants] = await Promise.all([
      this.prisma.plantZoneOverride.findMany({ select: { sourcePlantId: true, fsmZoneId: true } }),
      this.prisma.zoneMapping.findMany({
        where: { sourceField: ZONE_MAPPING_SOURCE_FIELD, status: 'MAPPED', fsmZoneId: { not: null } },
        select: { sourceValueKey: true, fsmZoneId: true },
      }),
      this.prisma.plant.findMany({
        where: { sourcePlantId: { not: null } },
        select: { plantId: true, zoneId: true, sourcePlantId: true, sourceZoneName: true },
      }),
    ]);

    const overrideByPlant = new Map(overrides.map((o) => [o.sourcePlantId.toString(), o.fsmZoneId]));
    const zoneByKey = new Map(mappings.map((m) => [m.sourceValueKey, m.fsmZoneId!]));

    let updated = 0;
    let unchanged = 0;
    let landedUnzoned = 0;
    for (const p of plants) {
      const target =
        overrideByPlant.get(p.sourcePlantId!.toString()) ??
        zoneByKey.get(normalizeZoneKey(p.sourceZoneName)) ??
        unzoned.zoneId;
      if (target === unzoned.zoneId) landedUnzoned++;
      if (p.zoneId === target) {
        unchanged++;
        continue;
      }
      await this.prisma.plant.update({ where: { plantId: p.plantId }, data: { zoneId: target } });
      updated++;
    }

    const result: ReapplyResult = {
      plantsConsidered: plants.length,
      updated,
      unchanged,
      landedUnzoned,
    };
    await this.audit.withAudit(
      {
        ...auditActor(actor),
        action: 'ZONE_MAPPING_REAPPLIED',
        entityType: 'plants',
        entityId: 'ALL',
        metadata: {
          plantsConsidered: result.plantsConsidered,
          updated: result.updated,
          unchanged: result.unchanged,
          landedUnzoned: result.landedUnzoned,
        },
      },
      async () => result,
    );
    return result;
  }

  private async assertZoneExists(fsmZoneId: bigint): Promise<void> {
    const zone = await this.prisma.zone.findUnique({ where: { zoneId: fsmZoneId }, select: { zoneId: true } });
    if (!zone) throw new BadRequestException(`Zone ${fsmZoneId} does not exist`);
  }
}

function toMappingView(row: {
  id: bigint;
  sourceField: string;
  sourceValueKey: string;
  sourceValueRaw: string | null;
  fsmZoneId: bigint | null;
  status: string;
  seenCount: number;
  lastSeenAt: Date | null;
  zone?: { name: string } | null;
}): ZoneMappingView {
  return {
    id: row.id.toString(),
    sourceField: row.sourceField,
    sourceValueKey: row.sourceValueKey,
    sourceValueRaw: row.sourceValueRaw,
    fsmZoneId: row.fsmZoneId?.toString() ?? null,
    fsmZoneName: row.zone?.name ?? null,
    status: row.status,
    seenCount: row.seenCount,
    lastSeenAt: row.lastSeenAt,
  };
}

function toOverrideView(row: {
  sourcePlantId: bigint;
  fsmZoneId: bigint;
  reason: string | null;
  zone?: { name: string } | null;
}): PlantZoneOverrideView {
  return {
    sourcePlantId: row.sourcePlantId.toString(),
    fsmZoneId: row.fsmZoneId.toString(),
    fsmZoneName: row.zone?.name ?? null,
    reason: row.reason,
  };
}
