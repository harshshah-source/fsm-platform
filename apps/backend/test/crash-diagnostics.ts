import { appendFileSync } from 'node:fs';

/**
 * #184 AC-1 instrumentation — OFF unless TINYPOOL_CRASH_LOG is set (paired with the tinypool patch,
 * `patches/tinypool@1.1.1.patch`, which logs the parent-observed child exit code/signal to the same
 * file). This file captures the in-child half: an uncaughtException/unhandledRejection escaping
 * every test file's awaited task (tinypool's `entry/process.js` already try/catches the awaited
 * handler — see #184 investigation notes — so anything reaching here fired on a tick *after* that
 * promise had already settled, e.g. a dangling timer or cron racing `app.close()`).
 *
 * Installing these handlers removes Node's default terminate-on-uncaught behaviour, so each handler
 * re-exits(1) itself after logging — the crash still happens, we just see why first.
 */
const logPath = process.env.TINYPOOL_CRASH_LOG;

if (logPath && !(globalThis as Record<string, unknown>).__fsmCrashDiagnosticsInstalled) {
  (globalThis as Record<string, unknown>).__fsmCrashDiagnosticsInstalled = true;
  const pid = process.pid;

  const log = (line: string): void => {
    try {
      appendFileSync(logPath, `[${new Date().toISOString()}] pid=${pid} ${line}\n`);
    } catch {
      // best effort — never let logging itself throw during a crash
    }
  };

  process.on('uncaughtException', (err) => {
    log(`uncaughtException: ${err?.stack ?? String(err)}`);
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    const detail = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
    log(`unhandledRejection: ${detail}`);
    process.exit(1);
  });
  process.on('warning', (warning) => {
    log(`warning: ${warning.stack ?? warning.message}`);
  });
  process.on('exit', (code) => {
    const mem = process.memoryUsage();
    log(
      `process exit code=${code} rss=${Math.round(mem.rss / 1e6)}MB heapUsed=${Math.round(mem.heapUsed / 1e6)}MB external=${Math.round(mem.external / 1e6)}MB`,
    );
  });

  log(`crash-diagnostics installed`);
}
