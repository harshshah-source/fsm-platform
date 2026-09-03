import type { $Enums } from '../src/generated/prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * #309 (CB-12) — the `work_type ⇔ status` coupling `schema.prisma` documented but no migration ever
 * created. Until `20260902120000_ticket_work_type_status_check`, the only CHECK on `tickets` was
 * TROUBLESHOOT ⇒ `failure_cycle_id NOT NULL`; nothing below application code stopped a TROUBLESHOOT
 * ticket sitting at `FITTED` or an INSTALL ticket at `RECEIVED_AT_WAREHOUSE`.
 *
 * **The map below is the issue's recorded map, and this file is what pins it to the database.** It is
 * derived from the writers, not the PRD — every entry is justified in
 * `.scratch/fsm-platform-v1/issues/309-work-type-status-invariant.md`, including the three statuses
 * (`SUBMITTED`, `FITTED`, `RECEIVED_AT_WAREHOUSE`) that only ever reach `ticket_events` and the
 * closures (`CLOSED`, `CLOSED_NON_OPERATIONAL`) that departure and deactivation write work-type-blind.
 *
 * The sweep is **exhaustive over the live `ticket_status` enum read from the database**, both ways:
 * every legal pair must insert, every other pair must be refused. That is what makes this a drift pin
 * rather than a sample — a status added by a later `ALTER TYPE` cannot slip through untested (the
 * coverage case fails), and neither the map nor the SQL can move without the other.
 */
const NS = Date.now();
const CONSTRAINT = 'tickets_work_type_status';

/** The recorded legal map. Keep `scripts/probe-work-type-status.cjs` and the migration in step. */
const LEGAL_PAIRS: Record<$Enums.WorkType, $Enums.TicketStatus[]> = {
  TROUBLESHOOT: [
    'OPEN',
    'SUBMITTED',
    'VERIFICATION_PENDING',
    'ESCALATED',
    'FAILED_VERIFICATION',
    'CLOSED_AUTO_RECOVERY',
    'CLOSED',
    'CLOSED_NON_OPERATIONAL',
  ],
  INSTALL: [
    'REQUESTED',
    'SCHEDULED',
    'ON_SITE',
    'FITTED',
    'ACTIVATED',
    'FAILED_ACTIVATION',
    'CLOSED',
    'CLOSED_NON_OPERATIONAL',
  ],
  RECOVERY: [
    'REQUESTED',
    'SCHEDULED',
    'ON_SITE',
    'COLLECTED',
    'RECEIVED_AT_WAREHOUSE',
    'FAILED_RECOVERY',
    'CLOSED',
    'CLOSED_NON_OPERATIONAL',
  ],
};

const WORK_TYPES = Object.keys(LEGAL_PAIRS) as $Enums.WorkType[];

