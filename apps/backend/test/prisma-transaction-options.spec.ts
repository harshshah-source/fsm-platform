import { PrismaService } from '../src/prisma/prisma.service';
import { DEFAULT_TX_MAX_WAIT_MS, DEFAULT_TX_TIMEOUT_MS, transactionOptions } from '../src/prisma/transaction-options';

/**
 * #262 item 5 — the interactive-transaction budget is a policy this repo chose, not a default nobody
 * looked at.
 *
 * Prisma's unconfigured defaults are `maxWait` 2 s and `timeout` **5 s**, and until now no
 * `transactionOptions` were set anywhere. Test fixtures are small so nothing ever hit it; a
 * production-sized zone dispatch is a single transaction doing roughly three round-trips per ticket,
 * and it aborts on the timer with a Prisma error that names nothing about the work. #262 shrinks that
 * transaction to one SE, which is the real fix — but a budget nobody chose is still a cliff, so it is
 * now stated explicitly and pinned here.
 *
 * The timeout is asserted **behaviourally**, by holding a transaction open longer than Prisma's
 * default and requiring it to survive. Reading the option back off the client would assert that a
 * field was set, which is not the same claim.
 */
describe('#262 — explicit Prisma transaction options', () => {
  let prisma: PrismaService;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
  });

  afterAll(async () => {
    await prisma.onModuleDestroy();
  });

  it('states the policy rather than inheriting it', () => {
    // 15 s: generous enough that a per-SE transaction bounded by `daily_capacity` can never approach
    // it, tight enough that a genuinely stuck transaction still surfaces as an error rather than
    // holding a pooled connection open behind the 60 s idle-in-transaction guard.
    expect(DEFAULT_TX_TIMEOUT_MS).toBe(15_000);
    // 5 s, matching `DB_POOL_ACQUIRE_TIMEOUT_MS`: both are the same question — how long a caller waits
    // for a connection before being told the server is saturated — and answering it two different ways
    // would make the backpressure signal arrive at two different times.
    expect(DEFAULT_TX_MAX_WAIT_MS).toBe(5_000);
    expect(transactionOptions()).toEqual({ maxWait: DEFAULT_TX_MAX_WAIT_MS, timeout: DEFAULT_TX_TIMEOUT_MS });
  });

  it('lets a transaction run past the 5s Prisma default it used to inherit', async () => {
    const ran = await prisma.$transaction(async (tx) => {
      // Longer than Prisma's 5 s default, comfortably inside the 15 s policy. Under the old
      // (unconfigured) client this throws P2028 "Transaction already closed".
      // Cast: `pg_sleep` returns `void`, which Prisma's raw deserializer cannot map to a column type.
      await tx.$queryRaw`SELECT pg_sleep(7)::text AS slept`;
      return true;
    });
    expect(ran).toBe(true);
  }, 30_000);
});
