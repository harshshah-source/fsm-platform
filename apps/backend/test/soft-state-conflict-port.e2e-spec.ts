import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { SeCoverageService } from '../src/shared-pool/se-coverage.service';
import { SoftStateService } from '../src/soft-state/soft-state.service';
import { PrismaSoftStateConflictPort } from '../src/soft-state/soft-state-conflict.adapter';

/**
 * Issue 15, slice 8 — the real SoftStateConflictPort adapter (AC#7). Replaces the 13a no-conflict seam:
 * reports which of the given tickets currently carry an active ON_SITE / TROUBLESHOOT_STARTED soft
 * state, so a ZM override that touches one surfaces a conflict warning. VIEWED and resolved states do
 * not count as a conflict.
 */
const NS = Date.now();
const NOW = new Date('2026-06-23T11:00:00Z');

describe('Issue 15 slice 8 — PrismaSoftStateConflictPort', () => {
  let prisma: PrismaService;
  let svc: SoftStateService;
  let port: PrismaSoftStateConflictPort;

  let zoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;
  let se: string;
  const deviceIds: string[] = [];
  const ticketIds: string[] = [];

  const makeTicket = async (): Promise<string> => {
    const deviceId = String(11_200_000_000 + (NS % 100_000) * 10 + deviceIds.length);
    deviceIds.push(deviceId);
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
        companyTier: 'GOLD',
        lastStateChangedAt: NOW,
      },
    });
    ticketIds.push(ticket.ticketId);
    return ticket.ticketId;
  };

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    svc = new SoftStateService(prisma, new SeCoverageService(prisma));
    port = new PrismaSoftStateConflictPort(prisma);

    zoneId = (await prisma.zone.create({ data: { name: 'Z-cp-' + NS } })).zoneId;
    companyId = (
      await prisma.company.create({ data: { name: 'Co-cp-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })
    ).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'P-cp-' + NS, zoneId } })).plantId;

    const tag = randomUUID().slice(0, 8);
    const u = await prisma.user.create({
      data: { name: 'SE ' + tag, role: 'SERVICE_ENGINEER', phone: 'ph-' + tag, email: `${tag}@cp.test`, zoneId },
    });
    se = u.userId;
    await prisma.engineerMaster.create({ data: { engineerId: se, coverageType: 'DEDICATED', zoneId, dailyCapacity: 10 } });
    await prisma.seCoverage.create({ data: { seId: se, plantId, coverageType: 'DEDICATED' } });
  });

  afterAll(async () => {
    await prisma.seCoverage.deleteMany({ where: { seId: se } });
    await prisma.softState.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.ticket.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.failureCycle.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.engineerMaster.deleteMany({ where: { engineerId: se } });
    await prisma.user.deleteMany({ where: { userId: se } });
    await prisma.plant.deleteMany({ where: { plantId } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId } });
    await prisma.onModuleDestroy();
  });

  it('reports only tickets with an active ON_SITE or TROUBLESHOOT_STARTED soft state', async () => {
    const onSite = await makeTicket();
    await svc.advance({ ticketId: onSite, seId: se, target: 'VIEWED', now: NOW });
    await svc.advance({ ticketId: onSite, seId: se, target: 'ON_SITE', now: NOW });

    const busy = await makeTicket();
    await svc.advance({ ticketId: busy, seId: se, target: 'VIEWED', now: NOW });
    await svc.advance({ ticketId: busy, seId: se, target: 'ON_SITE', now: NOW });
    await svc.advance({ ticketId: busy, seId: se, target: 'TROUBLESHOOT_STARTED', now: NOW });

    const viewedOnly = await makeTicket();
    await svc.advance({ ticketId: viewedOnly, seId: se, target: 'VIEWED', now: NOW });

    const resolved = await makeTicket();
    await svc.advance({ ticketId: resolved, seId: se, target: 'VIEWED', now: NOW });
    await svc.advance({ ticketId: resolved, seId: se, target: 'ON_SITE', now: NOW });
    await prisma.softState.updateMany({
      where: { ticketId: resolved, resolvedAt: null },
      data: { resolvedAt: NOW, resolvedBy: 'ZM', resolutionReason: 'OVERRIDE' },
    });

    const result = await port.activeOnSiteTicketIds([onSite, busy, viewedOnly, resolved]);
    expect(result.has(onSite)).toBe(true);
    expect(result.has(busy)).toBe(true);
    expect(result.has(viewedOnly)).toBe(false);
    expect(result.has(resolved)).toBe(false);
    expect(result.size).toBe(2);
  });

  it('returns an empty set for an empty ticket list', async () => {
    expect((await port.activeOnSiteTicketIds([])).size).toBe(0);
  });

  /**
   * #295 — the **narrower** read the dispatch board needs, and the reason it could not reuse the one
   * above. `activeOnSiteTicketIds` deliberately unions ON_SITE with TROUBLESHOOT_STARTED, because an
   * override that disturbs an engineer standing at the plant is a conflict either way.
   *
   * A green card is a different claim: *somebody has started the work*. An engineer who has arrived
   * and not yet begun has not, and painting their ticket green would tell the dispatcher the one
   * thing they most need to be told correctly. So the board asks for TROUBLESHOOT_STARTED alone.
   */
  it('#295 — troubleshooting-started is ON_SITE’s narrower sibling, not the same question', async () => {
    const arrivedOnly = await makeTicket();
    await svc.advance({ ticketId: arrivedOnly, seId: se, target: 'VIEWED', now: NOW });
    await svc.advance({ ticketId: arrivedOnly, seId: se, target: 'ON_SITE', now: NOW });

    const working = await makeTicket();
    await svc.advance({ ticketId: working, seId: se, target: 'VIEWED', now: NOW });
    await svc.advance({ ticketId: working, seId: se, target: 'ON_SITE', now: NOW });
    await svc.advance({ ticketId: working, seId: se, target: 'TROUBLESHOOT_STARTED', now: NOW });

    const finished = await makeTicket();
    await svc.advance({ ticketId: finished, seId: se, target: 'VIEWED', now: NOW });
    await svc.advance({ ticketId: finished, seId: se, target: 'ON_SITE', now: NOW });
    await svc.advance({ ticketId: finished, seId: se, target: 'TROUBLESHOOT_STARTED', now: NOW });
    await prisma.softState.updateMany({
      where: { ticketId: finished, resolvedAt: null },
      data: { resolvedAt: NOW, resolvedBy: 'ZM', resolutionReason: 'OVERRIDE' },
    });

    const started = await port.activeTroubleshootStartedTicketIds([arrivedOnly, working, finished]);
    expect(started.has(working)).toBe(true);
    // On site, not started. The one distinction this method exists for.
    expect(started.has(arrivedOnly)).toBe(false);
    expect(started.has(finished)).toBe(false);
    expect(started.size).toBe(1);

    // …and the conflict read still answers its own, wider question about the same three tickets.
    const conflicting = await port.activeOnSiteTicketIds([arrivedOnly, working, finished]);
    expect(conflicting.has(arrivedOnly)).toBe(true);
    expect(conflicting.has(working)).toBe(true);
  });

  /**
   * The empty-list guard, which is not defensive boilerplate here: a zone with no committed work
   * calls this with `[]` on every Console load, and the sibling method's missing guard is exactly
   * what produced a live 500 on 2026-09-01 (`TypeError: Cannot read properties of undefined`).
   */
  it('#295 — returns an empty set for an empty ticket list, without touching the database', async () => {
    expect((await port.activeTroubleshootStartedTicketIds([])).size).toBe(0);
  });
});
