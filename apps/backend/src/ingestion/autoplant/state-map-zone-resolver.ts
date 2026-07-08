import { PrismaService } from '../../prisma/prisma.service';
import type { MstPlantRow } from './master-mapping';
import type { PlantZoneResolver } from './master-sync.service';
import { deriveZone, type FsmZoneName } from './state-zone-map';

/**
 * Looks up FSM operational `zone_id` / `district_id` by name — the DB-touching half of the R6 resolver,
 * kept behind an interface so the resolver's decision logic is unit-testable without a DB.
 */
export interface ZoneDirectory {
  /** FSM `zones.zone_id` for a derived zone name (case-insensitive), or null if not seeded. */
  zoneIdByName(name: FsmZoneName): Promise<bigint | null>;
  /** Best-effort `districts.district_id` for a plant's district name, or null. */
  districtIdByName(name: string | null): Promise<bigint | null>;
}

/** Production `ZoneDirectory` over FSM Postgres. */
export class PrismaZoneDirectory implements ZoneDirectory {
  constructor(private readonly prisma: PrismaService) {}

  async zoneIdByName(name: FsmZoneName): Promise<bigint | null> {
    const zone = await this.prisma.zone.findFirst({
      where: { name: { equals: name, mode: 'insensitive' } },
      select: { zoneId: true },
    });
    return zone?.zoneId ?? null;
  }

  async districtIdByName(name: string | null): Promise<bigint | null> {
    const n = name?.trim();
    if (!n) return null;
    const district = await this.prisma.district.findFirst({
      where: { name: { equals: n, mode: 'insensitive' } },
      select: { districtId: true },
    });
    return district?.districtId ?? null;
  }
}

export interface StateMapZoneResolverOptions {
  /** Fired when the state-derived zone disagrees with AutoPlant's `zone_name` (feeds the exception queue). */
  onConflict?: (plant: MstPlantRow, derivedZone: FsmZoneName) => void;
}

/**
 * The R6 `PlantZoneResolver` (blueprint §5.2): derive the FSM operational zone from the authoritative
 * `plant_state` via the PROVISIONAL {@link deriveZone} map, then resolve it to an FSM `zone_id`. It
 * **defers** (returns `null`) — never guessing a zone — when the state is junk/unmapped (→ UNZONED) or
 * when the derived zone isn't seeded yet. A source-`zone_name` conflict still resolves but fires
 * `onConflict` so Ops can review it. Values stay provisional until R6 is ratified
 * (`docs/autoplant/R6-zone-map-proposal.md`); the breaking `plants.zone_id → nullable` migration + the
 * `UNZONED` holding zone remain gated.
 */
export class StateMapZoneResolver implements PlantZoneResolver {
  constructor(
    private readonly directory: ZoneDirectory,
    private readonly options: StateMapZoneResolverOptions = {},
  ) {}

  async resolve(plant: MstPlantRow): Promise<{ zoneId: bigint; districtId: bigint | null } | null> {
    const { zoneName, conflict } = deriveZone(plant.plant_state, plant.zone_name);
    if (zoneName == null) return null; // junk/unmapped state → UNZONED → defer to the Ops exception queue
    const zoneId = await this.directory.zoneIdByName(zoneName);
    if (zoneId == null) return null; // FSM zone not seeded yet → defer (do not fabricate)
    if (conflict) this.options.onConflict?.(plant, zoneName);
    const districtId = await this.directory.districtIdByName(plant.plant_district);
    return { zoneId, districtId };
  }
}
