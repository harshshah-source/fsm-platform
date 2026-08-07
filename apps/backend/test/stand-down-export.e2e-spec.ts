import { randomUUID } from 'node:crypto';
import { resolve as resolvePath } from 'node:path';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  buildStandDownRows,
  readStandDownPathArg,
  toStandDownCsv,
} from '../src/device-departure/stand-down-export';

/**
 * Issue 218c — the live-batch stand-down list (FIX-PLAN §7.5, "one thing I would add before step 4",
 * and the §9 settled decision: flat file, no grouping by engineer or day).
 *
 * The catch-up window force-closes every open ticket belonging to a departing device. Most of those
 * are inert backlog, but a measured 1,461 of them (SOURCE_STATUS cohort) sit on **live dispatch
 * batches** — `removed_at IS NULL` — meaning an engineer's day plan is built on a ticket that is about
 * to vanish underneath it. Nothing in `openDepartures` removes the batch assignment; it closes the
 * ticket and writes the event. This export is what dispatch stands those visits down from, rather than
 * discovering them missing.
 *
 * The seam is the row builder, not the file: given the departure plan's device ids, produce exactly
 * the ticket/batch pairs that the window will close while they are still live.
 */
const NS = Date.now();
const NOW = new Date('2026-08-07T09:00:00Z');
const DAY = new Date(Date.UTC(2026, 7, 7));

