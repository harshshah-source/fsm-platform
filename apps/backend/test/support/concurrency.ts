/**
 * #107 AC-4 — the reusable double-invoke harness that #100/#101 build their concurrency assertions on.
 *
 * ## Why `Promise.all([f(), g()])` is not enough
 *
 * The pattern already used in a handful of specs (`dispatch-concurrent`, `intraday-accept-timeout-race`)
 * is `await Promise.all([svc.run(), svc.run()])`. That starts both calls, but it does **not** make them
 * overlap where it matters. Both invocations are entered eagerly, in order, on one thread: the first
 * runs synchronously until its first `await`, and only then does the second start. Whether they are
 * still both inside the critical section when the interesting write happens is left to whatever the
 * scheduler and the connection pool happen to do — so the test proves the invariant on **one** arbitrary
 * interleaving, and a regression that only breaks a different interleaving passes.
 *
 * That is not a theoretical complaint about these specs: it is why a concurrency test that "passes"
 * tells you much less than its name suggests, and why #107 asked for a shared pattern rather than more
 * copies of the ad-hoc one.
 *
 * ## What this adds: a release barrier
 *
 * {@link raceTwice} hands each invocation an `arrive()` it must call at the point the race matters —
 * typically immediately before the write under test. Neither call proceeds past `arrive()` until
 * **both** have reached it. The overlap is then a property of the harness, not of luck:
 *
 * ```ts
 * const [a, b] = await raceTwice((arrive) => service.claim(ticketId, { onBeforeWrite: arrive }));
 * ```
 *
 * When the code under test has no injection point (the common case), pass the barrier through the
 * clock/port the service already takes, or use {@link raceTwiceUnbarriered} and say so — an honest
 * "these merely start together" is better than a barrier that claims more than it delivers.
 *
 * ## What a double-invoke test should assert
 *
 * Not "the second call threw" — that is one legal outcome of many. Assert the **invariant**: exactly
 * one winner, no duplicate row, no lost update, and *whichever* call won, the end state is the same.
 * {@link expectExactlyOneWinner} states that shape directly.
 */

/** Both halves of a race, with the barrier each must reach before the contended write. */
export type RacedCall<T> = (arrive: () => Promise<void>) => Promise<T>;

/**
 * A two-party rendezvous. The first arrival parks; the second releases both. Cheap, dependency-free,
 * and — unlike a timeout — deterministic: if one side never arrives the test hangs and fails loudly
 * rather than passing on a race that silently did not happen.
 */
export function createBarrier(parties = 2): { arrive: () => Promise<void> } {
  let arrived = 0;
  let release!: () => void;
  const open = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    arrive: async () => {
      arrived += 1;
      if (arrived >= parties) release();
      await open;
    },
  };
}

/**
 * Run two invocations that are guaranteed to be inside their critical section together.
 *
 * Rejections are captured rather than thrown: "one of them threw" is frequently the *correct*
 * behaviour of a well-guarded write (a unique violation, a 409), so the caller decides what is
 * acceptable instead of the harness deciding for them.
 */
export async function raceTwice<T>(call: RacedCall<T>): Promise<Array<{ ok: true; value: T } | { ok: false; error: unknown }>> {
  const { arrive } = createBarrier(2);
  const settle = async (): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> => {
    try {
      return { ok: true, value: await call(arrive) };
    } catch (error) {
      // A barrier party that dies before arriving would hang its partner for ever, so release first.
      void arrive();
      return { ok: false, error };
    }
  };
  return Promise.all([settle(), settle()]);
}

/**
 * The unbarriered form, for code with no injection point. Identical result shape, weaker guarantee:
 * the two calls *start* together and overlap only if the runtime obliges. Prefer {@link raceTwice};
 * when you use this, say in the test name that it is a start-together race, not a barriered one.
 */
export async function raceTwiceUnbarriered<T>(
  call: () => Promise<T>,
): Promise<Array<{ ok: true; value: T } | { ok: false; error: unknown }>> {
  const settle = async (): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> => {
    try {
      return { ok: true, value: await call() };
    } catch (error) {
      return { ok: false, error };
    }
  };
  return Promise.all([settle(), settle()]);
}

/**
 * The assertion most double-invoke tests actually want: exactly one call did the work, and the other
 * either no-opped or failed cleanly — **without** the test caring which one won, because that is the
 * part a passing run must not depend on.
 *
 * `didWork` is evaluated only for calls that resolved; a rejected call never counts as the winner.
 */
export function expectExactlyOneWinner<T>(
  results: Array<{ ok: true; value: T } | { ok: false; error: unknown }>,
  didWork: (value: T) => boolean,
): { winner: T; loser: { ok: true; value: T } | { ok: false; error: unknown } } {
  const winners = results.filter((r): r is { ok: true; value: T } => r.ok && didWork(r.value));
  if (winners.length !== 1) {
    const summary = results
      .map((r) => (r.ok ? `resolved(${JSON.stringify(r.value)})` : `rejected(${String((r as { error: unknown }).error)})`))
      .join(' | ');
    throw new Error(`expected exactly one winner, got ${winners.length}: ${summary}`);
  }
  const winner = winners[0];
  return { winner: winner.value, loser: results.find((r) => r !== winner)! };
}
