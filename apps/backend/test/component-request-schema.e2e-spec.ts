import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Issue 22, slice 1 — Component Request schema (LLD D12 / ADR-0008, CONTEXT §8). A `component_request`
 * raised when an SE submits a Troubleshoot form with `component_unavailable=true`. v1 lifecycle
 * REQUESTED → APPROVED | REJECTED → SHIPPED → RECEIVED; carries the requested component, the raising
 * submission, and `delivery_destination = SE_LOCATION | PLANT_WAREHOUSE`. One request per submission
 * (idempotent raise). Asserts the FK chains, the per-submission unique, and a create round-trip.
 */
const NS = Date.now();

describe('Issue 22 slice 1 — component request schema', () => {
  let prisma: PrismaService;

  let zoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;
  let componentId: bigint;
  let se: string;
  let deviceId: bigint;
  let ticketId: string;
  let cycleId: string;
  let submissionId: string;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();

    zoneId = (await prisma.zone.create({ data: { name: 'Z-cr-' + NS } })).zoneId;
    companyId = (
      await prisma.company.create({ data: { name: 'Co-cr-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })
    ).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'P-cr-' + NS, zoneId } })).plantId;
    componentId = (await prisma.componentMaster.create({ data: { name: 'GPS-cable-' + NS } })).componentId;

    const tag = randomUUID().slice(0, 8);
    const u = await prisma.user.create({
      data: { name: 'SE ' + tag, role: 'SERVICE_ENGINEER', phone: 'ph-' + tag, email: `${tag}@cr.test`, zoneId },
    });
    se = u.userId;
    await prisma.engineerMaster.create({ data: { engineerId: se, coverageType: 'DEDICATED', zoneId, dailyCapacity: 10 } });

    deviceId = BigInt(11_500_000_000 + (NS % 1_000_000));
    await prisma.device.create({ data: { deviceId } });
    cycleId = (await prisma.failureCycle.create({ data: { deviceId, state: 'OPEN', openedAt: new Date() } })).cycleId;
    ticketId = (
      await prisma.ticket.create({
        data: {
          workType: 'TROUBLESHOOT',
          status: 'OPEN',
          failureCycleId: cycleId,
          deviceId,
          plantId,
          companyId,
          companyTier: 'GOLD',
          lastStateChangedAt: new Date(),
        },
      })
    ).ticketId;
    submissionId = (
      await prisma.troubleshootingSubmission.create({
        data: {
          ticketId,
          failureCycleId: cycleId,
          submissionType: 'TROUBLESHOOTING_FORM',
          clientSubmissionId: randomUUID(),
          seId: se,
          presenceSource: 'NONE',
          componentUnavailable: true,
          componentUnavailableItem: componentId,
          rootCauseCategory: 'POWER_ISSUE',
          submittedAt: new Date(),
        },
      })
    ).submissionId;
  });

  afterAll(async () => {
    await prisma.componentRequest.deleteMany({ where: { ticketId } });
    await prisma.troubleshootingSubmission.deleteMany({ where: { ticketId } });
    await prisma.ticket.deleteMany({ where: { ticketId } });
    await prisma.failureCycle.deleteMany({ where: { deviceId } });
    await prisma.device.deleteMany({ where: { deviceId } });
    await prisma.engineerMaster.deleteMany({ where: { engineerId: se } });
    await prisma.user.deleteMany({ where: { userId: se } });
    await prisma.componentMaster.deleteMany({ where: { componentId } });
    await prisma.plant.deleteMany({ where: { plantId } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId } });
    await prisma.onModuleDestroy();
  });

  const fkExists = async (table: string, column: string, refTable: string): Promise<boolean> => {
    const rows = await prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name
      JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND tc.table_name = ${table} AND kcu.column_name = ${column} AND ccu.table_name = ${refTable}`;
    return Number(rows[0].n) >= 1;
  };
  const indexDefs = async (table: string): Promise<string[]> => {
    const rows = await prisma.$queryRaw<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = ${table}`;
    return rows.map((r) => r.indexdef);
  };

  it('creates component_request with FK chains to ticket / submission / engineer / component', async () => {
    expect(await fkExists('component_request', 'ticket_id', 'tickets')).toBe(true);
    expect(await fkExists('component_request', 'submission_id', 'troubleshooting_submissions')).toBe(true);
    expect(await fkExists('component_request', 'se_id', 'engineer_master')).toBe(true);
    expect(await fkExists('component_request', 'component_id', 'component_master')).toBe(true);
  });

  it('enforces one request per submission (idempotent raise)', async () => {
    const defs = await indexDefs('component_request');
    expect(defs.some((d) => /UNIQUE/.test(d) && /submission_id/.test(d))).toBe(true);
  });

  it('round-trips a REQUESTED row with a delivery destination', async () => {
    const created = await prisma.componentRequest.create({
      data: {
        ticketId,
        failureCycleId: cycleId,
        submissionId,
        seId: se,
        componentId,
        status: 'REQUESTED',
        deliveryDestination: 'PLANT_WAREHOUSE',
      },
    });
    expect(created.status).toBe('REQUESTED');
    expect(created.deliveryDestination).toBe('PLANT_WAREHOUSE');
    const found = await prisma.componentRequest.findUniqueOrThrow({ where: { requestId: created.requestId } });
    expect(found.submissionId).toBe(submissionId);
  });
});
