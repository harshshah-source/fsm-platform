import { randomUUID } from 'node:crypto';
import { AuditService } from '../src/audit/audit.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { SeCoverageService } from '../src/shared-pool/se-coverage.service';
import { TroubleshootSubmissionService } from '../src/ticketing/troubleshoot-submission.service';
import { VehicleUnavailabilityService } from '../src/ticketing/vehicle-unavailability.service';

/**
 * #245 — the vehicle-unavailability report becomes the system of record for the return-date decision.
 *
 * Before this slice a ticket could carry any number of OPEN reports, and the single `expected_from`
 * column was rewritten in place by `confirmDate` with no audit row — so "the date the SE proposed"
 * survived exactly until the first manager edit. Here: one OPEN report per ticket (older ones
 * SUPERSEDED, not deleted), an immutable `proposed_from`, and two audited manager actions —
 * **approve** (authoritative date := the SE's proposal) and **override** (authoritative date := the
 * manager's, with a required reason).
 *
 * The two authority answers this pins, recorded on the issue and not re-derived here:
 *   Q1(a) — the SE's date takes effect immediately as a provisional deferral, so `expected_from`
 *           starts equal to `proposed_from` rather than waiting for a decision;
 *   Q2(a) — the latest valid in-scope managerial action supersedes **regardless of role**. There is
 *           no rank and no lock: a ZM may overwrite a CSM's decision and vice versa, and the audit
 *           trail — not a permission ladder — carries the accountability.
 */
const NS = Date.now();
const FILED = new Date('2026-06-25T12:00:00Z');
const SE_PROPOSED = new Date('2026-06-28T09:00:00Z');
const MANAGER_DATE = new Date('2026-06-30T09:00:00Z');
const LATER_DATE = new Date('2026-07-02T09:00:00Z');

