import { installFatalHandlers, type FatalHandlerDeps } from '../src/bootstrap-guard';

/**
 * **Runtime fatal handlers** — the gap that let the API die silently on 2026-08-28.
 *
 * `runWithFatalGuard` only wraps `bootstrap()`. Once `app.listen()` resolved, nothing was listening
 * for `uncaughtException` / `unhandledRejection`, so on Node 15+ a single stray rejection anywhere —
 * one of the ~20 `@Cron` sweeps, one request path — terminated the process with **no log line**, and
 * `npm run start` (bare `node dist/main.js`, no supervisor) left the port dead until someone noticed.
 *
 * These tests pin the two properties that make such a death diagnosable instead of silent, and the
 * three that stop the handler itself becoming the new failure:
 *
 * 1. **It always logs, with the stack**, before the process goes.
 * 2. **It always exits non-zero** — the lifecycle is deliberately unchanged (Node already terminated
 *    on an unhandled rejection). This makes the death *legible*, it does not make the process
 *    survive a corrupted state, which for a backend whose crons write dispatch data would be worse.
 * 3. A hanging shutdown cannot wedge it (bounded), a rejecting shutdown cannot stop it, and a second
 *    fatal arriving mid-shutdown cannot re-enter it.
 */
describe('installFatalHandlers — runtime fatal handlers', () => {
  /** A harness that captures the registered listeners instead of touching the real process. */
  function harness(over: Partial<FatalHandlerDeps> = {}) {
    const handlers: Record<string, (err: unknown) => void> = {};
    const exit = vi.fn();
    const logFatal = vi.fn();
    const closeApp = vi.fn().mockResolvedValue(undefined);
    const deps: FatalHandlerDeps = {
      on: (event, handler) => {
        handlers[event] = handler;
      },
      logFatal,
      exit,
      closeApp,
      shutdownTimeoutMs: 50,
      ...over,
    };
    installFatalHandlers(deps);
    return { handlers, exit, logFatal, closeApp };
  }

  /** The handlers are async inside (they await a bounded shutdown); let those microtasks drain. */
  const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 120));

  it('listens for both process-level fatals', () => {
    const { handlers } = harness();
    expect(Object.keys(handlers).sort()).toEqual(['uncaughtException', 'unhandledRejection']);
  });

  it('logs an uncaught exception with its stack, closes the app, and exits non-zero', async () => {
    const { handlers, exit, logFatal, closeApp } = harness();

    handlers.uncaughtException(new Error('cron sweep blew up'));
    await settle();

    expect(logFatal).toHaveBeenCalledTimes(1);
    const line = logFatal.mock.calls[0][0] as string;
    expect(line).toMatch(/Uncaught exception/i);
    expect(line).toMatch(/cron sweep blew up/);
    // The stack is the whole point — a fatal line naming no frame is what we already had.
    expect(line).toMatch(/at /);
    // Prisma/MySQL pools and any advisory lock get their release before the process goes.
    expect(closeApp).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('logs an unhandled rejection, including a non-Error reason, without throwing itself', async () => {
    const { handlers, exit, logFatal } = harness();

    // Node hands the *reason* through, which is frequently not an Error.
    handlers.unhandledRejection({ code: 'P2002', detail: 'duplicate key' });
    await settle();

    const line = logFatal.mock.calls[0][0] as string;
    expect(line).toMatch(/Unhandled promise rejection/i);
    expect(line).toMatch(/P2002/);
    // …and never the useless "[object Object]" that String() would have produced.
    expect(line).not.toMatch(/\[object Object\]/);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('still exits when the graceful shutdown hangs', async () => {
    const { handlers, exit } = harness({ closeApp: () => new Promise<void>(() => {}) });

    handlers.uncaughtException(new Error('died mid-transaction'));
    await settle();

    // A stuck `app.close()` must not turn a crash into a zombie holding the port.
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('still exits when the graceful shutdown itself rejects', async () => {
    const { handlers, exit } = harness({ closeApp: vi.fn().mockRejectedValue(new Error('close failed')) });

    handlers.uncaughtException(new Error('boom'));
    await settle();

    expect(exit).toHaveBeenCalledWith(1);
  });

  it('does not re-enter when a second fatal arrives during shutdown', async () => {
    const { handlers, exit, logFatal, closeApp } = harness();

    handlers.uncaughtException(new Error('first'));
    handlers.unhandledRejection(new Error('second, while dying'));
    await settle();

    expect(logFatal).toHaveBeenCalledTimes(1);
    expect(closeApp).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('works with no app to close (a fatal before listen resolves)', async () => {
    const { handlers, exit, logFatal } = harness({ closeApp: undefined });

    handlers.unhandledRejection(new Error('rejected during bootstrap'));
    await settle();

    expect(logFatal).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
  });
});
