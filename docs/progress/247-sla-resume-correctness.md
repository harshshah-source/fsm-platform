# #247 — the clock starts again when the vehicle is due back

**Done 2026-08-19**, commit `c5af9ee`. Backend only (the admin VU page already shows pause state; the
values it shows now change truthfully). Built on #245/#246's authoritative return date.

## What this closes

Two defects in the same mechanism, one asymmetric and one simply absent.

**The asymmetric one.** `resumeSla`'s guard was `slaPaused && slaPausedAt` — which is exactly as true
of a cycle waiting for a *component* as one waiting for a vehicle. So a manager resolving a vehicle
report on a component-paused cycle silently restarted the primary SLA on a ticket nobody could work.
What hid it is the asymmetry with `fileReport`, which guards on `!cycle.slaPaused` and so *refuses* to
re-pause an already-paused cycle, leaving whatever reason was standing. Filing preserved the reason;
resuming cleared it; which pause you ended up with depended only on the order the two events happened
in, and neither writer looked wrong on its own.

**The absent one.** There were exactly two writers of `sla_paused = false` in the whole system and
**neither was date-driven**. #246 made a waiting ticket re-enter the dispatch pool on its authoritative
return date by itself — the deferral simply lapses — but nothing restarted the clock that measures how
long the fix has taken. A returned ticket was therefore dispatchable, workable and closable with its
primary SLA frozen: **the longer a vehicle had been away, the healthier the ticket looked in the very
report the pause exists to keep honest.** A human had to notice and press resume, and nothing anywhere
said so.

## What was built

| Slice | Seam | Substance |
|---|---|---|
| 1 | `VehicleUnavailabilityService.resumeSla` | resumes only a `VEHICLE_UNAVAILABLE` pause; still resolves the report either way, and reports which of the two it did (`slaResumed`) |
| 2 | `VehicleReturnResumeService.sweepReturnedVehicles(now)` | the date-driven resumer: OPEN reports whose authoritative `expected_from` has reached today's IST day, interval folded in once, batched SYSTEM audit |
| 3 | `VehicleReturnResumeScheduler` + `TicketingModule` | the tick, IST-pinned at 03:30, first in the daily chain |

`returnDateArrivedBefore` was added beside `deferralDateFor` in `deferral.ts` as **one** definition of
"the return date has arrived", and #248 reads the same one. It is deliberately the complement of the
deferral rule: a ticket becomes return-due at exactly the moment its deferral stops holding it back,
because those are the same event seen from two sides. Written as one end-exclusive instant rather than
a day-truncating expression so it uses `@@index([status, expectedFrom])` on a predicate the dispatch
path evaluates every run.

## Three decisions worth stating

**The report is left OPEN** (Decision 16). The vehicle being *due* back is not the SE finding it there.
Resuming the clock and resolving the report are two different claims and only the first is true at that
moment; the report resolves when a submission closes the attempt or a fresh absence supersedes it. This
also keeps the manual and automatic paths honestly distinct — `resumeSla` is a manager saying "this is
over", the sweep is the calendar saying "the wait you declared has elapsed".

**The reason check is what makes it idempotent.** After the flip the cycle is not paused, so the next
tick — and the one the night after, while the report is still open — finds nothing. The same single
check delivers "exactly once", "never touches a component pause", and "skips an already-manually-resumed
cycle". There is no separate bookkeeping to get wrong.

**A standalone, IST-pinned scheduler rather than a twelfth business sweep.** The issue said to reuse
`BusinessSweepSchedulerService`'s registration pattern; it shares that master switch and guard shape,
but sits beside it like `ScheduleClosureScheduler` and `PlantEligibilityRefreshScheduler` (a structural
precedent — only the first of those is itself IST-pinned; see #254). The deciding reason is the
timezone, not tidiness: every cron on `BusinessSweepSchedulerService` is registered **unpinned**, which
is right for its wall-clock-agnostic sweeps (every 2/5/15 minutes) and wrong here, where the whole
semantics are "the IST calendar day arrived" and AC4 requires firing before the IST-pinned 05:00
dispatch. Corrected in the issue file in place.

## AC4, and why the pin is real

03:30 IST is 22:00 UTC the previous day — an hour ahead of the 04:00 IST closure, and 1.5 h ahead of
the 05:00 IST dispatch. The test asserts the *absolute* next firing instant rather than reading back
stored options, mirroring the #240 closure pin.

An honest limit, worth recording: **this host runs on IST**, so removing `timeZone` does not turn the
assertion red here. Verified under `TZ=UTC` instead, where it does: unpinned, the job next fires at
03:00 UTC — 08:30 IST, three and a half hours *after* the dispatch it must precede. That is #240's bug
exactly, and the same limitation applies to the existing closure pin.

## Test sensitivity

Twelve tests across three specs, RED before GREEN in every case. Six probes, each turning exactly the
intended test red and nothing else:

| Probe | Went red |
|---|---|
| drop the reason check from the sweep | the component-paused case |
| UTC-midnight bound instead of IST | the return-arrives case + the still-ahead case |
| drop the `status: 'OPEN'` filter | the superseded/resolved case |
| leave the cycle paused after resuming | all five (loud, via shared state) |
| make the secondary clock pausable | the AC5 read-seam pin |
| remove `timeZone`, under `TZ=UTC` | the AC4 cron-ordering pin |

`scheduler-wiring.e2e-spec.ts`'s exact cron-name set went from 17 to 18 in the same commit — which is
that spec working as designed, not collateral.

## Two gaps found, both filed rather than folded in

**[#253](../../.scratch/fsm-platform-v1/issues/253-vu-pause-stranded-by-early-submission.md)** — a
submission that resolves a vehicle report **before** the return date leaves the cycle paused with no
automatic resumer left, because the sweep only ever looks at OPEN reports. Reachable through the shared
pool or through #249's own deferral override. Not folded in because closing it means a third automatic
writer of `sla_paused = false`, and AC2's "single writer" phrasing deserves an explicit re-ruling rather
than a quiet edit.

**[#254](../../.scratch/fsm-platform-v1/issues/254-plant-eligibility-refresh-cron-unpinned.md)** — found
while writing the daily chain into SYSTEM-STATE §3g, by noticing one row could not be true.
`plant-eligibility-refresh` is registered with **no `timeZone`**, and its docstring says "04:30 UTC,
i.e. shortly before the default 05:00 dispatch tick" — but that dispatch is 05:00 **IST**, so on a UTC
host the refresh fires five hours *after* the batch it exists to feed. Identical shape to the
`schedule-closure` defect #240 fixed; it was simply not in that issue's scope, and it is now the last
unpinned link in the chain. Bounded rather than severe (#138 slices 1–2 cover the common cases; this is
the backstop), but its stated contract is false today.

## Files

- `src/ticketing/vehicle-return-resume.service.ts` (new), `…-scheduler.service.ts` (new)
- `src/ticketing/vehicle-unavailability.service.ts`, `…controller.ts`, `deferral.ts`,
  `ticketing.module.ts`
- `test/vu-sla-resume-correctness.e2e-spec.ts`, `test/vu-auto-resume-sweep.e2e-spec.ts`,
  `test/vu-auto-resume-wiring.e2e-spec.ts` (new); `test/scheduler-wiring.e2e-spec.ts` (cron list)

No migration. `VU_AUTO_RESUME_CRON` is the only new environment key, and it has a working default.
