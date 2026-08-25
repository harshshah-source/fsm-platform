import { PlantEligibleFloatingSeService, PLANT_ELIGIBLE_FLOATING_SE_MV, isMvStale } from '../src/org/plant-eligible-floating-se.service';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * #287 — a dispatch run can tell whether the data it is about to select from is fresh.
 *
 * `plant_eligible_floating_se` is rebuilt at 04:30 IST and consumed by the 05:00 run. The refresh
 * tick catches and logs its own failure and escalates nothing
 * (`plant-eligibility-refresh-scheduler.service.ts:91-93`), and the run performed **no** freshness
 * check — grep confirms the view's only readers were `refresh()` and `eligibleSeIdsForPlant()`.
 * `config_snapshot` did not record it either, so the run's own frozen record could not answer "what
 * was this decided against". A failed rebuild therefore produced a silently wrong FLOATING candidate
 * pool with no signal anywhere.
 */
describe('#287 — eligibility MV freshness is recorded and readable', () => {
  let prisma: PrismaService;
  let svc: PlantEligibleFloatingSeService;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    svc = new PlantEligibleFloatingSeService(prisma);
  });

  afterAll(async () => {
    await prisma.onModuleDestroy();
  });

  it('AC1 — a successful refresh records when it succeeded', async () => {
    const at = new Date('2026-06-28T04:30:00Z');
    await svc.refresh(at);

    const f = await svc.freshness();
    expect(f.viewName).toBe(PLANT_ELIGIBLE_FLOATING_SE_MV);
    expect(f.lastSuccessAt).toBe(at.toISOString());
    expect(f.lastAttemptAt).toBe(at.toISOString());
    expect(f.lastError).toBeNull();
  });

  it('AC1 — a failed refresh records the failure instead of swallowing it, and still throws', async () => {
    // The refresh's own contract is unchanged: recording an outcome must never convert a failure
    // into a success for the caller.
    const failing = new PlantEligibleFloatingSeService({
      $executeRawUnsafe: () => Promise.reject(new Error('boom')),
      mvRefreshState: prisma.mvRefreshState,
    } as unknown as PrismaService);

    await expect(failing.refresh(new Date('2026-06-29T04:30:00Z'))).rejects.toThrow('boom');

    const f = await svc.freshness();
    expect(f.lastError).toBe('boom');
    expect(f.lastAttemptAt).toBe(new Date('2026-06-29T04:30:00Z').toISOString());
    // The previous success is NOT erased by a later failure — "when did this last actually work" is
    // the question the run needs answered, and a failure does not change that answer.
    expect(f.lastSuccessAt).toBe(new Date('2026-06-28T04:30:00Z').toISOString());
  });

  it('a later success clears the error', async () => {
    const at = new Date('2026-06-30T04:30:00Z');
    await svc.refresh(at);

    const f = await svc.freshness();
    expect(f.lastSuccessAt).toBe(at.toISOString());
    expect(f.lastError).toBeNull();
  });

  it('never-refreshed counts as stale — unknown is not fresh', () => {
    // The failure mode this whole issue exists to remove: defaulting the unknown case to "fine".
    expect(
      isMvStale(
        { viewName: 'x', lastAttemptAt: null, lastSuccessAt: null, lastError: null },
        new Date('2026-06-28T00:00:00Z'),
      ),
    ).toBe(true);
  });

  it('a rebuild from before the operating day is stale; one from within it is not', () => {
    const dayStart = new Date('2026-06-28T00:00:00Z');
    const base = { viewName: 'x', lastAttemptAt: null, lastError: null };

    expect(isMvStale({ ...base, lastSuccessAt: '2026-06-27T23:59:00Z' }, dayStart)).toBe(true);
    expect(isMvStale({ ...base, lastSuccessAt: '2026-06-28T04:30:00Z' }, dayStart)).toBe(false);
  });
});
