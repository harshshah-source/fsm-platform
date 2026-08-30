/**
 * Fatal bootstrap guard (#98 leg 3). Wraps `bootstrap()` so a startup failure surfaces as a logged
 * fatal + a non-zero process exit, instead of being swallowed into an unhandled promise rejection by
 * `void bootstrap()`. `exit` and `logFatal` are injected so the guard is testable without spawning a
 * process or touching `process.exit` directly.
 */
export interface FatalGuardDeps {
  exit: (code: number) => void;
  logFatal: (message: string) => void;
}

export async function runWithFatalGuard(
  boot: () => Promise<void>,
  deps: FatalGuardDeps,
): Promise<void> {
  try {
    await boot();
  } catch (err) {
    deps.logFatal(`Application bootstrap failed — ${describeError(err)}`);
    deps.exit(1);
  }
}

/**
 * Render anything throwable as one diagnosable string.
 *
 * `unhandledRejection` hands through the rejection *reason*, which is very often not an `Error` — a
 * Prisma error object, a string, a `{code, detail}` bag. `String(reason)` renders those as
 * `[object Object]`, which is exactly as useless as the silence this whole seam exists to end. This
 * must never itself throw: it is the last thing that runs before the process goes.
 */
export function describeError(err: unknown): string {
  if (err instanceof Error) return err.stack ?? `${err.name}: ${err.message}`;
  if (typeof err === 'object' && err !== null) {
    try {
      return JSON.stringify(err);
    } catch {
      return Object.prototype.toString.call(err); // circular / unserialisable
    }
  }
  return String(err);
}

export interface FatalHandlerDeps extends FatalGuardDeps {
  /** Registers a process-level listener. Injected so tests never touch the real `process`. */
  on: (event: 'uncaughtException' | 'unhandledRejection', handler: (err: unknown) => void) => void;
  /**
   * Graceful shutdown — `app.close()`, which runs Nest's lifecycle so Prisma `$disconnect` and the
   * AutoPlant MySQL pool actually release. Optional: a fatal can arrive before the app exists.
   */
  closeApp?: () => Promise<void>;
  /** How long that shutdown gets before the process exits regardless. */
  shutdownTimeoutMs?: number;
}

/**
 * **Make a runtime death legible** (2026-08-28 incident).
 *
 * {@link runWithFatalGuard} covers `bootstrap()` only. After `listen()` resolves nothing was
 * listening for `uncaughtException` / `unhandledRejection`, so on Node 15+ one stray rejection —
 * from any of the ~20 `@Cron` sweeps or any request path — killed the API with **no log line at
 * all**, and `npm run start` (bare `node dist/main.js`) has no supervisor to bring it back. The
 * operator's only evidence was a dead port.
 *
 * **This changes diagnosability, not lifecycle.** The process still exits non-zero, because that is
 * what Node already did and because continuing past an uncaught exception means running ~20 jobs
 * that *write dispatch data* from a state nobody can vouch for — the exact hazard `#130`'s
 * stale-code-write guard exists to prevent. Surviving a crash is a supervisor's job (a process
 * manager restarting `dist/main.js`), not a swallowed exception's.
 *
 * The shutdown is **bounded**: a hung `app.close()` must not convert a crash into a zombie still
 * holding port 3000, so the exit races a timer and happens either way.
 */
export function installFatalHandlers(deps: FatalHandlerDeps): void {
  const timeoutMs = deps.shutdownTimeoutMs ?? 5_000;
  let dying = false;

  const die = (label: string, err: unknown): void => {
    // A second fatal raised *by* the shutdown (or arriving alongside the first) must not re-enter
    // and re-close: one death, one log line, one exit.
    if (dying) return;
    dying = true;

    deps.logFatal(`${label} — ${describeError(err)}`);

    const closed = deps.closeApp ? deps.closeApp() : Promise.resolve();
    const bounded = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      // Never let the guard's own timer be the reason the process lingers.
      if (typeof timer === 'object' && timer !== null && 'unref' in timer) timer.unref();
    });

    void Promise.race([closed, bounded])
      .catch(() => undefined) // a failing shutdown still exits — it must not mask the original fatal
      .then(() => deps.exit(1));
  };

  deps.on('uncaughtException', (err) => die('Uncaught exception', err));
  deps.on('unhandledRejection', (err) => die('Unhandled promise rejection', err));
}
