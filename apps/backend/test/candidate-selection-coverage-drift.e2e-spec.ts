import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { PlantEligibleFloatingSeService } from '../src/org/plant-eligible-floating-se.service';
import { CandidateSelectionService } from '../src/recommender/candidate-selection.service';

/**
 * Issue 138 — the FLOATING candidate leg must re-validate SE identity against `engineer_master` at
 * selection time, not trust the `plant_eligible_floating_se` MV alone. SE data is FSM-internal admin
 * data: an OH editing an SE via /engineers/manage can flip `coverage_type` away from FLOATING
 * (`EngineerAdminService.editEngineer`) or deactivate them (`setActive`) — neither refreshes the MV, and
 * the MV's definition (plants × engineer_territory_coverage) cannot express either field. So a stale MV
 * row must not resurrect a now-non-floating / inactive SE as a floating candidate.
 *
 * Seam: `CandidateSelectionService.orderedCandidatesForPlant` (same public boundary as
 * `candidate-selection.e2e-spec.ts`). The mutations below deliberately DO NOT refresh the MV.
 */
const NS = Date.now();

describe('Issue 138 — floating candidate leg re-checks coverage_type / is_active (MV drift)', () => {
  let prisma: PrismaService;
  let mv: PlantEligibleFloatingSeService;
  let service: CandidateSelectionService;

  let zoneId: bigint;
  let districtId: bigint;
  let plantId: bigint;
  let floating: string;
  const userIds: string[] = [];

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    mv = new PlantEligibleFloatingSeService(prisma);
    service = new CandidateSelectionService(prisma);

    zoneId = (await prisma.zone.create({ data: { name: 'Z-138-' + NS } })).zoneId;
    // Unique district+state so this plant matches ONLY this test's floating SE through the MV.
    districtId = (await prisma.district.create({ data: { name: 'D-138-' + NS, state: 'St138-' + NS } })).districtId;
    plantId = (await prisma.plant.create({ data: { name: 'P-138-' + NS, zoneId, districtId } })).plantId;

    const tag = randomUUID().slice(0, 8);
    const u = await prisma.user.create({
      data: { name: 'SE ' + tag, role: 'SERVICE_ENGINEER', phone: 'ph-' + tag, email: `${tag}@drift138.test`, zoneId },
    });
    userIds.push(u.userId);
    floating = u.userId;
    await prisma.engineerMaster.create({ data: { engineerId: floating, coverageType: 'FLOATING', zoneId, dailyCapacity: 6 } });
    await prisma.engineerTerritoryCoverage.create({ data: { seId: floating, districtId } });
    await mv.refresh();
  });

  afterEach(async () => {
    // Restore an active FLOATING profile between cases — the case mutations never refresh the MV.
    await prisma.engineerMaster.update({
      where: { engineerId: floating },
      data: { coverageType: 'FLOATING', isActive: true },
    });
  });

  afterAll(async () => {
    await prisma.engineerTerritoryCoverage.deleteMany({ where: { seId: floating } });
    await prisma.plant.deleteMany({ where: { plantId } });
    await prisma.engineerMaster.deleteMany({ where: { engineerId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.district.deleteMany({ where: { districtId } });
    await prisma.zone.deleteMany({ where: { zoneId } });
    await mv.refresh();
    await prisma.onModuleDestroy();
  });

  it('control: an active FLOATING SE with a matching territory row is a candidate', async () => {
    const ordered = await service.orderedCandidatesForPlant(plantId);
    expect(ordered.map((c) => c.seId)).toContain(floating);
    expect(ordered.find((c) => c.seId === floating)?.coverageType).toBe('FLOATING');
  });

  it('drops the candidate when coverage_type is flipped to DEDICATED without an MV refresh', async () => {
    await prisma.engineerMaster.update({ where: { engineerId: floating }, data: { coverageType: 'DEDICATED' } });
    // MV intentionally stale — the row still lists the SE; selection must re-check engineer_master.
    const ordered = await service.orderedCandidatesForPlant(plantId);
    expect(ordered.map((c) => c.seId)).not.toContain(floating);
  });

  it('drops the candidate when the SE is deactivated without an MV refresh', async () => {
    await prisma.engineerMaster.update({ where: { engineerId: floating }, data: { isActive: false } });
    const ordered = await service.orderedCandidatesForPlant(plantId);
    expect(ordered.map((c) => c.seId)).not.toContain(floating);
  });
});
