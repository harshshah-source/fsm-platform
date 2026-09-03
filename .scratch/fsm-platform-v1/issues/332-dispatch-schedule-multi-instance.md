# 332 — Dispatch-schedule changes and multi-instance cron re-registration
Status: needs-info (deployment-shape decision — single NestJS process today; #263 implies
multi-instance is anticipated)
Type: HITL
Wave: 4 · Severity: P3 · Finding: AR-17/A3, `audit/2026-09-01-scheduler-engine-forensics.md` §7

## Problem
`PUT /schedules/dispatch-schedule` re-registers the live cron job on the **handling instance
only** (`dispatch-schedule.service.ts:116+`); other instances keep firing at the old hour until
restart. The cron-tick claim (#263) dedupes ticks but does not prevent the *wrong-time* fire from
a stale instance: on a multi-instance deployment, an operator's schedule change takes effect on
one instance and the old hour keeps firing from the rest — the tick claim makes exactly one of
them run, so the day can dispatch at the old time, the new time, or both-attempted-one-ran.

## Why needs-info
Today's deployment is a single process (SYSTEM-STATE §1.3), so the defect is latent. The fix
shape depends on a decision the operator owns: is multi-instance deployment planned before v1
activation? If no — record that and close as documented-limitation with a boot-time note. If yes
— the fix is a re-read seam (each instance re-applies the stored schedule on a cadence, or the
tick handler validates its fire time against `system_settings.dispatch_cron` before claiming).

## Affected files / symbols
`apps/backend/src/scheduling/dispatch-schedule.service.ts`; possibly
`dispatch-scheduler.service.ts` (fire-time validation).

## Intended behavior after fix (if multi-instance is affirmed)
A schedule write takes effect on every instance within a bounded window without restart; no
instance can dispatch at a retired hour.

## Implementation boundaries
Dispatch schedule only; no general config-broadcast machinery.

## DB / API / frontend impact
None expected.

## Dependencies
Decision first. Technically independent of other slices.

## Regression risks
A validate-at-fire design must not break the boot-apply fix (#257) or manual runs (never
tick-claimed).

## Tests required
(If built) two-registry simulation: write new hour on instance A → instance B's stale fire
declines/no-ops; boot-apply spec stays green.

## Acceptance criteria
- [ ] AC1 — the operator decision (multi-instance before activation: yes/no) is recorded here.
- [ ] AC2 — yes ⇒ no instance fires dispatch at a retired hour; no ⇒ the limitation is stated in
      `dispatch-schedule.service.ts` and SYSTEM-STATE.

## UI surfaces
n/a.

## Reference
n/a.

## Blocked by
Operator decision (Strategic HITL: architecture/deployment)
