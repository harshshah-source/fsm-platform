import {
  StateMapZoneResolver,
  type ZoneDirectory,
} from '../src/ingestion/autoplant/state-map-zone-resolver';
import type { MstPlantRow } from '../src/ingestion/autoplant/master-mapping';
import type { FsmZoneName } from '../src/ingestion/autoplant/state-zone-map';

/**
 * Phase 4 / R6 — StateMapZoneResolver (the PlantZoneResolver the MasterSyncService injects). Uses the
 * provisional state→zone map, resolves the derived zone name to an FSM zone_id via an injected
 * ZoneDirectory (faked here — no DB), best-effort district, and DEFERS (null) on junk state or an
 * unseeded zone. A source-zone conflict still resolves but fires the exception-queue hook.
 */
const plant = (over: Partial<MstPlantRow>): MstPlantRow => ({
  plant_id: 1,
  company_id: 1015,
  plant_name: 'P',
  zone_id: null,
  zone_name: null,
  region_id: null,
  region_name: null,
  plant_state: 'Karnataka',
  plant_district: null,
  master_plant_id: null,
  master_plant_code: null,
  status: 'ACTIVE',
  ...over,
});

const directory = (
  zones: Partial<Record<FsmZoneName, bigint>>,
  districts: Record<string, bigint> = {},
): ZoneDirectory => ({
  zoneIdByName: async (name) => zones[name] ?? null,
  districtIdByName: async (name) => (name ? districts[name.trim().toLowerCase()] ?? null : null),
});

describe('R6 — StateMapZoneResolver', () => {
  it('resolves a mapped state to the seeded zone id + best-effort district', async () => {
    const resolver = new StateMapZoneResolver(
      directory({ SOUTH: 5n }, { kadapa: 9n }),
    );
    const result = await resolver.resolve(plant({ plant_state: 'Andhra Pradesh', plant_district: 'Kadapa' }));
    expect(result).toEqual({ zoneId: 5n, districtId: 9n });
  });

  it('returns a null district when the plant district is absent/unknown (zone still resolves)', async () => {
    const resolver = new StateMapZoneResolver(directory({ SOUTH: 5n }));
    const result = await resolver.resolve(plant({ plant_state: 'Karnataka', plant_district: 'Nowhere' }));
    expect(result).toEqual({ zoneId: 5n, districtId: null });
  });

  it('defers (null) for a junk / unmapped state — no invented zone (UNZONED)', async () => {
    const resolver = new StateMapZoneResolver(directory({ SOUTH: 5n, NORTH: 1n, EAST: 2n, WEST: 3n }));
    expect(await resolver.resolve(plant({ plant_state: 'india' }))).toBeNull();
    expect(await resolver.resolve(plant({ plant_state: 'NA' }))).toBeNull();
    expect(await resolver.resolve(plant({ plant_state: null }))).toBeNull();
  });

  it('defers (null) when the derived zone is not seeded yet in FSM', async () => {
    // Maharashtra → WEST, but WEST is not in the directory → cannot place → defer.
    const resolver = new StateMapZoneResolver(directory({ NORTH: 1n, SOUTH: 5n }));
    expect(await resolver.resolve(plant({ plant_state: 'Maharashtra' }))).toBeNull();
  });

  it('still resolves on a source-zone conflict but fires the exception-queue hook', async () => {
    const conflicts: Array<{ state: string | null; zone: FsmZoneName }> = [];
    const resolver = new StateMapZoneResolver(directory({ EAST: 2n }), {
      onConflict: (p, zone) => conflicts.push({ state: p.plant_state, zone }),
    });
    // Chhattisgarh → EAST (our map); AutoPlant tags it "West" → conflict.
    const result = await resolver.resolve(plant({ plant_state: 'Chhattisgarh', zone_name: 'West' }));
    expect(result).toEqual({ zoneId: 2n, districtId: null });
    expect(conflicts).toEqual([{ state: 'Chhattisgarh', zone: 'EAST' }]);
  });
});
