# 294 — the backend died silently mid-session, and nothing restarts it

Status: **needs-info** (the fatal line is now captured; the root cause is not yet known)
Type: Bug · Backend · Ops · M
Found: 2026-08-28, reported by the operator — "navigating between pages … the application suddenly
closed and took me to logout page … the application close from backend".

---

## What happened

The API process died mid-session. The admin app then had nothing to authenticate against and dropped
the operator to the login screen, which is the **symptom**, not the fault.

**The death window is pinned to two minutes by the cron ledger.** `cron_tick_claims` shows sweeps
claiming on their 1-, 2- and 5-minute cadences without a gap up to `08:30:00Z`, and then nothing at
all until the manual restart at `08:38:17Z` — the `08:32`, `08:34`, `08:36` and `08:38`
notification-outbox ticks are simply absent:

```
08:26 |  2 | critical-assign,notification-outbox
08:27 |  1 | dispatch-reaper
08:28 |  2 | critical-assign,notification-outbox
08:30 |  9 | critical-assign,cross-zone,dispatch-reaper,dispatch-recovery,install-verification,
           |   notification-outbox,repeat-escalation,tier-override-expiry,verification
   ——  process dead: 08:30–08:32Z  ——
08:39 |  1 | dispatch-reaper          ← manual restart
```

So it died **within two minutes of the largest sweep batch of the hour** (nine jobs aligning at
`:30`). That is a correlation with a timer, not with a page load — worth stating plainly, because the
operator understandably attributed it to the navigation they happened to be doing.

## Why it was invisible — half of this is now fixed

`runWithFatalGuard` (#98 leg 3) wraps `bootstrap()` **only**. After `listen()` resolved, nothing held
`uncaughtException` / `unhandledRejection`, so on Node 18 one stray rejection anywhere killed the
process **with no log line**. Fixed 2026-08-30 by `installFatalHandlers` (`src/bootstrap-guard.ts`,
7 tests in `test/fatal-handlers.spec.ts`): one FATAL line with the stack, a bounded `app.close()`,
exit 1. **A recurrence is now self-describing.**

**The other half is still open: there is no supervisor.** `npm run start` is bare
`node dist/main.js`, so a fatal exit leaves port 3000 dead until a human notices. Making the process
*survive* a fatal is the wrong fix — ~20 crons write dispatch data, and continuing from an unvouched
state is the hazard #130 exists to prevent — so the fix is a process manager that restarts it and
records the restart, not a swallowed exception.

## What was ruled out during the investigation (2026-08-28)

| Suspect | Evidence against |
|---|---|
| Out of memory | 93 MB working set, 297 MB peak under deliberate load — nowhere near a heap ceiling |
| Native crash | Zero `node.exe` entries in Windows Error Reporting for the window |
| Postgres restart / connection loss | `pg_postmaster_start_time()` = 2026-08-26, continuous; 6 of 100 connections in use |
| #130 runtime-lock refusal | `runtime_lock` consistent, one row, no fingerprint conflict |
| The Scheduler Console's own endpoints | `/dispatch/today`, `/changes-today`, `/action-required`, `/schedules?date=` and **six concurrent `/schedules/preview` recommender runs** all returned 200; process survived |

## The two leads worth pulling first

1. **The `:30` sweep batch.** Nine jobs fire together there and only there. Each is `runGuarded`
   (try/catch → structured outcome), so a *direct* throw is contained — but anything a sweep starts
   and does not `await` escapes that guard entirely and lands on the process. Audit the eleven sweeps
   for fire-and-forget work, starting with the ones unique to `:30`: `cross-zone`,
   `repeat-escalation`, `tier-override-expiry`.
2. **Uncommitted work-in-progress was compiled into the running `dist`.** The build under which the
   crash happened was made from the working tree, which carries other sessions' unfinished backend
   changes — notably #264's `business-notification-outbox` sweep (`*/2 * * * *`, so it is in every
   batch). This is its own lesson: **a `dist` built from a dirty tree is not a reviewable artifact**,
   and the crash cannot be attributed to committed code with confidence.

## Acceptance criteria

- [ ] A recurrence produces a FATAL line naming the failing code — **already true**, verified end to
      end against a real `process.on('unhandledRejection')` (not a mock).
- [ ] The eleven sweeps are audited for work started without `await`, and any found is either awaited
      inside `runGuarded` or given its own `.catch()`.
- [ ] The backend runs under a supervisor that restarts it and records the restart, so a crash
      degrades to a blip rather than a dead port. Decide the mechanism (an ops choice, not a code one).
- [ ] Operator runbook says how to capture backend output (`npm run start 2>&1 | tee backend.log`),
      so the next occurrence is diagnosed from a file rather than from scrollback.

## Notes

Filed as **needs-info** deliberately rather than `ready-for-agent`: the fatal line that names the
cause did not exist when the crash happened, and inventing a culprit from a two-minute correlation
would be exactly the "status line is a hypothesis, not a fact" failure this tracker's own convention
warns about. The next occurrence answers it in one line.