describe('#309 — the work_type ⇔ status invariant', () => {
  let prisma: PrismaService;

  let zoneId: bigint;
  let companyId: bigint;
  let plantId: bigint;
  const deviceId = String(11_970_000_000 + (NS % 100_000));
  const ticketIds: string[] = [];
  const cycleIds: string[] = [];

  /** Every label on the live `ticket_status` enum — the sweep's universe, read from the DB itself. */
  let dbStatuses: $Enums.TicketStatus[];

  /**
   * Insert one ticket at (workType, status). TROUBLESHOOT needs a Failure Cycle to satisfy the
   * pre-existing `tickets_troubleshoot_requires_cycle` CHECK, so an illegal-pair rejection can only
   * have come from the constraint this issue adds. The cycle is minted VERIFIED: `failure_cycle_id`
   * is `@unique` on the ticket (one cycle each) and the I1 partial unique only bites on the three
   * live states, so a per-ticket historical cycle is free.
   */
  const insert = async (workType: $Enums.WorkType, status: $Enums.TicketStatus): Promise<void> => {
    let failureCycleId: string | null = null;
    if (workType === 'TROUBLESHOOT') {
      const cycle = await prisma.failureCycle.create({
        data: { deviceId, state: 'VERIFIED', openedAt: new Date(), closedAt: new Date() },
      });
      cycleIds.push(cycle.cycleId);
      failureCycleId = cycle.cycleId;
    }
    const ticket = await prisma.ticket.create({
      data: {
        workType,
        status,
        failureCycleId,
        deviceId,
        plantId,
        companyId,
        companyTier: 'GOLD',
        lastStateChangedAt: new Date(),
      },
    });
    ticketIds.push(ticket.ticketId);
  };

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();

    const rows = await prisma.$queryRaw<{ label: $Enums.TicketStatus }[]>`
      SELECT e.enumlabel::text AS label
        FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
       WHERE t.typname = 'ticket_status'
       ORDER BY e.enumsortorder`;
    dbStatuses = rows.map((r) => r.label);

    zoneId = (await prisma.zone.create({ data: { name: 'Z-309-' + NS } })).zoneId;
    companyId = (
      await prisma.company.create({ data: { name: 'Co-309-' + NS, companyTier: 'GOLD', companyPriorityRank: 'B' } })
    ).companyId;
    plantId = (await prisma.plant.create({ data: { name: 'P-309-' + NS, zoneId } })).plantId;
    await prisma.device.create({ data: { deviceId } });
  });

  afterAll(async () => {
    await prisma.ticket.deleteMany({ where: { ticketId: { in: ticketIds } } });
    await prisma.failureCycle.deleteMany({ where: { cycleId: { in: cycleIds } } });
    await prisma.device.deleteMany({ where: { deviceId } });
    await prisma.plant.deleteMany({ where: { plantId } });
    await prisma.company.deleteMany({ where: { companyId } });
    await prisma.zone.deleteMany({ where: { zoneId } });
    await prisma.onModuleDestroy();
  });

  it('AC1 — the map covers the whole live ticket_status enum (the sweep cannot go vacuous)', () => {
    const mapped = new Set(WORK_TYPES.flatMap((w) => LEGAL_PAIRS[w]));
    // A status added by a later `ALTER TYPE` with no home on any ladder would otherwise be swept as
    // "illegal for all three" — a rule nobody decided. Fail here instead, and make someone rule on it.
    expect(dbStatuses.filter((s) => !mapped.has(s))).toEqual([]);
    // …and the map must not name a status the database does not have.
    expect([...mapped].filter((s) => !dbStatuses.includes(s))).toEqual([]);
  });

  it('AC1 — no live ticket row sits outside the map', async () => {
    const violations = await prisma.$queryRaw<{ workType: string; status: string; rows: number }[]>`
      SELECT work_type::text AS "workType", status::text AS "status", COUNT(*)::int AS "rows"
        FROM tickets t
       WHERE NOT (
         (t.work_type = 'TROUBLESHOOT' AND t.status::text = ANY (${LEGAL_PAIRS.TROUBLESHOOT})) OR
         (t.work_type = 'INSTALL'      AND t.status::text = ANY (${LEGAL_PAIRS.INSTALL}))      OR
         (t.work_type = 'RECOVERY'     AND t.status::text = ANY (${LEGAL_PAIRS.RECOVERY}))
       )
       GROUP BY 1, 2 ORDER BY 1, 2`;
    expect(violations).toEqual([]);
  });

  it('AC2 — every legal pair is still insertable (the map is not too strict)', async () => {
    for (const workType of WORK_TYPES) {
      for (const status of LEGAL_PAIRS[workType]) {
        await expect(insert(workType, status), `${workType} + ${status} must be legal`).resolves.toBeUndefined();
      }
    }
  });

  it('AC2 — the database refuses every pair outside the map', async () => {
    const accepted: string[] = [];
    for (const workType of WORK_TYPES) {
      for (const status of dbStatuses) {
        if (LEGAL_PAIRS[workType].includes(status)) continue;
        try {
          await insert(workType, status);
          accepted.push(`${workType} + ${status}`);
        } catch (e) {
          // The rejection must be THIS constraint. A TROUBLESHOOT row refused by the pre-existing
          // cycle CHECK, or by a foreign key, would otherwise read as a pass.
          expect(String(e), `${workType} + ${status} rejected by the wrong rule`).toContain(CONSTRAINT);
        }
      }
    }
    expect(accepted, 'pairs the database accepted but the map calls illegal').toEqual([]);
  });
});