describe('#218c — live-batch stand-down export', () => {
  let prisma: PrismaService;

  // Fixture handles, torn down in afterAll.
  let zoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;
  let userId: string;
  let scheduleId: bigint;
  let batchId: bigint;
  const ticketIds: string[] = [];
  const deviceIds: string[] = [];
  const vehicleIds: bigint[] = [];

  /** Seeds device + vehicle + an OPEN ticket, optionally on the live batch. */
  const seedTicket = async (
    label: string,
    opts: { onBatch: boolean; removedFromBatch?: boolean; status?: 'OPEN' | 'CLOSED' },
  ): Promise<{ deviceId: string; ticketId: string; vehicleNo: string }> => {
    const deviceId = `RR_D218C${NS}${label}`;
    const vehicleNo = `ZZ218C${NS}${label}`;
    const vehicle = await prisma.vehicle.create({
      data: { vehicleNo, plantId, companyId, status: 'DEPLOYED' },
    });
    vehicleIds.push(vehicle.vehicleId);
    await prisma.device.create({ data: { deviceId, currentVehicleId: vehicle.vehicleId } });
    deviceIds.push(deviceId);
    const cycle = await prisma.failureCycle.create({ data: { deviceId, state: 'OPEN', openedAt: NOW } });
    const ticket = await prisma.ticket.create({
      data: {
        workType: 'TROUBLESHOOT',
        status: opts.status ?? 'OPEN',
        failureCycleId: cycle.cycleId,
        deviceId,
        vehicleId: vehicle.vehicleId,
        plantId,
        companyId,
        companyTier: 'GOLD',
        assignmentState: opts.onBatch ? 'FORMALLY_ASSIGNED' : 'UNASSIGNED',
        lastStateChangedAt: NOW,
      },
    });
    ticketIds.push(ticket.ticketId);
    if (opts.onBatch) {
      await prisma.batchAssignmentTicket.create({
        data: {
          batchId,
          ticketId: ticket.ticketId,
          sortOrder: ticketIds.length,
          removedAt: opts.removedFromBatch ? new Date('2026-08-06T10:00:00Z') : null,
        },
      });
    }
    return { deviceId, ticketId: ticket.ticketId, vehicleNo };
  };

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();

    zoneId = (await prisma.zone.create({ data: { name: `Z-218c-${NS}` } })).zoneId;
    companyId = (
      await prisma.company.create({
        data: { name: `Co-218c-${NS}`, companyTier: 'GOLD', companyPriorityRank: 'B' },
      })
    ).companyId;
    plantId = (await prisma.plant.create({ data: { name: `Kadapa-218c-${NS}`, zoneId } })).plantId;
    const tag = randomUUID().slice(0, 8);
    const user = await prisma.user.create({
      data: { name: `SE ${tag}`, role: 'SERVICE_ENGINEER', phone: `ph-${tag}`, email: `${tag}@standdown.test`, zoneId },
    });
    userId = user.userId;
    await prisma.engineerMaster.create({
      data: { engineerId: userId, coverageType: 'DEDICATED', zoneId, dailyCapacity: 10 },
    });
    scheduleId = (
      await prisma.workSchedule.create({
        data: { seId: userId, zoneId, dateFrom: DAY, dateTo: DAY, status: 'ACTIVE', source: 'SYSTEM_GENERATED' },
      })
    ).scheduleId;
    batchId = (
      await prisma.plantBatchAssignment.create({
        data: { scheduleId, plantId, seId: userId, status: 'AUTO_ASSIGNED', stopSequence: 1 },
      })
    ).batchId;
  });

  afterAll(async () => {
    await prisma.batchAssignmentTicket.deleteMany({ where: { batchId } });
    await prisma.plantBatchAssignment.deleteMany({ where: { batchId } });
    await prisma.workSchedule.deleteMany({ where: { scheduleId } });
    await prisma.ticket.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.failureCycle.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.vehicle.deleteMany({ where: { vehicleId: { in: vehicleIds } } });
    await prisma.plant.deleteMany({ where: { plantId } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.engineerMaster.deleteMany({ where: { engineerId: userId } });
    await prisma.user.deleteMany({ where: { userId } });
    await prisma.zone.deleteMany({ where: { zoneId } });
    await prisma.onModuleDestroy();
  });

  it('exports the ticket a departing device holds on a live batch, with the fields dispatch needs', async () => {
    const live = await seedTicket('A', { onBatch: true });

    const rows = await buildStandDownRows(prisma, [live.deviceId]);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      ticketId: live.ticketId,
      deviceId: live.deviceId,
      vehicleNo: live.vehicleNo,
      plant: `Kadapa-218c-${NS}`,
      batchId: batchId.toString(),
    });
  });

  it('omits a ticket already pulled off the batch — dispatch is not visiting it', async () => {
    const removed = await seedTicket('B', { onBatch: true, removedFromBatch: true });

    expect(await buildStandDownRows(prisma, [removed.deviceId])).toEqual([]);
  });

  it('omits an unassigned ticket — it closes in the window, but no engineer is standing on it', async () => {
    const backlog = await seedTicket('C', { onBatch: false });

    expect(await buildStandDownRows(prisma, [backlog.deviceId])).toEqual([]);
  });

  it('omits a ticket that is already terminal — the window will not close what is closed', async () => {
    const closed = await seedTicket('D', { onBatch: true, status: 'CLOSED' });

    expect(await buildStandDownRows(prisma, [closed.deviceId])).toEqual([]);
  });

  it('returns nothing for a device that is not departing', async () => {
    const other = await seedTicket('E', { onBatch: true });

    // The device holds a live-batch ticket, but it is not in the departure plan, so the window does
    // not touch it. Scope comes from the plan, never from "every live batch ticket".
    expect(await buildStandDownRows(prisma, [`RR_D218C${NS}_absent`])).toEqual([]);
    expect(await buildStandDownRows(prisma, [other.deviceId])).toHaveLength(1);
  });

  describe('CSV serialisation', () => {
    it('writes the agreed header and one line per row', () => {
      const csv = toStandDownCsv([
        { ticketId: 't-1', deviceId: 'd-1', vehicleNo: 'KA63A1236', plant: 'Kadapa', batchId: '99' },
      ]);

      expect(csv.split('\n')).toEqual(['ticket_id,device_id,vehicle_no,plant,batch_id', 't-1,d-1,KA63A1236,Kadapa,99']);
    });

    it('quotes values containing a comma or a quote, so a plant name cannot shift the columns', () => {
      const csv = toStandDownCsv([
        { ticketId: 't-2', deviceId: 'd-2', vehicleNo: 'HR56C9358', plant: 'Satna, MP', batchId: '100' },
        { ticketId: 't-3', deviceId: 'd-3', vehicleNo: '', plant: 'The "Old" Depot', batchId: '101' },
      ]);

      const lines = csv.split('\n');
      expect(lines[1]).toBe('t-2,d-2,HR56C9358,"Satna, MP",100');
      expect(lines[2]).toBe('t-3,d-3,,"The ""Old"" Depot",101');
    });

    it('still emits the header when there is nothing to stand down', () => {
      expect(toStandDownCsv([])).toBe('ticket_id,device_id,vehicle_no,plant,batch_id');
    });
  });

  describe('--export-standdown flag', () => {
    it('is off unless asked for — the dry-run stays byte-identical by default', () => {
      expect(readStandDownPathArg([])).toBeNull();
      expect(readStandDownPathArg(['--something-else'])).toBeNull();
    });

    it('resolves the given path to an absolute one, so the file lands where the operator expects', () => {
      expect(readStandDownPathArg(['--export-standdown', 'standdown.csv'])).toBe(
        resolvePath('standdown.csv'),
      );
    });

    it('refuses a missing path rather than silently exporting nowhere', () => {
      expect(() => readStandDownPathArg(['--export-standdown'])).toThrow(/requires a file path/);
      // The next flag is not a filename — accepting it would write a file called "--verbose".
      expect(() => readStandDownPathArg(['--export-standdown', '--verbose'])).toThrow(/requires a file path/);
    });
  });
});
