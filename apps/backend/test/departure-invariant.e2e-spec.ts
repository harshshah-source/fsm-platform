import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/prisma/prisma.service';
import { assertDepartureInvariant } from '../src/device-state/departure-invariant';

/**
 * #130 L2 decision 4 — the recompute invariant, tested at its own seam so a genuine violation can be
 * proven caught without needing to break the (already-correct) recompute SQL to manufacture one. A
 * violating `device_states` row is seeded directly (bypassing recompute), mirroring the real recompute
 * always producing a correct state — the invariant exists as a backstop against a FUTURE regression
 * (a stale/broken build, a race) producing exactly this corruption.
 */
const DEV_VIOLATION = String(9_058_001n);
const DEV_CORRECT = String(9_058_002n);
const ALL = [DEV_VIOLATION, DEV_CORRECT];

describe('#130 L2 — assertDepartureInvariant', () => {
  let prisma: PrismaService;

  const NOW = new Date(Date.UTC(2026, 6, 20, 12, 0, 0));

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    for (const deviceId of ALL) await prisma.device.create({ data: { deviceId } });
  });

  afterEach(async () => {
    await prisma.deviceDeparture.deleteMany({ where: { deviceId: { in: ALL } } });
    await prisma.deviceState.deleteMany({ where: { deviceId: { in: ALL } } });
  });

  afterAll(async () => {
    await prisma.device.deleteMany({ where: { deviceId: { in: ALL } } });
    await prisma.onModuleDestroy();
  });

  it('throws when a device with an active departure is (wrongly) still marked operational — the run-65 shape', async () => {
    await prisma.deviceState.create({
      data: {
        deviceId: DEV_VIOLATION,
        isInactive: false,
        eligibleForUptime: true, // WRONG — a departed device must never be eligible
        isDeparted: false, // WRONG — the exact run-65 corruption
        computedAt: NOW,
      },
    });
    await prisma.deviceDeparture.create({
      data: {
        deviceId: DEV_VIOLATION,
        observedStatus: 'UNDEPLOYED',
        reason: 'SOURCE_STATUS',
        departedAt: new Date(NOW.getTime() - 3_600_000),
        restoredAt: null,
      },
    });

    await expect(prisma.$transaction(async (tx) => assertDepartureInvariant(tx))).rejects.toThrow(
      /recompute-invariant violated/i,
    );
  });

  it('resolves when the departed device is correctly excluded (is_departed=true, everything else cleared)', async () => {
    await prisma.deviceState.create({
      data: {
        deviceId: DEV_CORRECT,
        isInactive: false,
        eligibleForUptime: false,
        isDeparted: true, // correct
        computedAt: NOW,
      },
    });
    await prisma.deviceDeparture.create({
      data: {
        deviceId: DEV_CORRECT,
        observedStatus: 'UNDEPLOYED',
        reason: 'SOURCE_STATUS',
        departedAt: new Date(NOW.getTime() - 3_600_000),
        restoredAt: null,
      },
    });

    await expect(prisma.$transaction(async (tx) => assertDepartureInvariant(tx))).resolves.toBeUndefined();
  });

  it('resolves when there are no active departures at all (nothing to check)', async () => {
    await expect(prisma.$transaction(async (tx) => assertDepartureInvariant(tx))).resolves.toBeUndefined();
  });
});
