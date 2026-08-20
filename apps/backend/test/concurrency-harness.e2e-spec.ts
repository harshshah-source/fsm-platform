import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { createBarrier, expectExactlyOneWinner, raceTwice, raceTwiceUnbarriered } from './support/concurrency';

/**
 * #107 AC-4 — the concurrency-test scaffolding, tested. Two jobs:
 *
 *  1. Prove the harness's central claim — that a barrier makes overlap a property of the test rather
 *     than of luck — by demonstrating the failure mode it removes. A helper nobody has shown to be
 *     better than the pattern it replaces is just more code.
 *  2. Exercise it end-to-end against real Postgres on a real contended write, so #100/#101 have a
 *     worked example rather than a docstring.
 */
describe('#107 — concurrency-test scaffolding', () => {
  describe('the barrier', () => {
    it('holds both parties until both arrive — neither proceeds alone', async () => {
      const { arrive } = createBarrier(2);
      const order: string[] = [];

      const first = (async () => {
        order.push('a:before');
        await arrive();
        order.push('a:after');
      })();

      // Give `first` every opportunity to run past the barrier on its own. If the barrier were a no-op
      // this settles the microtask queue and `a:after` lands here — which is exactly the assertion.
      await new Promise((r) => setTimeout(r, 20));
      expect(order).toEqual(['a:before']);

      const second = (async () => {
        order.push('b:before');
        await arrive();
        order.push('b:after');
      })();

      await Promise.all([first, second]);
      // Both crossed only after both had arrived: the two `:before`s precede both `:after`s.
      expect(order.slice(0, 2).sort()).toEqual(['a:before', 'b:before']);
      expect(order.slice(2).sort()).toEqual(['a:after', 'b:after']);
    });

    it('THE POINT: an unbarriered race cannot even produce the lost update a barriered one finds', async () => {
      // A read-modify-write with no await between the read and the write. In JavaScript that span is
      // atomic, so with `Promise.all` the first call completes it before the second is ever entered:
      // the interleaving that loses an update is UNREACHABLE, and a test asserting 'no lost update'
      // passes without ever having tried the case it claims to cover. That is the trap.
      let counter = 0;
      await raceTwiceUnbarriered(async () => {
        const seen = counter;
        counter = seen + 1;
        await Promise.resolve();
      });
      expect(counter).toBe(2); // both increments landed — no race was ever run

      // Same code, with the barrier where a real read-then-write would straddle an await. Both calls
      // now hold the same stale read, and the lost update appears every time.
      let raced = 0;
      await raceTwice(async (arrive) => {
        const seen = raced;
        await arrive(); // both parties are here, both holding the same value
        raced = seen + 1;
      });
      expect(raced).toBe(1); // one increment lost — deterministically, not occasionally
    });
    it('a party that throws before arriving releases its partner instead of hanging it', async () => {
      // Neither party reaches `arrive()`; without the release in raceTwice's catch the surviving
      // partner would await a barrier nobody will ever open, and the spec would hang rather than fail.
      const results = await raceTwice(async () => {
        throw new Error('died before the barrier');
      });
      expect(results.every((r) => !r.ok)).toBe(true);
    });
  });

  describe('expectExactlyOneWinner', () => {
    it('accepts one winner and one clean no-op, whichever way round they land', () => {
      const a = expectExactlyOneWinner<{ n: number }>(
        [
          { ok: true, value: { n: 1 } },
          { ok: true, value: { n: 0 } },
        ],
        (v) => v.n > 0,
      );
      expect(a.winner.n).toBe(1);
      const b = expectExactlyOneWinner<{ n: number }>(
        [
          { ok: true, value: { n: 0 } },
          { ok: true, value: { n: 1 } },
        ],
        (v) => v.n > 0,
      );
      expect(b.winner.n).toBe(1);
    });

    it('accepts one winner and one rejection — a guarded write refusing is a legal outcome', () => {
      const r = expectExactlyOneWinner<{ n: number }>(
        [
          { ok: true, value: { n: 1 } },
          { ok: false, error: new Error('unique violation') },
        ],
        (v) => v.n > 0,
      );
      expect(r.winner.n).toBe(1);
      expect(r.loser.ok).toBe(false);
    });

    it('rejects two winners — the double-write this whole harness exists to catch', () => {
      expect(() =>
        expectExactlyOneWinner<{ n: number }>(
          [
            { ok: true, value: { n: 1 } },
            { ok: true, value: { n: 1 } },
          ],
          (v) => v.n > 0,
        ),
      ).toThrow(/expected exactly one winner, got 2/);
    });

    it('rejects zero winners — both refusing means the work never happened', () => {
      expect(() =>
        expectExactlyOneWinner<{ n: number }>(
          [
            { ok: false, error: new Error('a') },
            { ok: false, error: new Error('b') },
          ],
          () => true,
        ),
      ).toThrow(/expected exactly one winner, got 0/);
    });
  });

  describe('worked example — a barriered double-invoke against real Postgres', () => {
    let prisma: PrismaService;
    const NS = Date.now();
    let zoneId: bigint;

    beforeAll(async () => {
      prisma = new PrismaService();
      await prisma.onModuleInit();
      zoneId = (await prisma.zone.create({ data: { name: `Z-conc-${NS}` } })).zoneId;
    });

    afterAll(async () => {
      await prisma.zone.deleteMany({ where: { zoneId } });
      await prisma.onModuleDestroy();
    });

    /**
     * The shape #100/#101 consume: two callers race to claim the same row, both provably inside the
     * critical section, and the invariant is asserted without caring who won. The claim is a
     * conditional UPDATE — the same "guard in the WHERE clause" idiom `OverrideService` and #242's
     * closure use (`removed_at IS NULL`), which is what makes the loser's update affect zero rows
     * instead of overwriting the winner.
     */
    it('two barriered claims on one row → exactly one winner, no lost update', async () => {
      const plant = await prisma.plant.create({ data: { name: `P-conc-${NS}`, zoneId } });
      try {
        const claim = async (claimant: string): Promise<{ claimed: number }> => {
          const { count } = await prisma.plant.updateMany({
            // The guard: only an unclaimed row matches, so the second UPDATE matches nothing.
            where: { plantId: plant.plantId, sourcePlantId: null },
            data: { sourcePlantId: BigInt(`${9_900_000_000_000}`) + BigInt(claimant.length) },
          });
          return { claimed: count };
        };

        const results = await raceTwice(async (arrive) => {
          const who = randomUUID();
          await arrive(); // both callers are here before either issues its UPDATE
          return claim(who);
        });

        const { loser } = expectExactlyOneWinner(results, (v) => v.claimed === 1);
        expect(loser.ok && loser.value.claimed).toBe(0); // a clean no-op, not an error and not a second write

        const after = await prisma.plant.findUniqueOrThrow({ where: { plantId: plant.plantId } });
        expect(after.sourcePlantId).not.toBeNull();
      } finally {
        await prisma.plant.deleteMany({ where: { plantId: plant.plantId } });
      }
    });
  });
});
