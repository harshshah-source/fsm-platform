import { transitionOrConflict, type UpdateManyDelegate } from '../src/common/transition-or-conflict';

/**
 * Issue 101 — the shared guarded-transition primitive. Pure unit tests over a fake delegate: the helper
 * is exactly a guarded `updateMany` whose row-count decides the winner. The real state guard lives in the
 * caller's `where` (asserted here is that the helper forwards it verbatim and reports win/loss from count).
 */
describe('transitionOrConflict', () => {
  const fake = (count: number): UpdateManyDelegate<unknown, unknown> & { calls: unknown[] } => {
    const calls: unknown[] = [];
    return { calls, updateMany: async (args) => (calls.push(args), { count }) };
  };

  it('reports won when the guarded update hits exactly one row', async () => {
    const d = fake(1);
    const r = await transitionOrConflict(d, { id: 1, status: { in: ['PENDING'] } }, { status: 'ACCEPTED' });
    expect(r).toEqual({ won: true, count: 1 });
  });

  it('reports a CONFLICT (won:false) when the guard matched zero rows — a loser of the race', async () => {
    const d = fake(0);
    const r = await transitionOrConflict(d, { id: 1, status: { in: ['PENDING'] } }, { status: 'ACCEPTED' });
    expect(r).toEqual({ won: false, count: 0 });
  });

  it('forwards where + data to updateMany verbatim (the guard is the caller\'s responsibility)', async () => {
    const d = fake(1);
    const where = { id: 7, status: { in: ['PENDING_ACCEPTANCE'] }, offeredSeId: 'se-a', retryCount: 2 };
    const data = { status: 'ESCALATION_REQUIRED', respondedAt: new Date(0) };
    await transitionOrConflict(d, where, data);
    expect(d.calls[0]).toEqual({ where, data });
  });

  it('treats count>1 as won (caller under-specified the id — still a win, but a caller bug)', async () => {
    const d = fake(3);
    const r = await transitionOrConflict(d, { status: { in: ['PENDING'] } }, { status: 'X' });
    expect(r.won).toBe(true);
    expect(r.count).toBe(3);
  });
});
