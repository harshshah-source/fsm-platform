/**
 * Book8 test-environment DRIVER + VALIDATION (isolated, opt-in).
 *
 * Runs ONLY when BOOK8_RUN=1, so it never slows or pollutes the normal test suite. It drives the
 * REAL production pipeline against data/Book8_fixed.csv through the SOURCE_READER seam:
 *
 *     seed master  →  ingest (Book8SourceReader → SnapshotIngestionWorker)  →  DeviceStateService
 *                  →  TicketCreationService  →  referential-integrity assertions  →  printed report
 *
 * Nothing below the SourceReader is altered — the worker, device-state, and ticket-creation services
 * are the production classes (see book8-core.ts), composed manually like test/snapshot-worker.e2e-spec.ts.
 *
 *   Run:  BOOK8_RUN=1 node node_modules/vitest/vitest.mjs run test/env/book8/book8-env.e2e-spec.ts
 */
import { PrismaService } from '../../../src/prisma/prisma.service';
import { runBook8Core } from './book8-core';

const RUN = process.env.BOOK8_RUN === '1';
const TIMEOUT = 30 * 60 * 1000; // the full 34k-row dataset; generous so the real pipeline can finish.

const INACTIVE_BUCKETS = ['CRITICAL', 'HIGH_CRITICAL', 'SEVERE', 'VERY_SEVERE', 'LONG_PENDING'];

describe.runIf(RUN)('Book8 isolated test environment', () => {
  let prisma: PrismaService;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
  }, TIMEOUT);

  afterAll(async () => {
    await prisma.onModuleDestroy();
  });

  it(
    'seeds master data, ingests Book8 telemetry, and produces tickets with full referential integrity',
    async () => {
      const lines: string[] = [];
      const log = (s = ''): void => void lines.push(s);

      const { ds, idSet, seed, ingest, recompute, ticketsCreated } = await runBook8Core(prisma);

      // Scope all metrics to OUR devices (other tests may leave a handful behind).
      const states = (
        await prisma.deviceState.findMany({
          select: {
            deviceId: true,
            slaBucket: true,
            isInactive: true,
            eligibleForUptime: true,
            plantId: true,
            companyId: true,
            latestGpsDatetime: true,
          },
        })
      ).filter((s) => idSet.has(s.deviceId.toString()));

      const bucketDist: Record<string, number> = {};
      for (const s of states) {
        const b = s.slaBucket ?? (s.latestGpsDatetime ? 'ACTIVE' : 'NO_GPS');
        bucketDist[b] = (bucketDist[b] ?? 0) + 1;
      }
      const inactive = states.filter((s) => s.isInactive);
      const eligible = states.filter((s) => s.eligibleForUptime);
      // The invariant ticketable set: inactive ∧ eligible ∧ fitted. Independent of has_open_failure_cycle,
      // so the count holds on the first run AND on every idempotent re-run.
      const ticketable = states.filter(
        (s) => s.isInactive && s.eligibleForUptime && s.plantId !== null && s.companyId !== null,
      );

      const ourTickets = (
        await prisma.ticket.findMany({
          where: { workType: 'TROUBLESHOOT' },
          select: { deviceId: true, companyTier: true, status: true },
        })
      ).filter((t) => idSet.has(t.deviceId.toString()));

      const ticketTierDist: Record<string, number> = {};
      for (const t of ourTickets) ticketTierDist[t.companyTier] = (ticketTierDist[t.companyTier] ?? 0) + 1;

      // ── Referential-integrity assertions (FAIL the run if violated) ───────────────────────────
      expect(seed.vehicles).toBe(ds.usable.length);
      expect(states.length).toBe(ds.usable.length);
      expect(states.every((s) => s.plantId !== null && s.companyId !== null)).toBe(true);
      // Open TROUBLESHOOT tickets for our set == ticketable count — true on first run AND every re-run.
      expect(ourTickets.length).toBe(ticketable.length);
      expect(ticketable.length).toBeGreaterThan(0);
      expect((bucketDist['CRITICAL'] ?? 0) + (bucketDist['HIGH_CRITICAL'] ?? 0)).toBeGreaterThan(0);
      // No ticket exists for an ineligible (no-PGI) device id ending in 0.
      expect(ourTickets.every((t) => t.deviceId % 10n !== 0n)).toBe(true);

      // ── Report ─────────────────────────────────────────────────────────────────────────────────
      const c = ds.classification;
      log('');
      log('══════════════════════════════════════════════════════════════════════');
      log('  BOOK8 ISOLATED TEST ENVIRONMENT — RUN REPORT');
      log('══════════════════════════════════════════════════════════════════════');
      log(`  Dataset NOW (injected clock) : ${ds.datasetNow.toISOString()}`);
      log('');
      log('  ── CSV ingestion / classification ──────────────────────────────────');
      log(`  Total CSV data rows          : ${c.totalRows}`);
      log(`  Usable (seeded as devices)   : ${c.usableCount}  (with GPS ${c.withGps} / without ${c.withoutGps})`);
      log(`  Skipped rows (with reasons):`);
      for (const [r, n] of Object.entries(c.skipped)) {
        log(`    • ${r.padEnd(20)} : ${n}   e.g. ${ds.skippedSamples[r as keyof typeof ds.skippedSamples].join(', ')}`);
      }
      log('');
      log('  ── Master records created ──────────────────────────────────────────');
      log(`  Zones / Companies / Plants   : ${seed.zones} / ${seed.companies} / ${seed.plants}`);
      log(`  Vehicles / Devices           : ${seed.vehicles} / ${seed.devices}`);
      log(`  PGI history rows (synthetic) : ${seed.pgiRows}  (eligible ${c.pgiEligibleCount} / ineligible ${c.pgiIneligibleCount})`);
      log('');
      log('  ── Snapshot ingestion ──────────────────────────────────────────────');
      log(`  Run status / chunks / inserted : ${ingest.status} / ${ingest.chunks} / ${ingest.inserted}`);
      log('');
      log('  ── Device state ────────────────────────────────────────────────────');
      log(`  device_states upserted (all) : ${recompute.upserted}`);
      log(`  SLA bucket distribution (Book8 devices):`);
      for (const b of ['ACTIVE', 'WARNING', 'EARLY_RISK', 'RISK', ...INACTIVE_BUCKETS, 'NO_GPS']) {
        if (bucketDist[b]) log(`    • ${b.padEnd(14)} : ${bucketDist[b]}`);
      }
      log(`  Inactive / Eligible / Ticketable : ${inactive.length} / ${eligible.length} / ${ticketable.length}`);
      log('');
      log('  ── Ticket generation ───────────────────────────────────────────────');
      log(`  Tickets created this run     : ${ticketsCreated}`);
      log(`  TROUBLESHOOT tickets (Book8) : ${ourTickets.length}   by tier ${JSON.stringify(ticketTierDist)}`);
      log(`  NOT generated — ineligible (no recent PGI) : ${states.filter((s) => s.isInactive && !s.eligibleForUptime).length}`);
      log(`  NOT generated — active (<24h)              : ${states.filter((s) => !s.isInactive).length}`);
      log('');
      log('  ── Workflows blocked by future / unimplemented issues ──────────────');
      log('    • Intra-day CRITICAL insert (29/30/32), Install (33/34), Reports (38–44),');
      log('      mobile app (54–61) — not built; not exercised by this environment.');
      log('══════════════════════════════════════════════════════════════════════');

      // eslint-disable-next-line no-console
      console.log(lines.join('\n'));
    },
    TIMEOUT,
  );
});
