import { isDeadlock } from '../../src/common/lost-race';
import type { PrismaService } from '../../src/prisma/prisma.service';

/**
 * Driving an interleaving explicitly, rather than starting two calls and hoping.
 *
 * A deadlock is a property of *order in time*, so a spec that asserts one cannot happen has to place
 * each party's statements against the other's. These helpers were written for #327
 * (`assignment-write-path-ordering.e2e-spec.ts`) and are shared from here for #334, which stages the
 * same shape across two more writers — the dispatch run and the two-schedule movers.
 *
 * The pattern every case follows: a hook fires after a named statement inside a transaction, opens a
 * gate for the other party, and waits on the other party's gate **with a timeout**. The timeout is not
 * defensive padding — it is the assertion path. Once the ordering is correct the awaited statement is
 * unreachable until this transaction commits, so a plain rendezvous would hang; bounding the wait is
 * what lets one spec express both the defect and its absence.
 */

/** A one-shot gate: `open()` releases everyone awaiting `wait`. */
export interface Gate {
  wait: Promise<void>;
  open: () => void;
}

export const gate = (): Gate => {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => (open = resolve));
  return { wait, open };
};

/**
 * Wait for the other party, but not for ever. Post-fix the awaited statement is unreachable until this
 * transaction commits, so the timeout **is** the assertion path: it releases us, we commit, and the
 * blocked party then proceeds correctly.
 */
export const waitAtMost = async (g: Gate, ms: number): Promise<void> => {
  let timer: NodeJS.Timeout;
  await Promise.race([g.wait, new Promise<void>((resolve) => (timer = setTimeout(resolve, ms)))]);
  clearTimeout(timer!);
};

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Every statement a transaction runs, as `delegate.method` (or `$queryRaw` for the raw helpers). */
export type TxCall = (path: string, args: unknown[], run: () => Promise<unknown>) => Promise<unknown>;

/**
 * A PrismaService whose interactive transactions report — and can be paused around — every statement
 * they run. Same shape as `dispatch-manual-collision-retry`'s wrapper, generalised from one delegate
 * method to all of them, because the ordering under test spans four tables.
 */
export function hookedPrisma(prisma: PrismaService, onCall: TxCall): PrismaService {
  const wrapTx = (tx: object): object =>
    new Proxy(tx, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (typeof prop !== 'string') return value;
        if (typeof value === 'function') {
          return (...args: unknown[]) =>
            onCall(prop, args, () => (value as (...a: unknown[]) => Promise<unknown>).apply(target, args));
        }
        if (value === null || typeof value !== 'object' || prop.startsWith('$') || prop.startsWith('_')) return value;
        return new Proxy(value as object, {
          get(delegate, method) {
            const fn = Reflect.get(delegate, method);
            if (typeof fn !== 'function' || typeof method !== 'string') return fn;
            return (...args: unknown[]) =>
              onCall(`${prop}.${method}`, args, () =>
                (fn as (...a: unknown[]) => Promise<unknown>).apply(delegate, args),
              );
          },
        });
      },
    });

  return new Proxy(prisma, {
    get(target, prop, receiver) {
      if (prop === '$transaction') {
        return (fn: unknown, ...rest: unknown[]) => {
          const real = (target as unknown as Record<string, (...a: unknown[]) => unknown>).$transaction;
          if (typeof fn !== 'function') return real.call(target, fn, ...rest);
          return real.call(target, ((tx: object) => (fn as (t: object) => unknown)(wrapTx(tx))) as never, ...rest);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as PrismaService;
}

/** The SQL a `$queryRaw` call carries, so a hook can tell one raw statement from another. */
export const rawSql = (args: unknown[]): string => {
  const strings = args[0];
  return Array.isArray(strings) ? strings.join('?') : String(strings ?? '');
};

/**
 * `SELECT ... FROM <table> ... FOR UPDATE` — the row locks the write paths take by hand, told apart
 * by the table they name. Built from a regex **literal** per table rather than one `new RegExp(table)`
 * helper: a hand-built pattern silently loses its `\s` to string escaping, and the predicate then
 * simply never matches — a spec whose gate never opens hangs on a rendezvous instead of failing.
 */
export const isRowLock =
  (from: RegExp) =>
  (path: string, args: unknown[]): boolean =>
    path === '$queryRaw' && from.test(rawSql(args)) && /FOR\s+UPDATE/i.test(rawSql(args));

export const isTicketLock = isRowLock(/FROM\s+tickets/i);
export const isScheduleLock = isRowLock(/FROM\s+work_schedules/i);

/**
 * Record the statement behind every 40P01 this client raises, and let it carry on.
 *
 * Needed because #327 **maps** a residual deadlock onto each door's ordinary conflict outcome: an
 * operation that lost to a cycle and one that lost a fair race answer the caller identically, so a
 * spec asserting "these two cannot deadlock" cannot see the difference from the outside. It has to
 * watch the statements. Wrap the case's own hook — `watchDeadlocks(hits, myHook)` — and assert `hits`
 * is empty; the recorded path names which statement closed the cycle when it is not.
 */
export const watchDeadlocks =
  (hits: string[], inner?: TxCall): TxCall =>
  async (path, args, run) => {
    try {
      return await (inner ? inner(path, args, run) : run());
    } catch (e: unknown) {
      if (isDeadlock(e)) hits.push(path);
      throw e;
    }
  };
