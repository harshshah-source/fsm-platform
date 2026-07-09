import { randomUUID } from 'node:crypto';
import type { RequestActor } from '../src/common/request-actor';
import { AuditService } from '../src/audit/audit.service';
import { InstallLifecycleService, type InstallScope } from '../src/ticketing/install-lifecycle.service';
import { LoggingInstallNotifier } from '../src/ticketing/install-notifier';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Issue 102 — install-lifecycle zone scoping (audit HIGH #9). The transitions and the serial read must
 * clamp a ZONAL_MANAGER to their home zone so a zone-1 ZM cannot schedule SEs onto, or read, a zone-2
 * install ticket; an SE may read only its own assigned ticket. CSM / OH keep cross-zone authority and the
 * WM reader keeps cross-zone visibility (AC#5).
 */
const NS = Date.now();

describe('Issue 102 — install lifecycle zone scoping', () => {
  let prisma: PrismaService;
  let service: InstallLifecycleService;

  let zoneA: bigint;
  let zoneB: bigint;
  let companyId: bigint;
  let plantA: bigint;
  let plantB: bigint;
  let deviceSeq = 9_360_000n;
  const createdTicketIds: string[] = [];

  const zmA = randomUUID();
  const zmB = randomUUID();
  const seAssigned = randomUUID();
  const seOther = randomUUID();
  const csm = randomUUID();
  const oh = randomUUID();
  const wm = randomUUID();

  const zmActorA: RequestActor = { userId: zmA, role: 'ZONAL_MANAGER', actedAsRole: null, actingZone: null };
  const csmActor: RequestActor = { userId: csm, role: 'CENTRAL_SERVICE_MANAGER', actedAsRole: null, actingZone: null };
  const ohActor: RequestActor = { userId: oh, role: 'OPERATIONS_HEAD', actedAsRole: null, actingZone: null };

  const scopeZmA: InstallScope = { role: 'ZONAL_MANAGER', zoneId: 0, userId: zmA }; // zoneId filled in beforeAll
  const scopeCsm: InstallScope = { role: 'CENTRAL_SERVICE_MANAGER', zoneId: null, userId: csm };
  const scopeOh: InstallScope = { role: 'OPERATIONS_HEAD', zoneId: null, userId: oh };
  const scopeWm: InstallScope = { role: 'WAREHOUSE_MANAGER', zoneId: null, userId: wm };
  const scopeSeAssigned: InstallScope = { role: 'SERVICE_ENGINEER', zoneId: null, userId: seAssigned };
  const scopeSeOther: InstallScope = { role: 'SERVICE_ENGINEER', zoneId: null, userId: seOther };

  const makeInstall = async (plantId: bigint, status: 'REQUESTED' | 'ACTIVATED', assigned: string | null): Promise<string> => {
    const deviceId = String(deviceSeq++);
    await prisma.device.create({ data: { deviceId, deviceType: 'GPS-X' } });
    const t = await prisma.ticket.create({
      data: {
        workType: 'INSTALL',
        status,
        deviceId,
        plantId,
        companyId,
        companyTier: 'GOLD',
        installTriggerSource: 'MANUAL_OPERATIONS',
        assignedSeId: assigned,
        fittedGpsSerial: status === 'ACTIVATED' ? deviceId : null,
        fittedSimSerial: status === 'ACTIVATED' ? 'SIM-Z' : null,
        lastStateChangedAt: new Date(),
      },
    });
    createdTicketIds.push(t.ticketId);
    return t.ticketId;
  };

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    service = new InstallLifecycleService(prisma, new AuditService(prisma), new LoggingInstallNotifier());

    zoneA = (await prisma.zone.create({ data: { name: 'Z-A-ilz-' + NS } })).zoneId;
    zoneB = (await prisma.zone.create({ data: { name: 'Z-B-ilz-' + NS } })).zoneId;
    scopeZmA.zoneId = Number(zoneA);
    companyId = (await prisma.company.create({ data: { name: 'Co-ilz-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })).companyId;
    plantA = (await prisma.plant.create({ data: { name: 'P-A-ilz-' + NS, zoneId: zoneA } })).plantId;
    plantB = (await prisma.plant.create({ data: { name: 'P-B-ilz-' + NS, zoneId: zoneB } })).plantId;
  });

  afterAll(async () => {
    await prisma.auditLog.deleteMany({ where: { entityType: 'tickets', entityId: { in: createdTicketIds } } });
    await prisma.ticketEvent.deleteMany({ where: { ticketId: { in: createdTicketIds } } });
    await prisma.ticket.deleteMany({ where: { ticketId: { in: createdTicketIds } } });
    await prisma.device.deleteMany({ where: { deviceId: { gte: '9360000', lt: '9361000' } } });
    await prisma.plant.deleteMany({ where: { plantId: { in: [plantA, plantB] } } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId: { in: [zoneA, zoneB] } } });
    await prisma.onModuleDestroy();
  });

  // ---- scheduleInstall zone clamp ----

  it('a ZM schedules an in-zone REQUESTED install → OK', async () => {
    const ticketId = await makeInstall(plantA, 'REQUESTED', null);
    const out = await service.scheduleInstall(ticketId, seAssigned, zmActorA, scopeZmA);
    expect(out.result).toBe('OK');
  });

  it('a ZM scheduling an OUT-OF-ZONE install is FORBIDDEN (no privilege escalation)', async () => {
    const ticketId = await makeInstall(plantB, 'REQUESTED', null);
    const out = await service.scheduleInstall(ticketId, seAssigned, zmActorA, scopeZmA);
    expect(out.result).toBe('FORBIDDEN');
    // The out-of-zone ticket was not moved.
    const t = await prisma.ticket.findUniqueOrThrow({ where: { ticketId } });
    expect(t.status).toBe('REQUESTED');
    expect(t.assignedSeId).toBeNull();
  });

  it('CSM and OH retain cross-zone scheduling authority', async () => {
    const tCsm = await makeInstall(plantB, 'REQUESTED', null);
    expect((await service.scheduleInstall(tCsm, seAssigned, csmActor, scopeCsm)).result).toBe('OK');
    const tOh = await makeInstall(plantB, 'REQUESTED', null);
    expect((await service.scheduleInstall(tOh, seAssigned, ohActor, scopeOh)).result).toBe('OK');
  });

  // ---- getInstallView zone / own-ticket clamp (AC#2) ----

  it('a ZM reads an in-zone install but NOT an out-of-zone one (no serial leak across zones)', async () => {
    const inZone = await makeInstall(plantA, 'ACTIVATED', seAssigned);
    const outZone = await makeInstall(plantB, 'ACTIVATED', seAssigned);
    expect(await service.getInstallView(inZone, scopeZmA)).not.toBeNull();
    expect(await service.getInstallView(outZone, scopeZmA)).toBeNull();
  });

  it('an SE reads only its own assigned install, not another SE\'s (no arbitrary serial read)', async () => {
    const mine = await makeInstall(plantA, 'ACTIVATED', seAssigned);
    expect(await service.getInstallView(mine, scopeSeAssigned)).not.toBeNull();
    expect(await service.getInstallView(mine, scopeSeOther)).toBeNull();
  });

  it('WM / CSM / OH keep cross-zone read of fitment serials (AC#5)', async () => {
    const outZone = await makeInstall(plantB, 'ACTIVATED', seAssigned);
    for (const scope of [scopeWm, scopeCsm, scopeOh]) {
      const view = await service.getInstallView(outZone, scope);
      expect(view).not.toBeNull();
      expect(view?.fittedSimSerial).toBe('SIM-Z');
    }
  });
});
