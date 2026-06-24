import { PrismaService } from '../src/prisma/prisma.service';
import { Prisma } from '../src/generated/prisma/client';

/**
 * Issue 08, slice 5a — invariant I1 covers REPEAT and ESCALATED. A REPEAT cycle is the device's
 * current (active) repeat episode, and an ESCALATED cycle is a still-down device flagged to ZM+WM
 * (LLD §10.2: ESCALATED is not a closed ticket status). Both are active episodes, so the partial
 * UNIQUE `failure_cycles_one_active_per_device` must reject a second active cycle for the device —
 * the DB is the final guard behind the `has_open_failure_cycle` fast-path.
 */
const DEV_REPEAT = 9_087_001n;
const DEV_ESCALATED = 9_087_002n;
const ALL = [DEV_REPEAT, DEV_ESCALATED];

const isUniqueViolation = (e: unknown): boolean =>
  e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';

describe('Issue 08 slice 5a — I1 partial-unique covers REPEAT + ESCALATED', () => {
  let prisma: PrismaService;
  const openedAt = new Date(Date.UTC(2026, 5, 20, 12, 0, 0));

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    for (const deviceId of ALL) await prisma.device.create({ data: { deviceId } });
  });

  afterAll(async () => {
    await prisma.failureCycle.deleteMany({ where: { deviceId: { in: ALL } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: ALL } } });
    await prisma.onModuleDestroy();
  });

  it('rejects a second active cycle for a device already in REPEAT', async () => {
    await prisma.failureCycle.create({ data: { deviceId: DEV_REPEAT, state: 'REPEAT', openedAt } });

    let threw: unknown;
    try {
      await prisma.failureCycle.create({ data: { deviceId: DEV_REPEAT, state: 'OPEN', openedAt } });
    } catch (e) {
      threw = e;
    }
    expect(isUniqueViolation(threw)).toBe(true);
  });

  it('rejects a second active cycle for a device already ESCALATED', async () => {
    await prisma.failureCycle.create({ data: { deviceId: DEV_ESCALATED, state: 'ESCALATED', openedAt } });

    let threw: unknown;
    try {
      await prisma.failureCycle.create({ data: { deviceId: DEV_ESCALATED, state: 'OPEN', openedAt } });
    } catch (e) {
      threw = e;
    }
    expect(isUniqueViolation(threw)).toBe(true);
  });
});
