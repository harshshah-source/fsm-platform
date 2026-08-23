import { PrismaService } from '../src/prisma/prisma.service';
import { foldAndResumeSlaPause } from '../src/ticketing/sla-pause';

/**
 * #271 — the shared fold-and-resume helper, exercised directly against a bare `FailureCycle` (no
 * ticket, no submission) so the maths and the race guard are pinned without any writer's surrounding
 * transitions in the way. Each writer's own integration is pinned in its own spec
 * (`troubleshoot-submission`, `verification-run`, `vehicle-return-resume`, `vu-sla-resume-correctness`,
 * `component-request-receipt`).
 */
const NS = Date.now();
const PAUSED_AT = new Date('2026-08-24T02:00:00Z');
const NOW = new Date('2026-08-24T04:00:00Z'); // exactly 2h later — 7200s

describe('#271 — foldAndResumeSlaPause', () => {
  let prisma: PrismaService;
  const deviceIds: string[] = [];

  const makeCycle = async (
    overrides: Partial<{
      slaPaused: boolean;
      slaPauseReason: 'VEHICLE_UNAVAILABLE' | 'WAITING_COMPONENT' | null;
      slaPausedAt: Date | null;
      slaAccumulatedPauseSeconds: bigint;
    }> = {},
  ): Promise<string> => {
    const deviceId = String(9_920_000_000 + deviceIds.length + (NS % 100_000));
    await prisma.device.create({ data: { deviceId } });
    deviceIds.push(deviceId);
    const cycle = await prisma.failureCycle.create({
      data: {
        deviceId,
        state: 'OPEN',
        openedAt: new Date('2026-08-24T00:00:00Z'),
        slaPaused: overrides.slaPaused ?? true,
        slaPauseReason: overrides.slaPauseReason === undefined ? 'VEHICLE_UNAVAILABLE' : overrides.slaPauseReason,
        slaPausedAt: overrides.slaPausedAt === undefined ? PAUSED_AT : overrides.slaPausedAt,
        slaPauseSource: 'SE_VEHICLE_UNAVAILABLE',
        slaAccumulatedPauseSeconds: overrides.slaAccumulatedPauseSeconds ?? 0n,
      },
    });
    return cycle.cycleId;
  };

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
  });

  afterAll(async () => {
    await prisma.failureCycle.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.onModuleDestroy();
  });

  it('is a no-op on a cycle with no active pause', async () => {
    const cycleId = await makeCycle({ slaPaused: false, slaPauseReason: null, slaPausedAt: null });
    const result = await prisma.$transaction((tx) => foldAndResumeSlaPause(tx, cycleId, NOW));
    expect(result).toEqual({ resumed: false, addedSeconds: 0 });
  });

  it('folds the exact elapsed interval and clears every pause column', async () => {
    const cycleId = await makeCycle();
    const result = await prisma.$transaction((tx) => foldAndResumeSlaPause(tx, cycleId, NOW));
    expect(result).toEqual({ resumed: true, addedSeconds: 7200 });

    const cycle = await prisma.failureCycle.findUniqueOrThrow({ where: { cycleId } });
    expect(cycle.slaPaused).toBe(false);
    expect(cycle.slaPauseReason).toBeNull();
    expect(cycle.slaPausedAt).toBeNull();
    expect(cycle.slaPauseSource).toBeNull();
    expect(Number(cycle.slaAccumulatedPauseSeconds)).toBe(7200);
  });

  it('adds to a non-zero running total rather than overwriting it', async () => {
    const cycleId = await makeCycle({ slaAccumulatedPauseSeconds: 500n });
    await prisma.$transaction((tx) => foldAndResumeSlaPause(tx, cycleId, NOW));
    const cycle = await prisma.failureCycle.findUniqueOrThrow({ where: { cycleId } });
    expect(Number(cycle.slaAccumulatedPauseSeconds)).toBe(500 + 7200);
  });

  it('onlyReason guards against folding a pause standing for a different reason', async () => {
    const cycleId = await makeCycle({ slaPauseReason: 'WAITING_COMPONENT' });
    const result = await prisma.$transaction((tx) =>
      foldAndResumeSlaPause(tx, cycleId, NOW, { onlyReason: 'VEHICLE_UNAVAILABLE' }),
    );
    expect(result).toEqual({ resumed: false, addedSeconds: 0 });

    const cycle = await prisma.failureCycle.findUniqueOrThrow({ where: { cycleId } });
    expect(cycle.slaPaused).toBe(true);
    expect(cycle.slaPauseReason).toBe('WAITING_COMPONENT');
    expect(Number(cycle.slaAccumulatedPauseSeconds)).toBe(0);
  });

  it('onlyReason folds when the reason matches', async () => {
    const cycleId = await makeCycle({ slaPauseReason: 'VEHICLE_UNAVAILABLE' });
    const result = await prisma.$transaction((tx) =>
      foldAndResumeSlaPause(tx, cycleId, NOW, { onlyReason: 'VEHICLE_UNAVAILABLE' }),
    );
    expect(result).toEqual({ resumed: true, addedSeconds: 7200 });
  });

  it('with no onlyReason, folds a pause regardless of its reason (the generic/defensive mode)', async () => {
    const cycleId = await makeCycle({ slaPauseReason: 'WAITING_COMPONENT' });
    const result = await prisma.$transaction((tx) => foldAndResumeSlaPause(tx, cycleId, NOW));
    expect(result).toEqual({ resumed: true, addedSeconds: 7200 });
  });

  it('AC-7 — exactly one winner under a genuine two-connection race for the same pause', async () => {
    const cycleId = await makeCycle();

    const prismaB = new PrismaService();
    await prismaB.onModuleInit();
    try {
      const [a, b] = await Promise.all([
        prisma.$transaction((tx) => foldAndResumeSlaPause(tx, cycleId, NOW, { onlyReason: 'VEHICLE_UNAVAILABLE' })),
        prismaB.$transaction((tx) =>
          foldAndResumeSlaPause(tx, cycleId, new Date(NOW.getTime() + 5_000), { onlyReason: 'VEHICLE_UNAVAILABLE' }),
        ),
      ]);

      const winners = [a, b].filter((r) => r.resumed);
      expect(winners).toHaveLength(1);
      // The loser adds nothing — the accumulated total reflects exactly one fold, not two.
      const cycle = await prisma.failureCycle.findUniqueOrThrow({ where: { cycleId } });
      expect(Number(cycle.slaAccumulatedPauseSeconds)).toBe(winners[0].addedSeconds);
      expect(cycle.slaPaused).toBe(false);
    } finally {
      await prismaB.onModuleDestroy();
    }
  });
});
