import { PrismaService } from '../../prisma/prisma.service';
import type { MstPlantRow } from './master-mapping';
import type { PlantZoneResolver } from './master-sync.service';

/**
 * The data-driven `PlantZoneResolver` (R6 translation layer) — replaces the hardcoded state→zone code
 * map. Resolution is a strict three-tier precedence, all sourced from FSM-owned, admin-editable tables:
 *
 *   1. **Plant override** (`plant_zone_overrides` by `source_plant_id`) — the escape hatch that pins a
 *      specific plant to a zone regardless of its raw value (fixes conflicts a value-map can't express).
 *   2. **Value map** (`zone_mappings` on the normalized `zone_name`, MAPPED only) — the general crosswalk.
 *   3. **Pending → UNZONED** — an unmapped/ambiguous value is never guessed: the plant lands in the
 *      seeded UNZONED holding zone (so it still syncs and is visible), and the raw value is
 *      auto-discovered as a PENDING `zone_mappings` row (the admin work queue). IGNORED values also land
 *      UNZONED but are not resurfaced.
 *
 * AutoPlant stays the source of truth for the RAW value; FSM owns the mapping. Nothing is hardcoded and
 * nothing is dropped. Because master-sync is insert-only on `plants.zone_id` (anti-drift), edits to the
 * tables take effect through the FSM-owned re-apply operation (`ZoneMappingService.reapply`) — this
 * resolver only decides the zone at (first) insert time and keeps the pending queue fed.
 */

export const ZONE_MAPPING_SOURCE_FIELD = 'zone_name';
export const UNZONED_ZONE_NAME = 'UNZONED';

/**
 * Normalize a raw AutoPlant zone value to a stable dedup key: trim, lowercase, collapse internal
 * whitespace, and strip the noise words "india"/"zone" ("West Zone"/"WEST"/"West" → "west"). Blank /
 * NULL / the "NA"/"null" sentinels collapse to a single `__blank__` key so every unlabelled plant shares
 * one PENDING queue row instead of scattering. Junk ("sdf", "123") is preserved verbatim (normalized) so
 * an admin can see and IGNORE it — the resolver never decides a value is junk on its own.
 */
export function normalizeZoneKey(raw: string | null | undefined): string {
  const s = (raw ?? '').trim().toLowerCase();
  if (s === '' || s === 'na' || s === 'null') return '__blank__';
  return s.replace(/\b(india|zone)\b/g, '').replace(/\s+/g, ' ').trim() || '__blank__';
}

export interface MappingTableZoneResolverDeps {
  /** Holding-zone name for pending/ambiguous values (must be seeded). Default `UNZONED`. */
  unzonedZoneName?: string;
  /** The `zone_mappings.source_field` this resolver keys on. Default `zone_name`. */
  sourceField?: string;
  now?: () => Date;
}

export class MappingTableZoneResolver implements PlantZoneResolver {
  private readonly unzonedZoneName: string;
  private readonly sourceField: string;
  private readonly now: () => Date;
  private unzonedZoneIdCache: bigint | null = null;

  constructor(
    private readonly prisma: PrismaService,
    deps: MappingTableZoneResolverDeps = {},
  ) {
    this.unzonedZoneName = deps.unzonedZoneName ?? UNZONED_ZONE_NAME;
    this.sourceField = deps.sourceField ?? ZONE_MAPPING_SOURCE_FIELD;
    this.now = deps.now ?? (() => new Date());
  }

  async resolve(plant: MstPlantRow): Promise<{ zoneId: bigint; districtId: bigint | null } | null> {
    const districtId = await this.resolveDistrict(plant.plant_district);

    // 1. Plant-level override (highest precedence).
    const sourcePlantId = this.toBigIntOrNull(plant.plant_id);
    if (sourcePlantId != null) {
      const override = await this.prisma.plantZoneOverride.findUnique({
        where: { sourcePlantId },
        select: { fsmZoneId: true },
      });
      if (override) return { zoneId: override.fsmZoneId, districtId };
    }

    // 2. Value map on the normalized raw zone value (MAPPED rows only).
    const key = normalizeZoneKey(plant.zone_name);
    const mapping = await this.prisma.zoneMapping.findUnique({
      where: { sourceField_sourceValueKey: { sourceField: this.sourceField, sourceValueKey: key } },
      select: { status: true, fsmZoneId: true },
    });
    if (mapping && mapping.status === 'MAPPED' && mapping.fsmZoneId != null) {
      return { zoneId: mapping.fsmZoneId, districtId };
    }

    // 3. Pending → discover the value on the admin queue, land the plant in UNZONED.
    await this.discoverPending(key, plant.zone_name);
    return { zoneId: await this.unzonedZoneId(), districtId };
  }

  /** Upsert the PENDING discovery row: create it PENDING on first sight, else just bump the counters.
   *  Never touches `status`/`fsm_zone_id` on update — an admin's MAPPED/IGNORED decision is preserved. */
  private async discoverPending(key: string, raw: string | null | undefined): Promise<void> {
    const now = this.now();
    await this.prisma.zoneMapping.upsert({
      where: { sourceField_sourceValueKey: { sourceField: this.sourceField, sourceValueKey: key } },
      create: {
        sourceField: this.sourceField,
        sourceValueKey: key,
        sourceValueRaw: raw?.trim() || null,
        status: 'PENDING',
        seenCount: 1,
        lastSeenAt: now,
      },
      update: { seenCount: { increment: 1 }, lastSeenAt: now },
    });
  }

  private async resolveDistrict(name: string | null | undefined): Promise<bigint | null> {
    const n = name?.trim();
    if (!n) return null;
    const district = await this.prisma.district.findFirst({
      where: { name: { equals: n, mode: 'insensitive' } },
      select: { districtId: true },
    });
    return district?.districtId ?? null;
  }

  private async unzonedZoneId(): Promise<bigint> {
    if (this.unzonedZoneIdCache != null) return this.unzonedZoneIdCache;
    const zone = await this.prisma.zone.findFirst({
      where: { name: { equals: this.unzonedZoneName, mode: 'insensitive' } },
      select: { zoneId: true },
    });
    if (!zone) {
      throw new Error(
        `UNZONED holding zone "${this.unzonedZoneName}" is not seeded — the zone-mapping resolver ` +
          'cannot land pending plants. Seed the operational zones (org-seed) before syncing.',
      );
    }
    this.unzonedZoneIdCache = zone.zoneId;
    return zone.zoneId;
  }

  private toBigIntOrNull(v: number | string | null | undefined): bigint | null {
    if (v == null) return null;
    const s = String(v).trim();
    if (!/^-?\d+$/.test(s)) return null;
    const n = BigInt(s);
    return n === 0n ? null : n;
  }
}
