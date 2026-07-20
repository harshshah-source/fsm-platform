import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { assertBuildNotStale } from '../src/build-info/runtime-lock';
import { assertDepartureInvariant } from '../src/device-state/departure-invariant';
import { AutoPlantHealthService, type AutoPlantProbe } from '../src/ingestion/autoplant/health.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { TicketCreationService } from '../src/ticketing/ticket-creation.service';

/**
 * #130 Slice 4 — the July-19 simulation regression test. One coherent scenario, all four layers,
 * reusing a single consistent identity pair throughout:
 *   - CURRENT build (the patched, post-#128+#130 world): version 200, fingerprint 'currentsha'.
 *   - STALE build (the pre-#128 process that caused run 65 — no departure exclusion at all):
 *     version 100, fingerprint 'stalesha'.
 *
 * Root incident recap (docs/DEPARTED-VS-UNDEPLOYED-ANALYSIS.md, INDEX 2026-07-19/20 session log): a
 * process holding pre-#128 code connected to the post-#128 database, recomputed `device_states`
 * without the departure exclusion, cleared `is_departed` fleet-wide (eligible count rose
 * ~15,799 → ~21,000 as departed devices re-entered eligibility), and the `isDeparted: false` gate in
 * ticket creation opened for departed devices. This test proves every layer built across Slices 1–3
 * closes its slice of that story, and that L5 correctly flags the exact swing shape.
 */
