# 257 — the stored dispatch schedule is never applied at boot; every boot logs the failure and stays on the default

Status: done (2026-08-20)
Type: AFK · Backend (scheduler engine, #213 family)

Filed 2026-08-20 from a scheduler-engine analysis prompted by the ERROR line that appears in **every**
e2e application boot — hundreds of boots across three full suite runs, 100% of them:

```
ERROR [DispatchScheduleService] stored dispatch schedule '0 5 * * *' could not be applied, staying on
the registered default: No Cron Job was found with the given name (business-dispatch).
```

That line was read past as test noise. It is not noise — it is the boot half of #213 failing on every
single boot, in tests and (same module graph) in production.

## Root cause — precise, in the framework

- `DispatchSchedulerService.dispatchTick` registers `business-dispatch` via `@Cron`
  (`dispatch-scheduler.service.ts:63`). Decorator jobs are **discovered** by `ScheduleExplorer` in its
  `onModuleInit` but only **mounted into `SchedulerRegistry`** by `SchedulerOrchestrator` in its
  `onApplicationBootstrap` (`@nestjs/schedule@4.1.2`, `scheduler.orchestrator.js:24` → `mountCron()`).
- `DispatchScheduleService.onApplicationBootstrap` (`dispatch-schedule.service.ts:72`) calls
  `SchedulerRegistry.getCronJob(DISPATCH_JOB_NAME)` to re-point the job at the stored schedule.
- Nest invokes `onApplicationBootstrap` hooks **module-by-module, deepest-first**
  (`nest-application-context.js:289`: `compareFn = (a, b) => b.distance - a.distance`). On this app's
  graph, `SchedulingModule`'s hook runs **before** the dynamic `ScheduleModule`'s orchestrator hook —
  deterministically, which is why the error fires on every boot without exception.
- The service's own docstring fixed the wrong half: it moved from `onModuleInit` to
  `onApplicationBootstrap` because "`@nestjs/schedule` mounts decorator-declared jobs in its own
  bootstrap hook" — true, but that hook runs *after* this one on this graph, so the job does not exist
  at either time from this module's position.

## Consequence

The `catch` treats the throw as a hand-edited bad expression and "stays on the registered default" —
so **the stored schedule has never once been applied at boot since #213 landed.** Nobody noticed
behaviourally because the seeded value equals the compile-time default (`0 5 * * *`). The day an
operator changes the dispatch hour via `PUT /api/schedules/dispatch-schedule`:

- it works immediately (the write path re-points the live job — #213's test proves this), **but**
- after the next restart/redeploy, dispatch silently reverts to 05:00 IST while
  `GET /schedules/dispatch-schedule` keeps reporting the operator's stored value — the exact
  "settings say X, engine does Y" divergence this platform has been systematically closing (#244's
  `SETTING_VALIDATORS`, #240's timezone pins).

#213's guarantee 1 ("a change takes effect without a restart") holds **within** a process and breaks
**across** processes.

## What to build

1. Make the application of the stored schedule a public method (`applyStoredSchedule()`), and call it
   from `main.ts` **after `app.listen()`** — the one point where Nest guarantees every module's
   bootstrap hook (the orchestrator's included) has completed. No hook-order folklore.
2. Keep the bootstrap hook for what it can safely do from its position: seed the setting row
   (#213 AC-1's boot-seeding) and apply **if** the job happens to be mounted
   (`SchedulerRegistry.doesExist('cron', …)`), logging at `log`, not `error`, when it defers — an
   unmounted registry at this point is the documented framework ordering, not a defect.
3. Keep the loud `error` for a genuinely unparseable stored expression, which remains a real
   possibility (`applyStoredSchedule` keeps the try/catch).

## Acceptance criteria

- [x] AC1 — A stored `dispatch_cron` **different from the compile-time default** is live (the
      registered job's next fire reflects it) after the boot path completes, proven by a spec that
      writes the row *before* booting the app. This is red today.
- [x] AC2 — No boot logs the `could not be applied … No Cron Job was found` ERROR; the deferred case
      logs at `log` level with the stored value named.
- [x] AC3 — The existing #213 write-path guarantee (change takes effect with no restart) stays green,
      as does boot-seeding of the row.
- [x] AC4 — `main.ts` invokes the application step after listen, with a comment naming why it cannot
      live in a lifecycle hook.

## Closed 2026-08-20

Built exactly as specified. `applyStoredSchedule()` on `DispatchScheduleService`; `main.ts` calls it
after `app.listen()` with a comment naming the hook-ordering reason; the bootstrap hook now seeds the
row and applies only behind `registry.doesExist('cron', …)`, logging at `log` when it defers. New spec
`dispatch-schedule-boot.e2e-spec.ts` writes `0 6 * * *` **before** booting and asserts the composed
boot path lands the live job on 00:30 UTC — red 3/3 first (`applyStoredSchedule is not a function`,
i.e. the boot path that applies the schedule did not exist), green after, and probe-verified (gut the
apply → 3/3 red → restore, diff-verified). It also pins idempotence and the bad-expression path (the
loud ERROR now reserved for a genuinely unparseable stored value). The whole #213 config spec stays
green (9/9), and the `could not be applied … No Cron Job was found` ERROR is gone from every app boot
— verified 0 occurrences on a spec that boots the full AppModule. Note for readers of old logs: every
boot between #213 landing and this fix logged that ERROR; it was the boot-apply failing, not a bad
stored expression.

## Blocked by

none.