describe('#245 — VU approval lifecycle: supersession, immutable proposal, audited decisions', () => {
  let prisma: PrismaService;
  let svc: VehicleUnavailabilityService;
  let submissions: TroubleshootSubmissionService;

  let zoneA: bigint;
  let zoneB: bigint;
  let companyId: bigint;
  let plantId: bigint;
  let se: string;
  let zmA: string;
  let zmB: string;
  let csm: string;
  const userIds: string[] = [];
  const deviceIds: string[] = [];
  const ticketIds: string[] = [];

  /** A fresh TROUBLESHOOT ticket in zone A — each test owns one, so supersession chains don't collide. */
  async function makeTicket(): Promise<string> {
    const deviceId = String(9_800_000_000 + deviceIds.length + (NS % 100_000));
    await prisma.device.create({ data: { deviceId } });
    deviceIds.push(deviceId);
    const cycle = await prisma.failureCycle.create({ data: { deviceId, state: 'OPEN', openedAt: FILED } });
    const ticket = await prisma.ticket.create({
      data: {
        workType: 'TROUBLESHOOT',
        status: 'OPEN',
        failureCycleId: cycle.cycleId,
        deviceId,
        plantId,
        companyId,
        companyTier: 'GOLD',
        lastStateChangedAt: FILED,
      },
    });
    ticketIds.push(ticket.ticketId);
    return ticket.ticketId;
  }

  const fileFor = (ticketId: string, expectedFrom = SE_PROPOSED) =>
    svc.fileReport(
      { ticketId, seId: se, reasonCode: 'VEHICLE_ON_TRIP', transporterContacted: false, expectedFrom },
      { userId: se, role: 'SERVICE_ENGINEER', zoneId: Number(zoneA) },
      FILED,
    );

  const row = (id: string) => prisma.vehicleUnavailabilityReport.findUniqueOrThrow({ where: { id: BigInt(id) } });

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    svc = new VehicleUnavailabilityService(prisma, new AuditService(prisma));
    submissions = new TroubleshootSubmissionService(prisma, new SeCoverageService(prisma));

    zoneA = (await prisma.zone.create({ data: { name: 'Z-vu245A-' + NS } })).zoneId;
    zoneB = (await prisma.zone.create({ data: { name: 'Z-vu245B-' + NS } })).zoneId;
    companyId = (await prisma.company.create({ data: { name: 'Co-vu245-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'P-vu245-' + NS, zoneId: zoneA } })).plantId;

    const mkUser = async (role: string, zoneId: bigint) => {
      const tag = randomUUID().slice(0, 8);
      const u = await prisma.user.create({
        data: { name: `${role} ${tag}`, role: role as never, phone: `vu245-${tag}`, email: `${tag}-${NS}@vu245.test`, zoneId },
      });
      userIds.push(u.userId);
      return u.userId;
    };
    se = await mkUser('SERVICE_ENGINEER', zoneA);
    zmA = await mkUser('ZONAL_MANAGER', zoneA);
    zmB = await mkUser('ZONAL_MANAGER', zoneB);
    csm = await mkUser('CENTRAL_SERVICE_MANAGER', zoneA);
    await prisma.engineerMaster.create({ data: { engineerId: se, coverageType: 'DEDICATED', zoneId: zoneA, dailyCapacity: 10 } });
    // The #162 coverage floor the submission path checks before it will accept the SE's form.
    await prisma.seCoverage.create({ data: { seId: se, plantId, coverageType: 'DEDICATED' } });
  });

  afterAll(async () => {
    await prisma.auditLog.deleteMany({ where: { entityType: 'vehicle_unavailability_reports', actorId: { in: userIds } } });
    await prisma.vehicleUnavailabilityReport.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.troubleshootingSubmission.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.softState.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.ticketEvent.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.auditLog.deleteMany({ where: { entityType: 'tickets', entityId: { in: ticketIds } } });
    await prisma.ticket.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.failureCycle.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.device.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.seCoverage.deleteMany({ where: { seId: se } });
    await prisma.engineerMaster.deleteMany({ where: { engineerId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.plant.deleteMany({ where: { plantId } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId: { in: [zoneA, zoneB] } } });
    await prisma.onModuleDestroy();
  });

  // AC1 + AC2 — a second absence is a second report; the first stays readable as history.
  it('AC1/AC2 — a new filing supersedes the OPEN one; proposal and authoritative date start equal', async () => {
    const ticketId = await makeTicket();

    const first = await fileFor(ticketId);
    expect(first.result).toBe('OK');
    const firstRow = await row(first.id!);
    expect(firstRow.status).toBe('OPEN');
    expect(firstRow.proposedFrom.toISOString()).toBe(SE_PROPOSED.toISOString());
    expect(firstRow.expectedFrom.toISOString()).toBe(SE_PROPOSED.toISOString());

    const second = await fileFor(ticketId, LATER_DATE);
    expect(second.result).toBe('OK');
    expect(second.id).not.toBe(first.id);

    expect((await row(first.id!)).status).toBe('SUPERSEDED');
    expect((await row(second.id!)).status).toBe('OPEN');

    // Both remain readable as the ticket's history, newest first.
    const history = await svc.historyForTicket(ticketId);
    expect(history.map((h) => h.id)).toEqual([second.id, first.id]);

    // And exactly one is live — the invariant, not just the writer's good behaviour.
    const open = await prisma.vehicleUnavailabilityReport.count({ where: { ticketId, status: 'OPEN' } });
    expect(open).toBe(1);
  });

  // AC2 + AC3 — approve is a decision, not a mutation of the field report.
  it('AC3 — approve stamps decider / role / timestamp / decision and writes an audit row', async () => {
    const ticketId = await makeTicket();
    const filed = await fileFor(ticketId);
    const decidedAt = new Date('2026-06-26T08:00:00Z');

    const out = await svc.approve(filed.id!, { userId: zmA, role: 'ZONAL_MANAGER', zoneId: Number(zoneA) }, decidedAt);
    expect(out.result).toBe('OK');

    const r = await row(filed.id!);
    expect(r.decision).toBe('APPROVED');
    expect(r.decidedBy).toBe(zmA);
    expect(r.decidedByRole).toBe('ZONAL_MANAGER');
    expect(r.decidedAt?.toISOString()).toBe(decidedAt.toISOString());
    expect(r.overrideReason).toBeNull();
    // Approving means "the SE was right" — the authoritative date is the untouched proposal.
    expect(r.expectedFrom.toISOString()).toBe(SE_PROPOSED.toISOString());
    expect(r.proposedFrom.toISOString()).toBe(SE_PROPOSED.toISOString());

    const audit = await prisma.auditLog.findFirst({
      where: { entityType: 'vehicle_unavailability_reports', entityId: filed.id!, action: 'VU_DATE_APPROVED' },
    });
    expect(audit).not.toBeNull();
    expect(audit!.actorId).toBe(zmA);
  });

  it('AC2/AC3 — override rewrites the authoritative date only, keeps the proposal, and demands a reason', async () => {
    const ticketId = await makeTicket();
    const filed = await fileFor(ticketId);

    const noReason = await svc.override(
      filed.id!,
      { expectedFrom: MANAGER_DATE, reason: '   ' },
      { userId: zmA, role: 'ZONAL_MANAGER', zoneId: Number(zoneA) },
    );
    expect(noReason.result).toBe('REASON_REQUIRED');
    expect((await row(filed.id!)).expectedFrom.toISOString()).toBe(SE_PROPOSED.toISOString());

    const out = await svc.override(
      filed.id!,
      { expectedFrom: MANAGER_DATE, reason: 'transporter confirmed the truck returns Tuesday' },
      { userId: zmA, role: 'ZONAL_MANAGER', zoneId: Number(zoneA) },
      new Date('2026-06-26T09:00:00Z'),
    );
    expect(out.result).toBe('OK');

    const r = await row(filed.id!);
    expect(r.decision).toBe('OVERRIDDEN');
    expect(r.expectedFrom.toISOString()).toBe(MANAGER_DATE.toISOString());
    // The SE's account of the field survives the manager disagreeing with it.
    expect(r.proposedFrom.toISOString()).toBe(SE_PROPOSED.toISOString());
    expect(r.overrideReason).toBe('transporter confirmed the truck returns Tuesday');

    const audit = await prisma.auditLog.findFirst({
      where: { entityType: 'vehicle_unavailability_reports', entityId: filed.id!, action: 'VU_DATE_OVERRIDDEN' },
    });
    expect(audit).not.toBeNull();
  });

  // AC4 — Q2(a): no role rank. Both directions, because a rank would only show up in one of them.
  it('AC4 — the latest valid in-scope action supersedes regardless of role, in both directions', async () => {
    const ticketId = await makeTicket();
    const filed = await fileFor(ticketId);

    await svc.approve(filed.id!, { userId: zmA, role: 'ZONAL_MANAGER', zoneId: Number(zoneA) }, new Date('2026-06-26T08:00:00Z'));
    const csmOut = await svc.override(
      filed.id!,
      { expectedFrom: MANAGER_DATE, reason: 'central desk has the transporter on the line' },
      { userId: csm, role: 'CENTRAL_SERVICE_MANAGER', zoneId: null },
      new Date('2026-06-26T09:00:00Z'),
    );
    expect(csmOut.result).toBe('OK');
    let r = await row(filed.id!);
    expect(r.decision).toBe('OVERRIDDEN');
    expect(r.decidedBy).toBe(csm);
    expect(r.expectedFrom.toISOString()).toBe(MANAGER_DATE.toISOString());

    // …and the ZM may overwrite the CSM right back. Later wins; rank decides nothing.
    const zmOut = await svc.override(
      filed.id!,
      { expectedFrom: LATER_DATE, reason: 'plant called: the yard is shut until Thursday' },
      { userId: zmA, role: 'ZONAL_MANAGER', zoneId: Number(zoneA) },
      new Date('2026-06-26T10:00:00Z'),
    );
    expect(zmOut.result).toBe('OK');
    r = await row(filed.id!);
    expect(r.decidedBy).toBe(zmA);
    expect(r.decidedByRole).toBe('ZONAL_MANAGER');
    expect(r.expectedFrom.toISOString()).toBe(LATER_DATE.toISOString());
    expect(r.overrideReason).toBe('plant called: the yard is shut until Thursday');
  });

  it('AC4 — a ZM outside the ticket\'s zone is refused; CSM is global', async () => {
    const ticketId = await makeTicket();
    const filed = await fileFor(ticketId);

    const outOfZone = await svc.approve(filed.id!, { userId: zmB, role: 'ZONAL_MANAGER', zoneId: Number(zoneB) }, FILED);
    expect(outOfZone.result).toBe('FORBIDDEN');
    expect((await row(filed.id!)).decision).toBeNull();

    const global = await svc.approve(filed.id!, { userId: csm, role: 'CENTRAL_SERVICE_MANAGER', zoneId: null }, FILED);
    expect(global.result).toBe('OK');
    expect((await row(filed.id!)).decidedBy).toBe(csm);
  });

  it('AC4 — an SE cannot decide their own report', async () => {
    const ticketId = await makeTicket();
    const filed = await fileFor(ticketId);
    const out = await svc.approve(filed.id!, { userId: se, role: 'SERVICE_ENGINEER', zoneId: Number(zoneA) }, FILED);
    expect(out.result).toBe('FORBIDDEN');
  });

  // AC5 — the SE turning up and submitting the form IS the end of the absence (Decision 16).
  it('AC5 — a troubleshooting submission resolves the ticket\'s OPEN report', async () => {
    const ticketId = await makeTicket();
    const filed = await fileFor(ticketId);
    expect((await row(filed.id!)).status).toBe('OPEN');

    const submitted = await submissions.submit({
      ticketId,
      seId: se,
      clientSubmissionId: randomUUID(),
      rootCauseCategory: 'DEVICE_HARDWARE_FAULT',
      actor: { userId: se, role: 'SERVICE_ENGINEER' },
      now: new Date('2026-06-27T07:00:00Z'),
    });
    expect(submitted.result).toBe('OK');

    const r = await row(filed.id!);
    expect(r.status).toBe('RESOLVED');
    expect(r.resolvedAt).not.toBeNull();
  });

  // AC6 — the only paths that can move the authoritative date are the two audited ones.
  it('AC6 — a decision on a report that is no longer OPEN is refused', async () => {
    const ticketId = await makeTicket();
    const filed = await fileFor(ticketId);
    await svc.resumeSla(filed.id!, { userId: zmA, role: 'ZONAL_MANAGER', zoneId: Number(zoneA) }, new Date('2026-06-26T08:00:00Z'));

    const out = await svc.approve(filed.id!, { userId: zmA, role: 'ZONAL_MANAGER', zoneId: Number(zoneA) }, FILED);
    expect(out.result).toBe('NOT_DECIDABLE');
    expect((await row(filed.id!)).decision).toBeNull();
  });

  it('AC6 — `confirmDate` no longer exists on the service', () => {
    expect((svc as unknown as Record<string, unknown>).confirmDate).toBeUndefined();
  });
});
