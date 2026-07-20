import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/prisma/prisma.service';
import { TicketCreationService } from '../src/ticketing/ticket-creation.service';

/**
 * #130 L2 — THE run-65 gap. `createForInactiveEligible` gated on the DERIVED `device_states.is_departed`
 * flag (`ticket-creation.service.ts:41`). The 2026-07-19 incident showed exactly why that is unsafe: a
 * stale-code recompute cleared `is_departed` fleet-wide while the real ledger (`device_departures`) still
 * held the active departure — and the flag-only gate opened for every departed device.
 *
 * Fix: re-read `device_departures` directly at ticket-creation time, the identical shape the
 * recommender already uses (`recommender.service.ts:113`) — `device: { departures: { none: {
 * restoredAt: null } } }`. This is defence in depth ON TOP of the (correctly-behaving) derived flag,
 * not a replacement for it: the flag is defence in depth for the ledger re-read too, in the other
 * direction (closes the window between a departure and the next recompute, per the existing comment).
 */
const DEV_DEPARTED_STALE_FLAG = String(9_057_001n);
const DEV_NORMAL_INACTIVE = String(9_057_002n);
const ALL = [DEV_DEPARTED_STALE_FLAG, DEV_NORMAL_INACTIVE];

describe('#130 L2 — ticket-creation re-reads device_departures, not the derived flag', () => {
  let prisma: PrismaService;
  let service: TicketCreationService;
  let zoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;

  const NOW = new Date(Date.UTC(2026, 5, 20, 12, 0, 0));

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    service = new TicketCreationService(prisma);

    const zone = await prisma.zone.create({ data: { name: 'Z-130L2-' + Date.now() } });
    zoneId = zone.zoneId;
    const company = await prisma.company.create({
      data: { name: 'Co-130L2', companyTier: 'GOLD', companyPriorityRank: 'B' },
    });
    companyId = company.companyId;
    const plant = await prisma.plant.create({ data: { name: 'P-130L2', zoneId } });
    plantId = plant.plantId;

    for (const deviceId of ALL) await prisma.device.create({ data: { deviceId } });

    // The run-65 corrupted state: inactive + eligible + is_departed WRONGLY false (the recompute bug
    // cleared it fleet-wide), but the source-of-truth ledger still holds an ACTIVE departure row.
    await prisma.deviceState.create({
      data: {
        deviceId: DEV_DEPARTED_STALE_FLAG,
        isInactive: true,
        inactivityHours: 40,
        slaBucket: 'CRITICAL',
        eligibleForUptime: true,
        hasOpenFailureCycle: false,
        isDeparted: false, // stale/wrong — this is the exact corruption shape
        plantId,
        companyId,
        computedAt: NOW,
      },
    });
    await prisma.deviceDeparture.create({
      data: {
        deviceId: DEV_DEPARTED_STALE_FLAG,
        observedStatus: 'UNDEPLOYED',
        reason: 'SOURCE_STATUS',
        departedAt: new Date(NOW.getTime() - 3_600_000),
        restoredAt: null, // ACTIVE — the ledger's truth
      },
    });

    // Control: a genuinely inactive+eligible device with no departure at all — must still be ticketed.
    await prisma.deviceState.create({
      data: {
        deviceId: DEV_NORMAL_INACTIVE,
        isInactive: true,
        inactivityHours: 40,
        slaBucket: 'CRITICAL',
        eligibleForUptime: true,
        hasOpenFailureCycle: false,
        isDeparted: false,
        plantId,
        companyId,
        computedAt: NOW,
      },
    });
  });

  afterAll(async () => {
    await prisma.ticketEvent.deleteMany({ where: { ticket: { deviceId: { in: ALL } } } });
    await prisma.ticket.deleteMany({ where: { deviceId: { in: ALL } } });
    await prisma.failureCycle.deleteMany({ where: { deviceId: { in: ALL } } });
    await prisma.deviceDeparture.deleteMany({ where: { deviceId: { in: ALL } } });
    await prisma.deviceState.deleteMany({ where: { deviceId: { in: ALL } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: ALL } } });
    await prisma.plant.deleteMany({ where: { plantId } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId } });
    await prisma.onModuleDestroy();
  });

  it('does NOT ticket a device with an active device_departures row, even when is_departed is (wrongly) false', async () => {
    await service.createForInactiveEligible(NOW);
    expect(await prisma.ticket.count({ where: { deviceId: DEV_DEPARTED_STALE_FLAG } })).toBe(0);
  });

  it('still tickets a genuinely inactive+eligible device with no departure row (no over-exclusion)', async () => {
    await service.createForInactiveEligible(NOW);
    expect(await prisma.ticket.count({ where: { deviceId: DEV_NORMAL_INACTIVE } })).toBe(1);
  });
});
