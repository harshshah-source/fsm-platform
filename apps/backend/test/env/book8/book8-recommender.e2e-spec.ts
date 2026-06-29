/**
 * Book8 RECOMMENDER + DAY-PLAN layer (isolated, opt-in — BOOK8_RUN=1).
 *
 * Builds on the core pipeline (seed → ingest → recompute → tickets), then seeds the SE organisation
 * and drives the PRODUCTION Recommender + Batch auto-dispatch to form SE Day Plans — composing the
 * real services manually, no HTTP. Proves Issues 09–14 are exercisable on the Book8 data.
 *
 *   Run: BOOK8_RUN=1 node node_modules/vitest/vitest.mjs run test/env/book8/book8-recommender.e2e-spec.ts \
 *          --testTimeout=1800000 --hookTimeout=1800000
 */
import { PrismaService } from '../../../src/prisma/prisma.service';
import { RecommenderService } from '../../../src/recommender/recommender.service';
import { CandidateSelectionService } from '../../../src/recommender/candidate-selection.service';
import { BatchAssignmentService } from '../../../src/scheduling/batch-assignment.service';
import { ZONE_NAMES } from './book8-dataset';
import { runBook8Core } from './book8-core';
import { seedSeOrg } from './book8-se-org';

const RUN = process.env.BOOK8_RUN === '1';
const TIMEOUT = 30 * 60 * 1000;

describe.runIf(RUN)('Book8 recommender + day-plan layer', () => {
  let prisma: PrismaService;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
  }, TIMEOUT);

  afterAll(async () => {
    await prisma.onModuleDestroy();
  });

  it(
    'seeds SE org and dispatches recommendations into SE Day Plans',
    async () => {
      const lines: string[] = [];
      const log = (s = ''): void => void lines.push(s);

      // 1) Ensure the core world (tickets) exists — idempotent, cheap on a warm DB.
      const core = await runBook8Core(prisma);
      const now = core.ds.datasetNow; // per-dataset injected clock (Book8 default, or BOOK_DATASET).

      // 2) Seed the SE organisation (managers + SEs + coverage + availability + planner).
      const seOrg = await seedSeOrg(prisma, core.ds);

      // 3) Drive the production Recommender + Batch dispatch per zone.
      const rec = new RecommenderService(prisma, new CandidateSelectionService(prisma));
      const dispatcher = new BatchAssignmentService(prisma);
      const zones = await prisma.zone.findMany({ where: { name: { in: [...ZONE_NAMES] } } });

      let recommended = 0;
      let unassignable = 0;
      let schedules = 0;
      let batches = 0;
      let dispatchedTickets = 0;
      const perZone: string[] = [];
      for (const z of zones) {
        const r = await rec.runForZone(z.zoneId, { now });
        const d = await dispatcher.dispatchForZone(z.zoneId, {
          dateFrom: now,
          dateTo: now,
          now,
        });
        recommended += r.recommended;
        unassignable += r.unassignable;
        schedules += d.schedules;
        batches += d.batches;
        dispatchedTickets += d.tickets;
        perZone.push(
          `    • ${z.name.padEnd(6)} : recommended ${r.recommended}, unassignable ${r.unassignable}, schedules ${d.schedules}, batches ${d.batches}, stops ${d.tickets}`,
        );
      }

      // Cumulative DB state (holds on first run AND idempotent re-runs).
      const recRows = await prisma.recommendation.count();
      const scheduleRows = await prisma.workSchedule.count();
      const formallyAssigned = await prisma.ticket.count({
        where: { workType: 'TROUBLESHOOT', assignmentState: 'FORMALLY_ASSIGNED' },
      });

      // ── Assertions ─────────────────────────────────────────────────────────────────────────────
      expect(seOrg.engineers).toBeGreaterThan(0);
      expect(seOrg.dedicated).toBeGreaterThan(0);
      expect(recRows).toBeGreaterThan(0);
      expect(scheduleRows).toBeGreaterThan(0);
      // Recommender produced real day-plan assignments from the Book8 tickets.
      expect(formallyAssigned).toBeGreaterThan(0);

      // ── Report ───────────────────────────────────────────────────────────────────────────────────
      log('');
      log('══════════════════════════════════════════════════════════════════════');
      log('  BOOK8 RECOMMENDER + DAY-PLAN LAYER — RUN REPORT');
      log('══════════════════════════════════════════════════════════════════════');
      log('  ── SE organisation seeded ──────────────────────────────────────────');
      log(`  Zonal Managers / Ops Head / CSM / WM : ${seOrg.zonalManagers} / ${seOrg.operationsHead} / ${seOrg.centralServiceManager} / ${seOrg.warehouseManager}`);
      log(`  Service Engineers            : ${seOrg.engineers}  (DEDICATED ${seOrg.dedicated} / MULTI_PLANT ${seOrg.multiPlant})`);
      log(`  SE coverage rows             : ${seOrg.coverageRows}`);
      log(`  ON_LEAVE (availability filter): ${seOrg.onLeave}`);
      log(`  SE Planner entries           : ${seOrg.plannerEntries}`);
      log('');
      log('  ── Recommender + dispatch (this run) ───────────────────────────────');
      log(`  Recommended / Unassignable   : ${recommended} / ${unassignable}`);
      log(`  Work schedules / batches / stops : ${schedules} / ${batches} / ${dispatchedTickets}`);
      for (const l of perZone) log(l);
      log('');
      log('  ── Cumulative DB state ─────────────────────────────────────────────');
      log(`  recommendation rows          : ${recRows}`);
      log(`  work_schedule rows           : ${scheduleRows}`);
      log(`  TROUBLESHOOT tickets FORMALLY_ASSIGNED : ${formallyAssigned}`);
      log('══════════════════════════════════════════════════════════════════════');

      // eslint-disable-next-line no-console
      console.log(lines.join('\n'));
    },
    TIMEOUT,
  );
});
