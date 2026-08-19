# #240 — IST day-boundary correctness: closure cron, planner date, manual-assign date

**Done 2026-08-19.** Backend only. First slice of the scheduler-decisions block
(`docs/audits/scheduler-slice-plan-2026-08-19.md`); hard prerequisite of #242, since recycling at
schedule closure is only correct if closure runs *before* the dispatch it feeds.

Tree at start: `0b72976` — unchanged since the 2026-08-18 line-exact verification, so every
file:line reference in the issue was re-confirmed rather than re-derived.

## What was wrong

Three defects of one family. `Asia/Kolkata` became the operating day in #198/#204 (CONTEXT.md
Decisions §19), and `common/ist-day.ts` was written for exactly this, but three sites never adopted
it. IST is UTC+05:30, so **between 00:00 and 05:29 IST the UTC calendar date is still yesterday** —
the entire defect lives in that 5½-hour window and is invisible outside it.

1. `schedule-closure-scheduler.service.ts:91` — `@Cron` carried **no `timeZone`**, while the
   dispatch cron (`dispatch-scheduler.service.ts:63`) passes `timeZone: BUSINESS_TIMEZONE`. No `TZ`
   is set in any compose/Dockerfile/env in this repo, so on a UTC host `0 4 * * *` fired at **09:30
   IST — 4.5 h *after* the 05:00 IST dispatch**, inverting the closure→dispatch ordering. The file's
   own docstring asserted the opposite twice ("04:00 UTC … ahead of … the 05:00 dispatch tick", "the
   crons are an hour apart"), which is how it survived: the comment described the intent and nothing
   tested the fact.
2. `recommender.service.ts:590` — `plannerForDate` derived its day from UTC components, so a run in
   the night window read the **previous** IST day's `se_planner` rows. The failure is silent by
   construction: the SE Planner is a *soft* bias, so a missing row is indistinguishable from "no
   plan", and selection just falls back to precedence with nothing logged.
3. `override.service.ts:282` — `assignTicket` derived its schedule day the same way, so a manual
   assign at 01:00 IST landed on a schedule dated yesterday — a *different* row from the one
   `dispatchForZone` builds and every day-plan read serves for that same instant.

## Slices (RED → GREEN)

### Slice 1 — AC-1 + AC-4: the closure cron's timezone

- **RED** — `schedule-closure-wiring.e2e-spec.ts`, new case: boot the real `SchedulingModule` and
  read the registered job's absolute next fire. Expected 22:30 UTC (= 04:00 IST); **got 04:00 UTC**
  — i.e. 09:30 IST, the defect exactly.
- **GREEN** — `timeZone: BUSINESS_TIMEZONE` on the `@Cron`, importing from `dispatch-cron.ts`.
- Asserted **behaviourally** (when does it next fire, in absolute terms) rather than by reading
  decorator metadata, mirroring the #204 dispatch pin in `dispatch-scheduler.e2e-spec.ts:103`, so it
  survives however `@nestjs/schedule` chooses to store its options.
- AC-4 rode along: both false claims in the docstring corrected to state the IST ordering, and
  `SCHEDULE_CLOSURE_CRON` documented as an IST expression. (No `.env.example` in this repo mentions
  the variable — checked; the docstring is the only place it is documented.)

### Slice 2 — AC-2: `plannerForDate`

- **RED** — new `ist-day-boundary-scheduling.e2e-spec.ts`. A planner row names an SE for the plant on
  the IST day of `now = 2026-06-21T19:30:00Z` (**01:00 IST on 2026-06-22**); the run must prefer that
  SE over the strictly-precedent dedicated SE. Failed: the recommendation named the **dedicated** SE
  — the bias had vanished, which is the silent-fallback behaviour described above.
- **GREEN** — `const day = istDate(now)`.
- Observed through the recommendation `runForZone` wrote, not by reaching at the private lookup.

### Slice 3 — AC-3: `assignTicket`

- **RED** — same spec, same instant: `assignTicket` must find/create the schedule for the IST day.
  Failed with `2026-06-21T00:00:00.000Z` where `2026-06-22T00:00:00.000Z` was expected.
- **GREEN** — `const day = istDate(now)`.

**REFACTOR** — none. Each fix is a one-line substitution onto an existing, already-tested helper.

## Verification

- New/changed specs: `ist-day-boundary-scheduling.e2e-spec.ts` (2 tests, new) ·
  `schedule-closure-wiring.e2e-spec.ts` (1 → 2 tests).
- Sibling regressions run explicitly, because both changed derivations have existing owners:
  `recommender-planner-bias.e2e-spec.ts` 2/2 and `critical-assign.e2e-spec.ts` 2/2 stay green —
  their `now` is 06:00 UTC (11:30 IST), the same IST and UTC day either way, which is precisely why
  they never caught this.
- `tsc --noEmit` clean.
- Full backend suite: **368 files accounted for, 1746 passed / 2 failed / 5 skipped**. Both failures
  are in `voucher-controller.e2e-spec.ts` and are **pre-existing** — proven by stashing every change
  from this session and re-running the spec, which fails identically (and fails differently again in
  isolation, i.e. it is fixture-state dependent, the #156 flakiness class). One worker crash was
  retried and recovered by `scripts/run-tests.mjs` (#184), all files reconciled.

## Behaviour change

Strictly corrective, and only inside 00:00–05:29 IST plus the cron's firing time: a manual assign at
01:00 IST now lands on today's plan rather than yesterday's, the planner bias applies on night runs,
and closure precedes dispatch on a UTC host. No schema, API, or UI change. Rollback = revert the
commit.
