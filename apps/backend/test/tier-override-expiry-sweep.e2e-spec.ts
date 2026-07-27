import { PrismaService } from '../src/prisma/prisma.service';
import { TierOverrideExpiryService } from '../src/org/tier-override-expiry.service';

/**
 * Issue 157, Slice 4 — the auto-revert-at-expiry sweep (AC-5). Flips ACTIVE overrides whose
 * `expiresAt` has passed to EXPIRED and audits `TIER_OVERRIDE_EXPIRED` (actor = system, Q1). Two
 * things this sweep must NOT do: touch a not-yet-expired ACTIVE row, or re-stamp any existing
 * ticket's `company_tier` (Q-B: live reads only — an override's lifecycle never retroactively
 * changes an already-created ticket).
 */
const NS = Date.now();

describe('Issue 157 Slice 4 — TierOverrideExpiryService.sweepExpiredOverrides', () => {
  let prisma: PrismaService;
  let service: TierOverrideExpiryService;
  let zoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;
  let expiredOverrideId: bigint;
  let stillActiveOverrideId: bigint;
  let deviceId: string;
  let ticketId: string;

  const NOW = new Date('2026-07-24T06:00:00Z');

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    service = new TierOverrideExpiryService(prisma);

    zoneId = (await prisma.zone.create({ data: { name: 'Z157expiry-' + NS } })).zoneId;
    companyId = (
      await prisma.company.create({ data: { name: 'Co157expiry-' + NS, companyTier: 'SILVER', companyPriorityRank: 'C' } })
    ).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'P157expiry-' + NS, zoneId } })).plantId;

    // An override already past its expiresAt (created "in the past" relative to NOW) — the sweep
    // target. expiresAt must satisfy the DB CHECK (> createdAt) at insert time, so it is created
    // with an expiry a few minutes after its own creation, both of which are before NOW.
    const created = new Date(NOW.getTime() - 2 * 60 * 60 * 1000);
    const expired = await prisma.companyTierOverride.create({
      data: {
        companyId,
        zoneId,
        tier: 'PLATINUM',
        reason: 'Expiry-sweep fixture — already past its expiresAt at sweep time',
        expiresAt: new Date(created.getTime() + 60 * 60 * 1000), // expires 1h after creation, 1h before NOW
        status: 'ACTIVE',
        createdAt: created,
      },
    });
    expiredOverrideId = expired.id;

    // A second override that is still comfortably ACTIVE — must be left untouched by the sweep.
    // createdAt is pinned relative to NOW (not left to default now()) so the row keeps satisfying the
    // DB CHECK (expires_at > created_at) no matter the real wall-clock date — same reason the expired
    // fixture above sets its own createdAt.
    const stillActive = await prisma.companyTierOverride.create({
      data: {
        companyId,
        zoneId,
        tier: 'GOLD',
        reason: 'Expiry-sweep fixture — must survive the sweep untouched',
        expiresAt: new Date(NOW.getTime() + 24 * 60 * 60 * 1000),
        status: 'ACTIVE',
        createdAt: new Date(NOW.getTime() - 60 * 60 * 1000), // 1h before NOW, < expiresAt and within the 2-month window
      },
    });
    stillActiveOverrideId = stillActive.id;

    // An existing OPEN ticket stamped PLATINUM (as if created while the now-expired override was
    // live) — the AC-5 no-re-stamp pin target.
    deviceId = String(9_402_000_000 + (NS % 100_000));
    await prisma.device.create({ data: { deviceId } });
    const cycle = await prisma.failureCycle.create({ data: { deviceId, state: 'OPEN', openedAt: NOW } });
    const ticket = await prisma.ticket.create({
      data: {
        workType: 'TROUBLESHOOT',
        status: 'OPEN',
        failureCycleId: cycle.cycleId,
        deviceId,
        plantId,
        companyId,
        companyTier: 'PLATINUM',
        lastStateChangedAt: NOW,
      },
    });
    ticketId = ticket.ticketId;
  });

  afterAll(async () => {
    await prisma.auditLog.deleteMany({ where: { entityType: 'company_tier_overrides', entityId: { in: [expiredOverrideId.toString(), stillActiveOverrideId.toString()] } } });
    await prisma.ticketEvent.deleteMany({ where: { ticketId } });
    await prisma.ticket.deleteMany({ where: { ticketId } });
    await prisma.failureCycle.deleteMany({ where: { deviceId } });
    await prisma.device.deleteMany({ where: { deviceId } });
    await prisma.companyTierOverride.deleteMany({ where: { companyId } });
    await prisma.plant.deleteMany({ where: { plantId } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId } });
    await prisma.onModuleDestroy();
  });

  it('flips the expired row to EXPIRED, audits TIER_OVERRIDE_EXPIRED (actor=system), and leaves the still-active row alone', async () => {
    const result = await service.sweepExpiredOverrides(NOW);
    expect(result.expired).toBeGreaterThanOrEqual(1);

    const expired = await prisma.companyTierOverride.findUniqueOrThrow({ where: { id: expiredOverrideId } });
    expect(expired.status).toBe('EXPIRED');

    const stillActive = await prisma.companyTierOverride.findUniqueOrThrow({ where: { id: stillActiveOverrideId } });
    expect(stillActive.status).toBe('ACTIVE');

    const audits = await prisma.auditLog.findMany({
      where: { entityType: 'company_tier_overrides', action: 'TIER_OVERRIDE_EXPIRED', entityId: expiredOverrideId.toString() },
    });
    expect(audits).toHaveLength(1);
    expect(audits[0].actorId).toBe('SYSTEM');
    expect(audits[0].actorRole).toBe('SYSTEM');
    const metadata = audits[0].metadata as Record<string, unknown>;
    expect(metadata.tier).toBe('PLATINUM');
    expect(metadata.companyId).toBe(companyId.toString());

    const noAuditForStillActive = await prisma.auditLog.findMany({
      where: { entityType: 'company_tier_overrides', action: 'TIER_OVERRIDE_EXPIRED', entityId: stillActiveOverrideId.toString() },
    });
    expect(noAuditForStillActive).toHaveLength(0);
  });

  it('AC-5 — never re-stamps an existing ticket: company_tier stays PLATINUM after the override lifecycle event', async () => {
    await service.sweepExpiredOverrides(NOW);
    const ticket = await prisma.ticket.findUniqueOrThrow({ where: { ticketId } });
    expect(ticket.companyTier).toBe('PLATINUM');
  });

  it('is idempotent — a second sweep at the same instant finds nothing new to expire', async () => {
    await service.sweepExpiredOverrides(NOW);
    const result = await service.sweepExpiredOverrides(NOW);
    expect(result.expired).toBe(0);
  });
});
