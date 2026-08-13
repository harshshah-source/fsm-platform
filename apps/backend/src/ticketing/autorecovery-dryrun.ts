import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { PrismaService } from '../prisma/prisma.service';
import { AutoRecoveryService } from './auto-recovery.service';
import { groupPlanBy, parseDryRunArgs, toPlanCsv, type DryRunArgs } from './autorecovery-plan-export';

/**
 * #229 — auto-recovery DRY-RUN PREVIEW. READ-ONLY: this tool NEVER writes to the database. It exists
 * to inspect what the auto-recovery pre-check WOULD close before that pre-check is allowed to run
 * against the backlog for the first time.
 *
 *   npm run autorecovery:dryrun
 *   npm run autorecovery:dryrun -- --zone 3 --max 200 --export plan.csv
 *
 * Built on the `autoplant:departure-dryrun` (#128) precedent, and for the same reason: the criterion
 * is evaluated per ticket against `raw_device_snapshots`, and nobody has ever seen its output on real
 * data because the mechanism had no production caller until #229. **A count is not evidence** — the
 * operator gate on this issue exists because #222's `MAX()` probe and this issue's own
 * "+5 vs 11,042" finding were both cases where an aggregate hid what the rows said. So the report
 * below prints the ping-evidence distribution, not just a total.
 *
 * A CLI rather than an HTTP endpoint because the output is thousands of rows, and because the
 * departure precedent is already understood operationally.
 *
 * Flags (all optional):
 *   --zone <id>      preview one zone only, as a staged first drain would run it
 *   --max <n>        preview with a per-pass cap applied (default: uncapped — the whole backlog)
 *   --export <path>  write the full per-ticket plan to a local CSV — the only write this tool performs
 */
async function main(): Promise<void> {
  let args: DryRunArgs;
  try {
    args = parseDryRunArgs(process.argv.slice(2));
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
    return;
  }

  // A read-only diagnostic must never be blocked by the version lock it may be run to inspect
  // (#130): warnOnly evaluates the guard and WARNs on a stale build, but never writes or throws.
  const prisma = new PrismaService({ warnOnly: true });
  await prisma.onModuleInit();

  try {
    const service = new AutoRecoveryService(prisma);

    // eslint-disable-next-line no-console
    console.log(
      'Scanning open TROUBLESHOOT tickets on currently-healthy devices' +
        `${args.zoneId !== undefined ? ` in zone ${args.zoneId}` : ''}` +
        `${args.maxClosures !== undefined ? `, capped at ${args.maxClosures}` : ''} …`,
    );
    const result = await service.runAutoRecovery({ ...args, dryRun: true });
    const plan = result.plan ?? [];

    // eslint-disable-next-line no-console
    console.log('\n════════════════════ DRY-RUN RESULT (nothing written) ════════════════════');
    // eslint-disable-next-line no-console
    console.table([
      { metric: 'candidates scanned (open ticket + device healthy now)', value: result.scanned },
      { metric: 'candidates examined against ping evidence', value: result.examined },
      { metric: 'tickets that WOULD close as CLOSED_AUTO_RECOVERY', value: plan.length },
      { metric: 'per-pass cap reached?', value: result.capped ? 'YES — more remain for a later pass' : 'no' },
    ]);

    if (plan.length === 0) {
      // A typed zero, not silence (#228 R3) — "ran and found nothing" must not read like "never ran".
      // eslint-disable-next-line no-console
      console.log('\nNo qualifying tickets. Nothing would close.');
      return;
    }

    // eslint-disable-next-line no-console
    console.log('\nWould-close by zone:');
    // eslint-disable-next-line no-console
    console.table(
      groupPlanBy(plan, (r) => r.zoneId ?? '(no zone)').map(([zoneId, tickets]) => ({ zoneId, tickets })),
    );

    // eslint-disable-next-line no-console
    console.log('\nTop 25 plants by would-close count:');
    // eslint-disable-next-line no-console
    console.table(
      groupPlanBy(plan, (r) => r.plantId)
        .slice(0, 25)
        .map(([plantId, tickets]) => ({ plantId, tickets })),
    );

    // The evidence distribution — what a bare count cannot show.
    const spans = plan.map((r) => r.spanMinutes).sort((a, b) => a - b);
    const pings = plan.map((r) => r.pingCount).sort((a, b) => a - b);
    const pct = (sorted: number[], p: number): number =>
      sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
    // eslint-disable-next-line no-console
    console.log('\nRecovery evidence distribution (why each ticket qualifies):');
    // eslint-disable-next-line no-console
    console.table([
      {
        measure: 'recovery span (min)',
        min: spans[0].toFixed(1),
        p50: pct(spans, 0.5).toFixed(1),
        p95: pct(spans, 0.95).toFixed(1),
        max: spans.at(-1)!.toFixed(1),
      },
      {
        measure: 'ping count',
        min: pings[0],
        p50: pct(pings, 0.5),
        p95: pct(pings, 0.95),
        max: pings.at(-1)!,
      },
    ]);

    const oldest = plan.reduce((a, b) => (a.cycleOpenedAt <= b.cycleOpenedAt ? a : b));
    const newest = plan.reduce((a, b) => (a.cycleOpenedAt >= b.cycleOpenedAt ? a : b));
    // eslint-disable-next-line no-console
    console.log(
      `\nFailure cycles span ${oldest.cycleOpenedAt.toISOString()} … ${newest.cycleOpenedAt.toISOString()}.`,
    );

    if (args.exportPath !== undefined) {
      writeFileSync(args.exportPath, `${toPlanCsv(plan)}\n`, 'utf8');
      // eslint-disable-next-line no-console
      console.log(`\n📄 Full per-ticket plan (${plan.length} rows) → ${args.exportPath}`);
    }

    // eslint-disable-next-line no-console
    console.log(
      '\n✅ DRY RUN ONLY — nothing was written to the database.' +
        `${args.exportPath !== undefined ? ' The only write was the local CSV above.' : ''}` +
        ' Review the rows above and agree an expected count before enabling the pre-check.',
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('❌ dry-run failed:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  } finally {
    await prisma.onModuleDestroy();
  }
}

void main();
