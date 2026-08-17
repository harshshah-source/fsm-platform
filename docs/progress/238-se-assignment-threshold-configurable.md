# #238 — Configurable SE-assignment threshold (OH + CSM authority, OH final decision)

**Completed 2026-08-13.** Issue: [`.scratch/fsm-platform-v1/issues/238-se-assignment-threshold-configurable.md`](../../.scratch/fsm-platform-v1/issues/238-se-assignment-threshold-configurable.md)

Frozen record. Corrections go to INDEX / SYSTEM-STATE, not here.

---

## The decision that shaped everything else

The ask — *"make the threshold for when an SE is assigned configurable"* — had an obvious
implementation that was wrong.

`system_settings.inactivity_threshold_hours` (default 24) already looked exactly like the requested
dial. It is not, because it defines `device_states.is_inactive`, and `is_inactive` is:

- the **denominator of Fleet Uptime %**, the monthly KPI zones are graded on, and
- the **Soft Inactive Count** that drives each zone's DEFICIT/PREVENTIVE recommender mode.

Moving it for a dispatch reason silently restates every historical KPI and makes zones
non-comparable in the very reports built to compare them. `docs/proposals/zone-engine-customization-2026-07-21.md`
§3.1 argues this at length; `audit/STATUS.md:281` states the conclusion outright.

So #238 adds a **second, independent** key — `se_assignment_threshold_hours` — and keeps the
measurement and the policy apart:

| | Measurement | Policy |
|---|---|---|
| Key | `inactivity_threshold_hours` | `se_assignment_threshold_hours` |
| Answers | "is this device down?" | "is this device *our problem to send someone for*?" |
| Consumers | Fleet Uptime, SLA buckets, Soft Inactive Count, dashboards | ticket creation, auto-recovery, recommender |
| Owner | OH | OH **and** CSM, OH can lock |

Shipped default: **24 — equal to the inactivity threshold**, so the deploy is inert and nothing moves
until an operator decides it should.

## Governance: a reversible veto, not an approval queue

"OH has the final decision" was implemented as **both write; OH can lock and revert** (operator
decision, 2026-08-13). A CSM change takes effect immediately; the OH can lock the key — after which
only the OH writes — and revert to any recorded prior value.

An approval queue was the alternative and was rejected in the decision: it would block the CSM's
day-to-day work waiting on a signature, for a dial whose whole value is that it can be tuned against
this week's field conditions. A lock gives the OH the same final say without that cost.

Two mechanisms carry it:

- **`system_settings` lock columns** (`locked_at`/`locked_by`/`locked_by_role`/`lock_reason`).
  `canWriteSetting` refuses everyone but `OPERATIONS_HEAD` while locked — and never refuses the OH,
  because a lock the locked-out party could lift is not a lock, and one the OH could not lift is
  irreversible.
- **`setting_changes`** — append-only value history carrying the value each change *replaced*.
  `audit_logs` already recorded *that* a setting changed, but has never carried a previous value, so
  it could neither answer "what was this before Tuesday" nor back a revert.

The refusal a locked-out CSM receives carries the lock's **stated reason**, not a bare 403 — a
deliberate governance act must never be indistinguishable from a permissions bug.

## The ladder

Selectable values are exactly the `SLA_BANDS` lower bounds: **4, 8, 12, 24, 48, 72, 120, 168**.

Every choice therefore lands on a boundary the platform already draws, so "assign from 48 h" means
precisely "assign from HIGH_CRITICAL onward", and the queue colour an operator is looking at while
deciding is the same one the threshold speaks in. Free-text hours would allow 37, splitting a bucket
that nothing downstream could render honestly. Enforced in `parseAssignmentThresholdHours`, the single
admission point both the endpoint and the seed go through.

## The load-bearing correctness constraint

`TicketCreationService` and `AutoRecoveryService` are **exact complements** — creation takes silence
at or past the threshold, recovery takes silence below it, so no device is touched by both on one
telemetry pass. `auto-recovery.service.ts`'s own docstring asserts this. The invariant was carried by
`is_inactive` on both sides.

Moving only creation onto the new key breaks it, silently:

> Threshold 12 h. A device silent 18 h → ticketed by creation. Same pass: 18 h is not `is_inactive`
> (24 h has not elapsed) → an unchanged auto-recovery scan takes it as a candidate and closes the
> brand-new ticket as `CLOSED_AUTO_RECOVERY`. Next tick, creation opens it again. Forever. Every
> closure inflates the "self-healing device" figure in the productivity and component reports.
> **Nothing errors.**

Both stages now read the one setting, complementary down to the null case (`gte` excludes NULL hours
in creation; recovery includes them explicitly). `se-assignment-threshold-engine.e2e-spec.ts::complementarity`
is the test that catches a future regression here, in both directions.

