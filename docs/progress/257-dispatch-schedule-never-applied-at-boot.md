# #257 — the boot half of #213 executes for the first time

**Done 2026-08-20.** One `src/` change (`dispatch-schedule.service.ts` + a `main.ts` call), one new
spec. Found by taking the ERROR line that opens every e2e application boot seriously instead of
reading past it as noise.

## The defect

`DispatchScheduleService.onApplicationBootstrap` re-points the registered `business-dispatch` job at
the stored `dispatch_cron` — but `@Cron` jobs are only **mounted** into `SchedulerRegistry` by
`SchedulerOrchestrator`'s *own* `onApplicationBootstrap` (`@nestjs/schedule@4.1.2`), and Nest runs
bootstrap hooks deepest-module-first (`b.distance - a.distance`,
`@nestjs/core/nest-application-context.js:289`). On this app's graph SchedulingModule's hook runs
first, `getCronJob` throws, the catch logs

```
ERROR … stored dispatch schedule '0 5 * * *' could not be applied … No Cron Job was found (business-dispatch)
```

and the job stays on the compile-time default. **Every boot since #213 landed took this path** —
hundreds of e2e boots across three suite runs, 100% of them, deterministically. The service's own
docstring had fixed the wrong half (it moved from `onModuleInit` to `onApplicationBootstrap` to be
"after" the mount — but the mount is itself a bootstrap hook that runs later from this module's
position).

**Consequence in production:** invisible today only because the seeded value equals the default. The
day an operator changes the dispatch hour, it works (the write path re-points the live job) — until
the next restart, when dispatch silently reverts to 05:00 IST while
`GET /schedules/dispatch-schedule` keeps reporting the operator's value. #213's guarantee held within
a process and broke across processes.

## The fix — the ordering Nest actually guarantees

- `applyStoredSchedule()` is public; **`main.ts` calls it after `app.listen()`**, the one point where
  every module's bootstrap hook is guaranteed complete. Not a graph massage (importing modules to
  reorder hook distances), because that breaks silently the next time anyone touches an import.
- The bootstrap hook keeps its two safe jobs: seed the setting row (#213 AC-1) and apply **iff**
  `registry.doesExist('cron', …)` — logging at `log`, not `error`, when it defers, since an unmounted
  registry at that point is documented framework ordering.
- The loud ERROR remains, reserved for a genuinely unparseable stored expression.

## Verification

`dispatch-schedule-boot.e2e-spec.ts` writes `0 6 * * *` **before** booting — the restart scenario the
old test could not see (its stored value equalled the default, so asserting the default's fire time
passed whether the apply ran or not). Red 3/3 first; green after; probe (gut the apply → 3/3 red →
restore, diff-verified). Idempotence and the bad-expression path pinned. #213's full config spec 9/9
unchanged. The boot ERROR verified at **0 occurrences** on a full-AppModule boot; the deferred path
logs `dispatch schedule '…' stored; job not mounted yet — applied after bootstrap (main.ts)`.

For readers of old logs: every `could not be applied` ERROR between #213 and this fix was the
boot-apply failing, not a corrupted stored expression.
