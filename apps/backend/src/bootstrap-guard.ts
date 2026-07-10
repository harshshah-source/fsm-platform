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
    deps.logFatal(`Application bootstrap failed — ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    deps.exit(1);
  }
}
