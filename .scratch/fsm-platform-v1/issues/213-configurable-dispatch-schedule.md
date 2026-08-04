# 213 — Operator-configurable dispatch schedule + a real guard against overlapping runs

Status: ready-for-agent
Type: AFK · Backend + Admin
Parent: [#197](./197-mobile-pilot-readiness-remediation-epic.md) · Filed 2026-08-04
Origin: operator ruling on [#198](./198-decision-day-boundary-and-dispatch-clock.md) Q2 — the answer
was wider than the question, so the surplus scope is filed here rather than buried in a decision issue.
Coordinates with: [#204](./204-time-semantics-day-boundary-implementation.md) (owns the `Asia/Kolkata`
pinning itself) · [#124](./124-effective-config-snapshot.md) (owns snapshotting config **at run start**
— a configurable time must appear in that snapshot)

## Root cause

The daily dispatch time is an **environment variable**, so changing when the field day's plan is
generated requires a redeploy rather than a settings edit — while `system_settings` already exists as
the Operations-Head-owned configuration registry and is the obvious home. Separately, the
single-in-flight guard that stops one dispatch run overlapping the next lives on the *scheduler*
object, and the manual HTTP trigger calls the run service directly — so the one path an operator would
reach for during an emergency is precisely the path with no concurrency guard.

## Findings closed

Operator ruling on #198 Q2 (2026-08-04). Not an audit finding — this scope arrived with the ruling.

## Evidence — verified 2026-08-04

**Already built — do NOT rebuild any of this:**

| Ask from the ruling | State | Cite |
|---|---|---|
| "Run Dispatch Now" action | exists | `schedules.controller.ts:70-78` — `POST /api/schedules/dispatch-run` |
| "with appropriate permissions" | exists | `@Roles('OPERATIONS_HEAD','CENTRAL_SERVICE_MANAGER')`, `:72` |
| "fully audited (who ran it, when)" | exists | `trigger: 'MANUAL'` + `actorUserId`/`actorRole` on the `dispatch_runs` ledger row and the `DISPATCH_RUN_STARTED`/`FINISHED` bracket — `dispatch-run.service.ts:16-20,61,78-86` |
| Admin UI for the manual run | exists | zone-scoped "Run dispatch" button, `apps/admin/src/api/bulkUnassign.ts:127` |
| Safe re-run | exists | idempotent; per-zone advisory locks (#100), `dispatch-run.service.ts:48` |

**The two genuine gaps:**

1. **The time is not operator-configurable.** `dispatch-scheduler.service.ts:22` reads
   `env.BUSINESS_SWEEP_DISPATCH_CRON?.trim() || DEFAULT_DISPATCH_CRON` (`'0 5 * * *'`, `:10`). It is an
   env var; there is no settings path. Meanwhile `system_settings` is described in-schema as
   "The system_settings registry — global, Operations-Head-owned configuration" and is already read at
   runtime elsewhere (e.g. `component-request.service.ts:296` reads `sla_resume_on_receipt`).
2. **A manual run can overlap a scheduled one.** `inFlight` is a private field on
   `DispatchSchedulerService` (`:41,53,57,65`) and guards only the cron path. The manual trigger calls
   `this.dispatchRun.runForActiveZones(...)` **directly** (`schedules.controller.ts:78`), bypassing it
   entirely. Per-zone advisory locks and idempotency mean an overlap degrades to benign skips rather
   than double-assignment — so this is a **robustness gap, not a live corruption bug** — but the
   operator explicitly asked that a manual run "should not conflict with an already running dispatch",
   and today nothing enforces that.

**Minor, explicitly optional in the ruling** ("why *if required*"): the manual-run body is
`{ zoneId? }` (`schedules.controller.ts:75`) — no reason field, so "why" is not captured.

## Approved direction (operator, 2026-08-04)

Both gaps approved to fix. The operator gave direction on each; it is binding, so it is recorded here
rather than left to implementation taste.

**Schedule config.** `system_settings` becomes the **source of truth**. `BUSINESS_SWEEP_DISPATCH_CRON`
is **demoted to a bootstrap default**, consulted only when no setting row exists — not read on every
tick, not a parallel source. Two properties matter more than the plumbing:
1. **A change takes effect without a restart.** Re-register the job when the setting is written — do
   **not** merely read the value at boot, and do not read-per-tick as a substitute for rescheduling.
2. **An invalid cron expression is rejected at write time, leaving the previous schedule intact.**
   Never accepted and then silently failing to fire. A schedule that is quietly dead is worse than one
   that is wrong, because nothing surfaces it until someone notices there is no day plan.
3. Every schedule change is logged **with the actor**.

**Overlap guard — fix the root cause, do not add a second check.** Lift the single-in-flight guard off
`DispatchSchedulerService`'s private field and put it somewhere **both** the scheduled path and the
manual trigger must pass through. Scope it **per zone**, consistent with the per-zone advisory locks
already in `DispatchRunService`. When a run is already in flight for that zone the manual trigger
returns a **clear conflict** — *"dispatch already running for this zone, started HH:MM by X"* — and
specifically **not**: a queued run, a silent no-op, or a bare 409 with no body. Admin **disables the
button and shows that message**, rather than letting someone discover the conflict by pressing twice.

**Manual-run reason.** Stays **optional**, but when supplied it is **persisted on the `dispatch_runs`
ledger row**. The operator's rationale, worth keeping: *"an emergency run with a one-line reason is
worth a lot when someone reads the audit trail three weeks later."*

## Scope

**In:** the three items above — settings-backed schedule with live re-registration and write-time
validation; one shared per-zone in-flight guard covering both entry paths, with a populated conflict
response and a disabled admin button; optional reason persisted on the ledger row.

**Out:** the `Asia/Kolkata` timezone pinning itself — [#204](./204-time-semantics-day-boundary-implementation.md)
owns that, and this issue depends on it. The `BUSINESS_SWEEPS_ENABLED` master switch — it stays an
env-level ops gate (#108's design), and this issue changes *when* dispatch runs, not *whether* the
sweeps subsystem is on. Building a new manual trigger, new audit, or new admin button — all three
already exist. Making every other sweep cron configurable: out unless it falls out for free; say so if
it does.

## Acceptance criteria

- [ ] The daily dispatch time lives in `system_settings` as the **source of truth**, defaulting to
      `05:00` `Asia/Kolkata`; `BUSINESS_SWEEP_DISPATCH_CRON` is consulted **only** when no setting row
      exists (bootstrap default) and is not a parallel source thereafter
- [ ] An Operations Head can change it from the admin settings page; other roles cannot
- [ ] **A change takes effect without a restart** — the job is **re-registered on write**. A test
      proves the next fire uses the new time with no process restart; reading the value at boot only,
      or read-per-tick in place of rescheduling, does not satisfy this
- [ ] **An invalid cron expression is rejected at write time with a clear error and the previous
      schedule is left intact and still firing** — never accepted-then-silently-dead
- [ ] Every schedule change is logged with the actor, the previous value and the new value
- [ ] **One shared per-zone in-flight guard** sits where both the scheduled path and the manual
      trigger must pass through it — the scheduler's private `inFlight` field is **removed**, not
      supplemented by a second check
- [ ] A manual `POST /schedules/dispatch-run` for a zone with a run in flight returns a conflict whose
      **body names the start time and the actor** ("dispatch already running for this zone, started
      HH:MM by X") — not a queued run, not a silent no-op, not a bare 409 with an empty body
- [ ] The reverse holds: a cron tick for a zone with a manual run in flight does not start a second run
- [ ] Admin **disables the Run-dispatch button and surfaces that message** while a run is in flight —
      the conflict is not something a user discovers by pressing twice
- [ ] A reason supplied on a manual run is **persisted on the `dispatch_runs` ledger row** and visible
      in the run detail; omitting it is still valid
- [ ] The configured time appears in [#124](./124-effective-config-snapshot.md)'s run-start config
      snapshot, so a run records the schedule it was generated under
- [ ] **Regression test for the concurrent case specifically** (operator-requested): a scheduled run
      is in flight, the manual trigger fires, and the test asserts **exactly one run executed** *and*
      that the caller received the conflict response. **Cheap** — the dispatch-scheduler suite exists
      and `#183` established the frozen-clock fixture pattern

## Verification

```bash
cd apps/backend && node scripts/run-tests.mjs test/dispatch-scheduler.e2e-spec.ts test/dispatch-run.e2e-spec.ts
cd apps/admin && npx vitest run src/pages/settings
```
Plus manually: set the time from the admin settings page, confirm the next tick fires at the new IST
hour without a restart; then fire `POST /schedules/dispatch-run` twice concurrently and confirm the
second is refused rather than run.

## Risk if deferred

Low today, higher at pilot. The operator's stated use cases for "Run Dispatch Now" are exactly the
moments when a second run is most likely to be triggered — after a master sync, during an unexpected
operational change, in an emergency — and someone impatient will press the button twice. Idempotency
and per-zone locks mean the result is wasted work and confusing partial-skip ledgers rather than
corrupted assignments, but the operator asked for a guarantee and there currently isn't one. Meanwhile
changing the dispatch hour needs a deploy, which in practice means it will not be tuned during the
pilot when tuning it is most valuable.

## Size estimate

S-M. The settings plumbing is the bulk; the concurrency guard is small once the two entry paths share
one gate.
