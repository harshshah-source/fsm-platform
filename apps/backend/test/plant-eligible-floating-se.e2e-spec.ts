import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { PlantEligibleFloatingSeService } from '../src/org/plant-eligible-floating-se.service';

/**
 * Issue 09, slice 4 — `plant_eligible_floating_se` MV resolution (ADR-0006, AC#4/#5). A plant is
 * eligible for a FLOATING SE if it falls in any of the SE's territory dimensions — the union of
 * district / region / state hierarchical membership and `ST_Contains(polygon, plant.location)`. The
 * MV precomputes that union; `refresh()` rebuilds it. We assert each of the four membership paths
 * resolves, and that an out-of-territory plant resolves to none of them.
 */
const NS = Date.now();
const seedZoneName = 'Z-mv-' + NS;

describe('Issue 09 slice 4 — plant_eligible_floating_se MV resolution', () => {
  let prisma: PrismaService;
  let service: PlantEligibleFloatingSeService;

  let zoneId: bigint;
  let regionId: bigint;
  let d1: bigint; // Maharashtra, in region
  let d2: bigint; // Gujarat, no region (control)
  let plantIn: bigint; // in d1, located in Mumbai
  let plantOut: bigint; // in d2, located in Gujarat
  let seDistrict: string;
  let seRegion: string;
  let seState: string;
  let sePolygon: string;
  const userIds: string[] = [];

  const makeFloatingSe = async (): Promise<string> => {
    const tag = randomUUID().slice(0, 8);
    const user = await prisma.user.create({
      data: { name: 'F ' + tag, role: 'SERVICE_ENGINEER', phone: 'ph-' + tag, email: `${tag}@mv.test`, zoneId },
    });
    userIds.push(user.userId);
    await prisma.engineerMaster.create({
      data: { engineerId: user.userId, coverageType: 'FLOATING', zoneId, dailyCapacity: 6 },
    });
    return user.userId;
  };

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    service = new PlantEligibleFloatingSeService(prisma);

    zoneId = (await prisma.zone.create({ data: { name: seedZoneName } })).zoneId;
    regionId = (await prisma.region.create({ data: { name: 'West ' + NS, state: 'Maharashtra' } })).regionId;
    d1 = (await prisma.district.create({ data: { name: 'Mumbai ' + NS, state: 'Maharashtra', regionId } })).districtId;
    d2 = (await prisma.district.create({ data: { name: 'Surat ' + NS, state: 'Gujarat' } })).districtId;

    plantIn = (await prisma.plant.create({ data: { name: 'P-in ' + NS, zoneId, districtId: d1 } })).plantId;
    plantOut = (await prisma.plant.create({ data: { name: 'P-out ' + NS, zoneId, districtId: d2 } })).plantId;
    // Mumbai ~ (72.87 E, 19.07 N); Surat ~ (72.83 E, 21.17 N).
    await prisma.$executeRawUnsafe(
      `UPDATE plants SET location = ST_SetSRID(ST_MakePoint(72.87, 19.07), 4326) WHERE plant_id = ${plantIn}`,
    );
    await prisma.$executeRawUnsafe(
      `UPDATE plants SET location = ST_SetSRID(ST_MakePoint(72.83, 21.17), 4326) WHERE plant_id = ${plantOut}`,
    );

    seDistrict = await makeFloatingSe();
    seRegion = await makeFloatingSe();
    seState = await makeFloatingSe();
    sePolygon = await makeFloatingSe();

    await prisma.engineerTerritoryCoverage.create({ data: { seId: seDistrict, districtId: d1 } });
    await prisma.engineerTerritoryCoverage.create({ data: { seId: seRegion, regionId } });
    await prisma.engineerTerritoryCoverage.create({ data: { seId: seState, state: 'Maharashtra' } });
    // A box around Mumbai (72.5..73.2 E, 18.8..19.3 N) that contains plantIn but not plantOut.
    await prisma.$executeRawUnsafe(
      `INSERT INTO engineer_territory_coverage (se_id, polygon)
       VALUES ('${sePolygon}', ST_GeomFromText('MULTIPOLYGON(((72.5 18.8,73.2 18.8,73.2 19.3,72.5 19.3,72.5 18.8)))', 4326))`,
    );

    await service.refresh();
  });

  afterAll(async () => {
    const ses = [seDistrict, seRegion, seState, sePolygon];
    await prisma.engineerTerritoryCoverage.deleteMany({ where: { seId: { in: ses } } });
    await prisma.plant.deleteMany({ where: { plantId: { in: [plantIn, plantOut] } } });
    await prisma.engineerMaster.deleteMany({ where: { engineerId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.district.deleteMany({ where: { districtId: { in: [d1, d2] } } });
    await prisma.region.deleteMany({ where: { regionId } });
    await prisma.zone.deleteMany({ where: { zoneId } });
    await service.refresh();
    await prisma.onModuleDestroy();
  });

  it('resolves district membership (covered plant only)', async () => {
    expect(await service.eligibleSeIdsForPlant(plantIn)).toContain(seDistrict);
    expect(await service.eligibleSeIdsForPlant(plantOut)).not.toContain(seDistrict);
  });

  it('resolves region membership via the plant district rollup', async () => {
    expect(await service.eligibleSeIdsForPlant(plantIn)).toContain(seRegion);
    expect(await service.eligibleSeIdsForPlant(plantOut)).not.toContain(seRegion);
  });

  it('resolves state membership', async () => {
    expect(await service.eligibleSeIdsForPlant(plantIn)).toContain(seState);
    expect(await service.eligibleSeIdsForPlant(plantOut)).not.toContain(seState);
  });

  it('resolves polygon membership via ST_Contains', async () => {
    expect(await service.eligibleSeIdsForPlant(plantIn)).toContain(sePolygon);
    expect(await service.eligibleSeIdsForPlant(plantOut)).not.toContain(sePolygon);
  });
});
