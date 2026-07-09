import { randomUUID } from 'node:crypto';
import { AuditService } from '../src/audit/audit.service';
import type { RequestActor } from '../src/common/request-actor';
import { EngineerAdminService, type EngineerAdminScope } from '../src/engineers/engineer-admin.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { CandidateSelectionService } from '../src/recommender/candidate-selection.service';
import { RecommenderService } from '../src/recommender/recommender.service';

/**
 * Phase 4 — SE Management (admin-entered SEs are the source of truth). The scoped write surface over the
 * existing model: create (user + profile) / edit / deactivate-not-delete + in-zone plant coverage, with
 * server-side authority (OH/CSM cross-zone, ZM home-zone-clamped, SE denied) + validation + audit, and
 * the end-to-end proof that an SE created here + coverage becomes a real recommender candidate (and
 * without coverage → UNASSIGNABLE).
 */
const NS = Date.now();

describe('Phase 4 — EngineerAdminService (SE Management CRUD + recommender integration)', () => {
  let prisma: PrismaService;
  let svc: EngineerAdminService;

  let zoneA: bigint;
  let zoneB: bigint;
  let companyId: bigint;
  let plantA: bigint;
  let plantB: bigint;

  const createdSeIds: string[] = [];
  const createdTicketIds: string[] = [];
  const createdDeviceIds: string[] = [];
  const extraPlantIds: bigint[] = [];
  let idSeq = 0;

  const ohScope: EngineerAdminScope = { role: 'OPERATIONS_HEAD', zoneId: null, userId: randomUUID() };
  const csmScope: EngineerAdminScope = { role: 'CENTRAL_SERVICE_MANAGER', zoneId: null, userId: randomUUID() };
  let zmAScope: EngineerAdminScope;
  const seScope: EngineerAdminScope = { role: 'SERVICE_ENGINEER', zoneId: 0, userId: randomUUID() };
  const actor: RequestActor = { userId: randomUUID(), role: 'OPERATIONS_HEAD', actedAsRole: null, actingZone: null };

  const freshSe = (zoneId: bigint, over: Partial<Parameters<EngineerAdminService['createSe']>[0]> = {}) => {
    idSeq++;
    return {
      name: `SE ${idSeq}`,
      phone: `+91 90000 ${String(10000 + idSeq).slice(-5)}`,
      email: `se-${NS}-${idSeq}@fsm.test`,
      address: 'Plot 1, Industrial Area',
      zoneId: Number(zoneId),
      coverageType: 'DEDICATED',
      dailyCapacity: 10,
      ...over,
    };
  };

  const create = async (scope: EngineerAdminScope, zoneId: bigint, over = {}) => {
    const row = await svc.createSe(freshSe(zoneId, over), scope, actor);
    createdSeIds.push(row.seId);
    return row;
  };

  /** Assert a rejected promise carries the given `{code}` in its HttpException response. */
  const reject = (p: Promise<unknown>, code: string) => expect(p).rejects.toMatchObject({ response: { code } });

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    svc = new EngineerAdminService(prisma, new AuditService(prisma));

    zoneA = (await prisma.zone.create({ data: { name: 'Z-A-ea-' + NS } })).zoneId;
    zoneB = (await prisma.zone.create({ data: { name: 'Z-B-ea-' + NS } })).zoneId;
    companyId = (await prisma.company.create({ data: { name: 'Co-ea-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })).companyId;
    plantA = (await prisma.plant.create({ data: { name: 'P-A-ea-' + NS, zoneId: zoneA } })).plantId;
    plantB = (await prisma.plant.create({ data: { name: 'P-B-ea-' + NS, zoneId: zoneB } })).plantId;
    zmAScope = { role: 'ZONAL_MANAGER', zoneId: Number(zoneA), userId: randomUUID() };
    seScope.zoneId = Number(zoneA);
  });

  afterAll(async () => {
    await prisma.recommendation.deleteMany({ where: { ticketId: { in: createdTicketIds } } });
    await prisma.ticketEvent.deleteMany({ where: { ticketId: { in: createdTicketIds } } });
    await prisma.ticket.deleteMany({ where: { ticketId: { in: createdTicketIds } } });
    await prisma.failureCycle.deleteMany({ where: { deviceId: { in: createdDeviceIds } } });
    await prisma.deviceState.deleteMany({ where: { deviceId: { in: createdDeviceIds } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: createdDeviceIds } } });
    await prisma.auditLog.deleteMany({ where: { entityType: { in: ['engineer_master', 'se_coverage'] }, entityId: { in: createdSeIds } } });
    await prisma.seCoverage.deleteMany({ where: { seId: { in: createdSeIds } } });
    await prisma.engineerMaster.deleteMany({ where: { engineerId: { in: createdSeIds } } });
    await prisma.user.deleteMany({ where: { userId: { in: createdSeIds } } });
    await prisma.plant.deleteMany({ where: { plantId: { in: [plantA, plantB, ...extraPlantIds] } } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId: { in: [zoneA, zoneB] } } });
    await prisma.onModuleDestroy();
  });

  // ---- role matrix ----

  it('OH and CSM create SEs in any zone (cross-zone authority)', async () => {
    const a = await create(ohScope, zoneA);
    const b = await create(csmScope, zoneB);
    expect(a.zoneId).toBe(Number(zoneA));
    expect(b.zoneId).toBe(Number(zoneB));
    // The user + profile are both persisted (identity is real, not a stub).
    const user = await prisma.user.findUniqueOrThrow({ where: { userId: a.seId } });
    expect(user.role).toBe('SERVICE_ENGINEER');
    expect(user.name).toBe(a.name);
  });

  it('a ZM creates in-zone but is FORBIDDEN out-of-zone', async () => {
    const inZone = await create(zmAScope, zoneA);
    expect(inZone.zoneId).toBe(Number(zoneA));
    await reject(svc.createSe(freshSe(zoneB), zmAScope, actor), 'ZONE_FORBIDDEN');
  });

  it('a SERVICE_ENGINEER has no access', async () => {
    await reject(svc.createSe(freshSe(zoneA), seScope, actor), 'FORBIDDEN');
    await reject(svc.list(seScope), 'FORBIDDEN');
  });

  it('the ZM directory returns only their own zone; OH sees all', async () => {
    const zmList = await svc.list(zmAScope);
    expect(zmList.length).toBeGreaterThan(0);
    expect(zmList.every((r) => r.zoneId === Number(zoneA))).toBe(true);
    const ohList = await svc.list(ohScope);
    expect(ohList.some((r) => r.zoneId === Number(zoneB))).toBe(true);
  });

  // ---- validation + identity uniqueness ----

  it('rejects a bad email / phone and a duplicate identity', async () => {
    await reject(svc.createSe(freshSe(zoneA, { email: 'not-an-email' }), ohScope, actor), 'INVALID_EMAIL');
    await reject(svc.createSe(freshSe(zoneA, { phone: 'abc' }), ohScope, actor), 'INVALID_PHONE');
    const taken = freshSe(zoneA);
    const first = await svc.createSe(taken, ohScope, actor);
    createdSeIds.push(first.seId);
    await reject(svc.createSe({ ...freshSe(zoneA), email: taken.email }, ohScope, actor), 'SE_IDENTITY_TAKEN');
  });

  // ---- edit + deactivate ----

  it('a ZM edits an in-zone SE but gets NOT_FOUND for an out-of-zone one', async () => {
    const inZone = await create(zmAScope, zoneA);
    const edited = await svc.updateSe(inZone.seId, { name: 'Renamed', dailyCapacity: 7 }, zmAScope, actor);
    expect(edited.name).toBe('Renamed');
    expect(edited.dailyCapacity).toBe(7);

    const outZone = await create(ohScope, zoneB);
    await reject(svc.updateSe(outZone.seId, { name: 'X' }, zmAScope, actor), 'SE_NOT_FOUND');
  });

  it('deactivate is not delete — the row remains, isActive=false, user DISABLED', async () => {
    const se = await create(ohScope, zoneA);
    const off = await svc.setActive(se.seId, false, ohScope, actor);
    expect(off.isActive).toBe(false);
    const still = await prisma.engineerMaster.findUnique({ where: { engineerId: se.seId } });
    expect(still).not.toBeNull();
    const user = await prisma.user.findUniqueOrThrow({ where: { userId: se.seId } });
    expect(user.status).toBe('DISABLED');
  });

  // ---- coverage (in-zone only, even for OH) ----

  it('maps an SE to an in-zone plant, rejects a cross-zone plant even for OH, and rejects FLOATING', async () => {
    const se = await create(ohScope, zoneA);
    const cov = await svc.addCoverage(se.seId, Number(plantA), 'DEDICATED', ohScope, actor);
    expect(cov.plantId).toBe(Number(plantA));
    await reject(svc.addCoverage(se.seId, Number(plantB), 'DEDICATED', ohScope, actor), 'CROSS_ZONE_COVERAGE_FORBIDDEN');
    await reject(svc.addCoverage(se.seId, Number(plantA), 'FLOATING', ohScope, actor), 'FLOATING_USES_TERRITORY');

    // The mapping shows up on the directory row, carrying the se_coverage row id for removal.
    const row = (await svc.list(ohScope)).find((r) => r.seId === se.seId);
    expect(row?.plants.map((p) => p.id)).toContain(Number(plantA));
    const mapped = row!.plants.find((p) => p.id === Number(plantA))!;
    expect(mapped.coverageId).toBe(cov.id);

    // Remove it by the exposed coverageId → gone from the row.
    await svc.removeCoverage(se.seId, mapped.coverageId, ohScope, actor);
    const after = (await svc.list(ohScope)).find((r) => r.seId === se.seId);
    expect(after?.plants).toHaveLength(0);
  });

  it('a ZM cannot add coverage to an out-of-zone SE (NOT_FOUND)', async () => {
    const outZone = await create(ohScope, zoneB);
    await reject(svc.addCoverage(outZone.seId, Number(plantB), 'DEDICATED', zmAScope, actor), 'SE_NOT_FOUND');
  });

  // ---- recommender integration (the point of the whole phase) ----

  it('an SE created here + coverage becomes a real recommender candidate; no coverage → UNASSIGNABLE', async () => {
    const recommender = new RecommenderService(prisma, new CandidateSelectionService(prisma));

    // A dedicated plant in zone A with NO coverage yet, so "no SE covers it" holds regardless of the
    // other tests' mappings.
    const plantC = (await prisma.plant.create({ data: { name: 'P-C-ea-' + NS, zoneId: zoneA } })).plantId;
    extraPlantIds.push(plantC);

    // A fresh CRITICAL ticket at plant C (its own device/state/cycle).
    const deviceId = String(12_300_000_000 + (NS % 100_000) + idSeq++);
    createdDeviceIds.push(deviceId);
    await prisma.device.create({ data: { deviceId } });
    await prisma.deviceState.create({
      data: {
        deviceId, isInactive: true, slaBucket: 'CRITICAL', eligibleForUptime: true, hasOpenFailureCycle: true,
        latestGpsDatetime: new Date('2026-06-01T00:00:00Z'), plantId: plantC, companyId, computedAt: new Date(),
      },
    });
    const cycle = await prisma.failureCycle.create({ data: { deviceId, state: 'OPEN', openedAt: new Date() } });
    const ticket = await prisma.ticket.create({
      data: {
        workType: 'TROUBLESHOOT', status: 'OPEN', failureCycleId: cycle.cycleId, deviceId, plantId: plantC, companyId,
        companyTier: 'GOLD', lastStateChangedAt: new Date(),
      },
    });
    createdTicketIds.push(ticket.ticketId);

    // 1) No SE covers plant C yet → UNASSIGNABLE.
    await recommender.runForZone(zoneA);
    const first = await prisma.recommendation.findFirstOrThrow({ where: { ticketId: ticket.ticketId }, orderBy: { recommendationId: 'desc' } });
    expect(first.status).toBe('UNASSIGNABLE');

    // 2) Create an SE via the admin API + map them to plant C, then re-run → SUGGESTED to that SE.
    const se = await create(ohScope, zoneA);
    await svc.addCoverage(se.seId, Number(plantC), 'DEDICATED', ohScope, actor);
    await recommender.runForZone(zoneA);
    const second = await prisma.recommendation.findFirstOrThrow({ where: { ticketId: ticket.ticketId }, orderBy: { recommendationId: 'desc' } });
    expect(second.status).toBe('SUGGESTED');
    expect(second.seId).toBe(se.seId);
  });
});
