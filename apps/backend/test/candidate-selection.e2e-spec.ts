import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { PlantEligibleFloatingSeService } from '../src/org/plant-eligible-floating-se.service';
import { CandidateSelectionService } from '../src/recommender/candidate-selection.service';

/**
 * Issue 10, slice 5 — strict-precedence candidate ordering (ADR-0001, AC#1). For a plant the
 * Recommender offers SEs in order: Dedicated → Multi-Plant → Floating (the last resolved via the
 * `plant_eligible_floating_se` MV). The hard-filter fallback (engage the next tier when the primary is
 * unavailable / at capacity) is applied by the orchestrator over this ordered list.
 */
const NS = Date.now();

describe('Issue 10 slice 5 — strict-precedence candidate ordering', () => {
  let prisma: PrismaService;
  let mv: PlantEligibleFloatingSeService;
  let service: CandidateSelectionService;

  let zoneId: bigint;
  let districtId: bigint;
  let plantId: bigint;
  let dedicated: string;
  let multi: string;
  let floating: string;
  const userIds: string[] = [];

  const makeSe = async (coverageType: 'DEDICATED' | 'MULTI_PLANT' | 'FLOATING'): Promise<string> => {
    const tag = randomUUID().slice(0, 8);
    const u = await prisma.user.create({
      data: { name: 'SE ' + tag, role: 'SERVICE_ENGINEER', phone: 'ph-' + tag, email: `${tag}@cand.test`, zoneId },
    });
    userIds.push(u.userId);
    await prisma.engineerMaster.create({
      data: { engineerId: u.userId, coverageType, zoneId, dailyCapacity: 6 },
    });
    return u.userId;
  };

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    mv = new PlantEligibleFloatingSeService(prisma);
    service = new CandidateSelectionService(prisma);

    zoneId = (await prisma.zone.create({ data: { name: 'Z-cand-' + NS } })).zoneId;
    // Unique state so no other test's state-level floating territory matches this plant via the MV.
    districtId = (await prisma.district.create({ data: { name: 'D-cand-' + NS, state: 'CandState-' + NS } })).districtId;
    plantId = (await prisma.plant.create({ data: { name: 'P-cand-' + NS, zoneId, districtId } })).plantId;

    dedicated = await makeSe('DEDICATED');
    multi = await makeSe('MULTI_PLANT');
    floating = await makeSe('FLOATING');

    await prisma.seCoverage.create({ data: { seId: dedicated, plantId, coverageType: 'DEDICATED' } });
    await prisma.seCoverage.create({ data: { seId: multi, plantId, coverageType: 'MULTI_PLANT' } });
    await prisma.engineerTerritoryCoverage.create({ data: { seId: floating, districtId } });
    await mv.refresh();
  });

  afterAll(async () => {
    await prisma.engineerTerritoryCoverage.deleteMany({ where: { seId: floating } });
    await prisma.seCoverage.deleteMany({ where: { plantId } });
    await prisma.plant.deleteMany({ where: { plantId } });
    await prisma.engineerMaster.deleteMany({ where: { engineerId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.district.deleteMany({ where: { districtId } });
    await prisma.zone.deleteMany({ where: { zoneId } });
    await mv.refresh();
    await prisma.onModuleDestroy();
  });

  it('orders candidates Dedicated → Multi-Plant → Floating', async () => {
    const ordered = await service.orderedCandidatesForPlant(plantId);
    expect(ordered.map((c) => c.coverageType)).toEqual(['DEDICATED', 'MULTI_PLANT', 'FLOATING']);
    expect(ordered.map((c) => c.seId)).toEqual([dedicated, multi, floating]);
  });
});