describe('#130 Slice 4 — July-19 (run 65) simulation', () => {
  let prisma: PrismaService;
  let ticketCreation: TicketCreationService;

  const NOW = new Date(Date.UTC(2026, 6, 19, 18, 30, 0)); // the incident's actual time-of-day
  const CURRENT_BUILD = { version: 200, fingerprint: 'currentsha', dirty: false, appVersion: '0.0.1' } as const;
  const STALE_BUILD = { version: 100, fingerprint: 'stalesha', dirty: false, appVersion: '0.0.1' } as const;

  let zoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;
  const DEV_CORRUPTED = String(9_065_001n);
  const ALL_DEVICES = [DEV_CORRUPTED];

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    // onModuleInit() just took the lock for THIS process's real build — clear it so each test starts
    // from a clean runtime_lock and can seed its own simulated CURRENT_BUILD row without colliding.
    await prisma.$executeRawUnsafe('DELETE FROM runtime_lock');
    ticketCreation = new TicketCreationService(prisma);

    const zone = await prisma.zone.create({ data: { name: 'Z-run65sim-' + Date.now() } });
    zoneId = zone.zoneId;
    const company = await prisma.company.create({
      data: { name: 'Co-run65sim', companyTier: 'GOLD', companyPriorityRank: 'B' },
    });
    companyId = company.companyId;
    const plant = await prisma.plant.create({ data: { name: 'P-run65sim', zoneId } });
    plantId = plant.plantId;
  });

  afterEach(async () => {
    await prisma.$executeRawUnsafe('DELETE FROM runtime_lock');
    await prisma.$executeRawUnsafe('DELETE FROM device_state_recomputes');
    await prisma.ticketEvent.deleteMany({ where: { ticket: { deviceId: { in: ALL_DEVICES } } } });
    await prisma.ticket.deleteMany({ where: { deviceId: { in: ALL_DEVICES } } });
    await prisma.failureCycle.deleteMany({ where: { deviceId: { in: ALL_DEVICES } } });
    await prisma.deviceDeparture.deleteMany({ where: { deviceId: { in: ALL_DEVICES } } });
    await prisma.deviceState.deleteMany({ where: { deviceId: { in: ALL_DEVICES } } });
  });

  afterAll(async () => {
    await prisma.device.deleteMany({ where: { deviceId: { in: ALL_DEVICES } } });
    await prisma.plant.deleteMany({ where: { plantId } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId } });
    await prisma.onModuleDestroy();
  });

  /** Seed device_states/device_departures in the exact corrupted shape run 65 left behind. */
  const seedCorruptedDevice = async (): Promise<void> => {
    const existing = await prisma.device.findUnique({ where: { deviceId: DEV_CORRUPTED } });
    if (!existing) await prisma.device.create({ data: { deviceId: DEV_CORRUPTED } });
    await prisma.deviceState.create({
      data: {
        deviceId: DEV_CORRUPTED,
        isInactive: true,
        inactivityHours: 48,
        slaBucket: 'CRITICAL',
        eligibleForUptime: true,
        hasOpenFailureCycle: false,
        isDeparted: false, // WRONG — a pre-#128 recompute never derived this at all
        plantId,
        companyId,
        computedAt: NOW,
      },
    });
    await prisma.deviceDeparture.create({
      data: {
        deviceId: DEV_CORRUPTED,
        observedStatus: 'UNDEPLOYED',
        reason: 'SOURCE_STATUS',
        departedAt: new Date(NOW.getTime() - 7 * 24 * 3_600_000), // departed a week before the incident
        restoredAt: null,
      },
    });
  };

  const seedLock = (): Promise<number> =>
    prisma.$executeRawUnsafe(
      `INSERT INTO runtime_lock (id, version, fingerprint, app_version, migration_head, boot_at, pid, hostname, updated_at)
       VALUES (1, ${CURRENT_BUILD.version}, '${CURRENT_BUILD.fingerprint}', '0.0.1', 'head', now(), 9999, 'prod-host', now())`,
    );

  it('L1 — the exact stale process (pre-#128 build) refuses to boot against the patched database', async () => {
    await seedLock();

    await expect(assertBuildNotStale(prisma, STALE_BUILD)).rejects.toThrow(/stale-build refused/i);

    // The lock is untouched — the stale process never got to own it.
    const rows = await prisma.$queryRawUnsafe<Array<{ version: string }>>(
      'SELECT version::text AS version FROM runtime_lock WHERE id = 1',
    );
    expect(rows[0]?.version).toBe(String(CURRENT_BUILD.version));
  });

  it('L2 ticket-creation — the corrupted state (already written, as it was in the real incident) yields zero tickets', async () => {
    await seedCorruptedDevice();

    await ticketCreation.createForInactiveEligible(NOW);

    expect(await prisma.ticket.count({ where: { deviceId: DEV_CORRUPTED } })).toBe(0);
  });

  it('L2 recompute invariant — the corrupted state trips the invariant (would be rolled back, never committed)', async () => {
    await seedCorruptedDevice();

    await expect(prisma.$transaction(async (tx) => assertDepartureInvariant(tx))).rejects.toThrow(
      /recompute-invariant violated/i,
    );
  });

  it('L5 — the simulated stale recompute\'s ledger row is flagged staleBuild and trips the canary (~15,799 → ~21,000, the real swing shape)', async () => {
    await seedLock();

    // A prior GOOD recompute (correct build, healthy operational baseline) — the pre-incident state.
    await prisma.deviceStateRecompute.create({
      data: {
        computedAt: new Date(NOW.getTime() - 3_600_000),
        eligibleCount: 15_799,
        inactiveCount: 3_000,
        departedCount: 5_523,
        totalCount: 21_322,
        buildVersion: BigInt(CURRENT_BUILD.version),
        buildFingerprint: CURRENT_BUILD.fingerprint,
        trigger: 'cron',
      },
    });

    // THE stale recompute — run under the pre-#128 build (below the lock), departed devices silently
    // re-entering eligibility (the real incident's exact swing direction, not a drop).
    await prisma.deviceStateRecompute.create({
      data: {
        computedAt: NOW,
        eligibleCount: 21_000,
        inactiveCount: 3_000,
        departedCount: 0, // the stale build never derived departures at all
        totalCount: 21_322,
        buildVersion: BigInt(STALE_BUILD.version),
        buildFingerprint: STALE_BUILD.fingerprint,
        trigger: 'cron',
      },
    });

    const probe: AutoPlantProbe = { isConfigured: () => false, ping: async () => ({ ok: true, vehicleRows: 0 }) };
    const health = await new AutoPlantHealthService(prisma, probe).check();

    const staleRow = health.recomputes.find((r) => r.buildFingerprint === STALE_BUILD.fingerprint);
    expect(staleRow).toBeDefined();
    expect(staleRow!.staleBuild).toBe(true); // build_version 100 < lock 200
    expect(staleRow!.swing).toBe(true); // 15,799 → 21,000 exceeds the 5% threshold
    expect(staleRow!.swingPct).toBeGreaterThan(5);
  });
});