## A measured correction

The dispatch-side gate was first written as the natural expression of "withhold only on positive
evidence of being below the threshold":

```ts
NOT: { state: { is: { inactivityHours: { lt: threshold } } } }   // WRONG
```

Probed directly against `fsm_test` rather than reasoned about: Prisma renders the negated to-one
relation filter such that a `device_states` row with `inactivity_hours = NULL` matches **neither the
filter nor its negation**, so every NULL-houred device is silently dropped instead of passing.

| shape | NULL-hours device | no state row |
|---|---|---|
| `NOT: { state: { is: { hours: { lt: 24 } } } }` | ✗ dropped | — |
| `state: { is: { hours: { gte: 24 } } }` | ✗ dropped | — |
| explicit 3-branch `OR` | ✓ | ✓ |

Shipped as the explicit `OR` (measurably at-or-past / measurably unknown / no state row), each branch
verified. The probe spec was deleted after use; the finding is recorded in the code comment so the
"simplification" is not reintroduced.

### Two pre-existing fixture contradictions this exposed

Both only became observable once the services read the hours instead of the flag, and neither state is
producible by `recompute` (which derives the flag **from** the hours):

- `auto-recovery.e2e-spec.ts` seeded an `is_inactive` device at `inactivity_hours: 2` while also
  labelling it `CRITICAL` — a 24–48 h band. Corrected to 30 h, consistent with both.
- `plant-deactivation.e2e-spec.ts` set `latestGpsDatetime` 30 h back but never the derived hours.
  Corrected to carry the figure it implied.

## Ledger and transparency

- `dispatch_runs.withheld_below_threshold`, `dispatch_run_zones.{withheld_below_threshold,
  assignment_threshold_hours}` — withheld tickets counted **apart** from `unassignable`, because
  unassignable means *the engine found nobody* (a coverage/capacity failure someone must act on) while
  withheld means *it deliberately did not look yet* (policy working). Merged, every threshold rise
  would read on the ledger as a fleet-wide dispatch outage.
- The run config snapshot now captures `se_assignment_threshold_hours` **and**
  `inactivity_threshold_hours` — the latter closing a gap the 2026-07-22 full-project audit recorded
  against #124. The pair is only interpretable together: 40 recommended out of a 900-ticket backlog is
  a catastrophe at 24 h and correct at 72 h, and the two runs are otherwise identical on the ledger.

## UI parity (in slice)

Settings is OH-only, and the CSM co-owns this key. Widening the whole console would have handed the
CSM zone/plant/user/company/SLA/scoring CRUD to reach one dropdown, so the single shared control got
its own route instead — `/assignment-threshold`, OH + CSM — while the OH also reaches the identical
control as a Settings tab. Both render one component, so the surfaces cannot drift.

The screen shows three things a bare number field would not: what the choice **does**, phrased against
the live Inactive definition and updated for the *pending* selection; **who holds the key** right now,
with the lock's reason; and **what it used to be**, as revert targets rather than a log.

The ZM reads and never writes (`canEdit: false`), for the same conflict-of-interest reason the
zone-customization proposal gives — they are the graded party. The read is necessary because their
ticket queue badges held work.

`ticket_query` now serves `inactivityHours` so the queue can badge `HELD · 18/48h` on work
auto-dispatch is holding back. **Manual assignment is not blocked** — the threshold gates the engine,
not the operator; a Platinum customer on the phone outranks a grace window.

## Verification

| | |
|---|---|
| New tests | **31** — 14 governance e2e, 5 engine e2e, 12 admin |
| Backend full suite | 1745 passed / 2 failed — both `voucher-controller.e2e-spec.ts`, **confirmed pre-existing** by a `git stash` baseline run that fails identically without this change |
| Admin suite | 480+ passed; the handful of full-run failures all pass in isolation (the documented #156/#184 load-related flake), and every nav/access-matrix-adjacent spec passes |
| `tsc --noEmit` | clean, both apps |

> **Runner note:** the first full-suite invocation was piped through `tail`, which reported
> `exited with code 0` while vitest itself had failures — exactly the exit-code trap INDEX row 28
> (#107) exists to prevent. The verdict above comes from the summary line, not the exit code.

## The one thing that will break if moved

`AssignmentThresholdController` **must** stay registered before `SettingsController` in
`app.module.ts`. Nest matches in registration order, and `PUT /api/settings/:key` also matches
`PUT /api/settings/assignment-threshold`. Registered after it, the governed endpoint is dead — the
write falls through to the generic key writer, which refuses the key — while every service-level test
still passes. Pinned by `se-assignment-threshold.e2e-spec.ts`'s route-order test.
