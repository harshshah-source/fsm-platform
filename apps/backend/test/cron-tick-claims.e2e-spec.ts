import { CRON_TICK_CLAIM_RETENTION_DAYS, tickWindowStart } from '../src/scheduling/cron-tick-claim';
import { CronTickClaimService } from '../src/scheduling/cron-tick-claim.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { expectExactlyOneWinner, raceTwiceUnbarriered } from './support/concurrency';

/**
 * #263 — the claim itself, asserted across **two independently constructed services over two separate
 * `PrismaService` connection pools**, following the #259 pattern. A test that drove one singleton
 * twice would prove nothing: the guards this replaces are exactly the ones that only work in one
 * process, so "another process" has to be staged, not simulated.
 */
const NS = Date.now();
const JOB = `spec-job-${NS}`;

describe('#263 — DB-side cron tick claims (e2e)', () => {
  let prismaA: PrismaService;
  let prismaB: PrismaService;
  let claimsA: CronTickClaimService;
  let claimsB: CronTickClaimService;

  beforeAll(async () => {
    prismaA = new PrismaService();
    await prismaA.onModuleInit();
    prismaB = new PrismaService();
    await prismaB.onModuleInit();
    claimsA = new CronTickClaimService(prismaA);
    claimsB = new CronTickClaimService(prismaB);
  });

  afterAll(async () => {
    await prismaA.cronTickClaim.deleteMany({ where: { jobName: { startsWith: 'spec-job-' } } });
    await prismaA.onModuleDestroy();
    await prismaB.onModuleDestroy();
  });

  afterEach(async () => {
    await prismaA.cronTickClaim.deleteMany({ where: { jobName: { startsWith: 'spec-job-' } } });
  });

  it('grants the window to the first asker and refuses the second, naming the holder', async () => {
    const firedAt = new Date('2026-08-23T05:00:12.000Z');

    const first = await claimsA.claimTick(JOB, firedAt);
    // A second instance's clock is never the same millisecond — that is the whole reason the claim is
    // taken on a window rather than on the instant.
    const second = await claimsB.claimTick(JOB, new Date('2026-08-23T05:00:47.913Z'));

    expect(first).toEqual({ claimed: true });
    expect(second.claimed).toBe(false);
    if (second.claimed) throw new Error('unreachable');
    expect(second.heldBy).toMatch(/@/);
    expect(second.heldBy.length).toBeGreaterThan(0);
  });

  it('writes exactly one row per (job, window), stamped with the claimant', async () => {
    const firedAt = new Date('2026-08-23T05:00:12.000Z');
    await claimsA.claimTick(JOB, firedAt);
    await claimsB.claimTick(JOB, new Date('2026-08-23T05:00:47.913Z'));

    const rows = await prismaA.cronTickClaim.findMany({ where: { jobName: JOB } });
    expect(rows).toHaveLength(1);
    expect(rows[0].windowStart.toISOString()).toBe(tickWindowStart(firedAt).toISOString());
    expect(rows[0].claimedBy).toContain('@');
    expect(rows[0].claimedAt).toBeInstanceOf(Date);
  });

  it('grants the NEXT window to whoever asks — a lost window is not a lost job', async () => {
    await claimsA.claimTick(JOB, new Date('2026-08-23T05:00:12.000Z'));
    expect(await claimsB.claimTick(JOB, new Date('2026-08-23T05:01:03.000Z'))).toEqual({ claimed: true });
  });

  it('scopes the claim to the job — two jobs in the same minute both run', async () => {
    const firedAt = new Date('2026-08-23T05:00:12.000Z');
    expect(await claimsA.claimTick(`${JOB}-a`, firedAt)).toEqual({ claimed: true });
    expect(await claimsB.claimTick(`${JOB}-b`, firedAt)).toEqual({ claimed: true });
  });

  it('has exactly one winner under a genuine two-pool race for the same window', async () => {
    const firedAt = new Date('2026-08-23T05:00:12.000Z');
    let flip = false;
    const results = await raceTwiceUnbarriered(async () => {
      const svc = (flip = !flip) ? claimsA : claimsB;
      return svc.claimTick(JOB, firedAt);
    });

    expectExactlyOneWinner(results, (c) => c.claimed);
    expect(await prismaA.cronTickClaim.count({ where: { jobName: JOB } })).toBe(1);
  });

  describe('retention', () => {
    it('deletes claims older than the horizon and keeps everything inside it', async () => {
      const now = new Date('2026-08-23T05:00:00.000Z');
      const day = 24 * 60 * 60 * 1000;
      const old = new Date(now.getTime() - (CRON_TICK_CLAIM_RETENTION_DAYS + 1) * day);
      const recent = new Date(now.getTime() - day);

      await claimsA.claimTick(JOB, old);
      await claimsA.claimTick(JOB, recent);
      await claimsA.claimTick(JOB, now);

      const pruned = await claimsA.pruneExpiredClaims(now);

      expect(pruned).toBe(1);
      const left = await prismaA.cronTickClaim.findMany({ where: { jobName: JOB }, orderBy: { windowStart: 'asc' } });
      expect(left.map((r) => r.windowStart.toISOString())).toEqual([
        tickWindowStart(recent).toISOString(),
        tickWindowStart(now).toISOString(),
      ]);
    });

    it('re-grants a window whose claim has been pruned — the table is a diagnosis log, not a ledger', async () => {
      const now = new Date('2026-08-23T05:00:00.000Z');
      const old = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

      await claimsA.claimTick(JOB, old);
      await claimsA.pruneExpiredClaims(now);

      expect(await claimsB.claimTick(JOB, old)).toEqual({ claimed: true });
    });
  });
});
