# 228 — Every guard in this system is one-directional, and each fails toward "fine"

> **Scope widened 2026-08-10 by a fifth specimen ([#229](./229-auto-recovery-sweep-unwired.md)).** The
> title says *guard*; the property is broader. What all five specimens share is that **non-execution is
> observationally identical to execution with nothing to do** — a guard that never rejects, a pass that
> returns early, and a sweep that is never called all emit exactly nothing. Read "guard" below as "any
> mechanism whose silence is indistinguishable from success".

Status: needs-triage
Type: HITL (changes testing/observability posture across the backend) · Backend tooling + tests
Filed: 2026-08-07
Origin: `audit/cross-analysis.md` §4 — the cross-cutting finding from three defects found in two days.
Coordinates with: [#218](./218-lifecycle-drift-detection.md) · [#221](./221-import-type-di-erasure-lint.md)
(the lint half of remedy 3 — **do not duplicate it here**) · [#222](./222-telemetry-staleness.md) ·
[#223](./223-ndd-counted-healthy.md) · [#217](./217-ops-explorer.md) (owns `ReconciliationIdentity`)

## The finding

Three defects, found in two days, in unrelated subsystems. Each produced correct-looking output,
threw no error, and passed CI. That is not a coincidence — look at what each one's supposed safety
mechanism actually checks:

| Defect | The guard | Direction it checks | Direction the bug travelled |
|---|---|---|---|
| **[#218](./218-lifecycle-drift-detection.md)** — dead lifecycle pass | `@Optional()` + `if (!this.departures) return;` | *Is the dependency present?* Absent → `undefined` → **early return reported as success** | Absent |
| **[#223](./223-ndd-counted-healthy.md)** — NDD counted healthy | `reconciliation.service.ts:205`: `healthy + inactive = operational` | Are the counts consistent? | The two predicates are **literal complements** — a tautology |
| **[#222](./222-telemetry-staleness.md)** — 5.5 h shift | `mapping.ts:168`: reject if `gpsDatetime > now + skew` | Timestamps in the **future** | Timestamps in the **past** |

**Not one of the three can fail in the direction its own bug travels.** The guard was written against
the failure the author imagined; the failure that occurred was its mirror image.

They are **not the same bug** — a DI/compilation issue, a domain-modelling gap, and a source-contract
error. What they share is a failure *mode*, and that is one thing, and it is fixable.

### The reconciliation check is the clearest specimen

`reconciliation.service.ts:213` says so out loud:

> *"The two predicates are literal complements within one SQL fragment, so a mismatch here is not a
> data problem — it means `FLEET_COUNT_COLUMNS` itself has been edited such that healthy is no longer
> `NOT(inactive)`."*

The author knew it was tautological and shipped it in a panel labelled **reconciliation**. It has
been green, continuously, over 913 misclassified devices.

**The precise problem is not that a check cannot fail on data.** Some invariants are worth keeping
purely as regression guards — this one genuinely does catch a developer editing the SQL, which is a
real thing to catch. **The problem is that a tautological check was occupying the slot where a real
one should have been, under a label that claimed otherwise.** The remedy is to *relabel and
supplement*, not to delete. Keep it as `structuralComplement` (a code-edit guard, honestly named);
add a real reconciliation beside it.

### The compounding half — nothing re-measures the world

Every one of these survived because the system only ever tests itself against its own assumptions:

- `apps/backend/test/autoplant-mapping.spec.ts:131` asserts `expect(AUTOPLANT_UTC_OFFSET_MIN).toBe(330)`
  — **a test that pins a wrong constant** and would have gone red on the correct fix. It tests that
  the code says what the code says.
- Every mapping/normalisation test constructs its own input rather than reading the live source, so a
  source contract that was never true could not be falsified.
- Every `MasterSyncService` test constructs the service by hand, bypassing Nest DI — precisely the
  layer where #218 lived.
- `docs/kpi-definitions.md` records `Live value: 13,939 pan-India` — a number copied in, never
  re-derived.

### And a third, narrower trap: `MAX()` as a contract probe

`MAX()` over 56,564 rows is decided by the single most anomalous row. **Five misbehaving devices
defined this integration's timezone contract for a month** (#222). The trap fired three separate
times during that investigation — including once on the investigator. Any freshness or contract probe
must use percentiles over the population, never an extreme.

### A fourth specimen: the skew guard turns dead devices into permanently healthy ones (2026-08-09)

Found while correcting P6 on [#222](./222-telemetry-staleness.md). Same shape as the three above, in a
mechanism unrelated to any of them — which is why it belongs here and not only in #222.

`mapping.ts:168` rejects a ping only when it is **ahead** of now, and only past a 24 h tolerance
(`DEFAULT_MAX_SKEW_MINUTES`, `mapping.ts:34`, which no caller overrides). So when #222 sets the offset
to `0`, the ~5 devices that genuinely write IST land **5.5 h in the future** — comfortably inside the
tolerance, therefore accepted. Downstream, `device-state.service.ts:100` computes
`GREATEST(0, now − latest_gps_datetime)`, and the clamp that exists to absorb clock skew swallows the
negative outright. Those devices then read `inactivity_hours = 0` **forever**: never inactive, never
SLA-bucketed, never ticketed, no matter how long they actually stay dark.

The pattern, stated precisely: **a guard that only rejects one direction, feeding a clamp that erases
the other.** #222 (and an earlier draft of this issue) assumed the guard would *drop* these devices —
a visible failure. It does the opposite. A dropped device leaves a gap someone can notice; a
permanently-fresh device is indistinguishable from a healthy one and is invisible by construction.

This is the fourth independent mechanism producing the same reading:

| # | Mechanism | Absence read as |
|---|---|---|
| 1 | Reconciliation check compares a mirror to itself | "no drift" |
| 2 | NDD — never-reported devices counted in the healthy denominator ([#223](./223-ndd-counted-healthy.md)) | "healthy" |
| 3 | Deployment-lifecycle pass dead under Nest DI ([#218](./218-deployment-lifecycle-di.md)) | "nothing to do" |
| 4 | One-directional skew guard + `GREATEST(0, …)` clamp | "always fresh" |
| 5 | Auto-recovery sweep never wired to any caller ([#229](./229-auto-recovery-sweep-unwired.md)) | "nothing to close" |

Note that specimen 4 is **latent** — it activates only when #222 flips the constant. That makes it the
cheapest of the four to fix, and the only one that can still be fixed *before* it does any damage.
It is also the argument for R2 and for #222's two-directional guard being decided together rather than
sequentially: fixing the timezone without fixing the guard converts a fleet-wide 5.5 h error into five
permanently invisible devices.

### A fifth specimen: the sweep that was never wired (2026-08-10) — and it widens the thesis

[#229](./229-auto-recovery-sweep-unwired.md). `AutoRecoveryService.runAutoRecovery` has **no production
caller** — no `@Cron`, no route, no CLI; its only call site in the repository is
`test/auto-recovery.e2e-spec.ts`. Confirmed at the data, not inferred: across **42,955 `ticket_events`
transitions there are zero `CLOSED_AUTO_RECOVERY` rows**. **11,042 of the 12,571 open TROUBLESHOOT
tickets (87.8%) already satisfy the sweep's own predicate**, 9,888 of them on devices that are healthy
right now. The open queue overstates real field work by roughly 9,888 tickets, and that 12,571 figure
is quoted as a baseline in both #222 and #223.

**This is admitted as a specimen, but it is NOT another instance of the existing pattern — it is a
generalisation of it, and the difference matters for the remedies.**

The first four specimens share a shape: *a check exists and cannot fail in the direction its bug
travels.* #229 has no check to be one-directional. Nothing was skipped, mis-scoped or wrongly
asserted; a mechanism was simply never connected, and eleven of its twelve sibling sweeps were.

What it shares — and this is the deeper property all five have — is that **non-execution is
observationally identical to execution with nothing to do.** A sweep that runs and closes zero tickets
and a sweep that never runs emit the same thing: no log line, no metric, no row. That is the same
reason `@Optional()` absence looked like presence, a tautology looked like a passing check, and a
skew guard that never rejected looked like a clean feed. The system cannot distinguish *"checked and
fine"* from *"never checked"* — and every one of these five defects lived in that gap.

So the title's framing — *"every **guard** is one-directional"* — is too narrow by one word. The
property is not specific to guards; it applies to **any mechanism whose non-execution is silent**.
A guard is just the case where the silence is easiest to mistake for good news.

**The remedies below already cover it, which is corroboration rather than coincidence.** **R3**
(*"nothing happened" must be distinguishable from "nothing to do"*) is exactly #229's fix stated in
advance — it was written about a pass returning early, and applies unchanged to a pass never invoked.
**R4** (boot-time resolution assertion) is the right *shape*, extended one step: assert not only that
every `@Optional()` collaborator resolved, but that **every sweep-shaped service has a registered
trigger**. That is a cheap widening of a test #228 already wants to write, and it would have caught
this on the day auto-recovery was built.

**Do not fold #229's fix into this issue.** Wiring the sweep is an 11,042-closure event against a
12,571-ticket open book and is operator-gated with its own dry-run, agreed count and window (#229
"Gating posture"). #228 owns the *class*; #229 owns the *event*.

**Worth a pass, not assumed:** R4's widened form implies an audit for other never-invoked sweeps.
`FleetUptimeAggregationService` and `VerificationService` both document themselves as on-demand with
no scheduler — deliberate and written down, unlike this one. Whether any others are undocumented-unwired
is unmeasured, and is #229's D4.

## Proposed remedies

Four, in descending value. **Sizeable — expect this to be split into slices.**

### R1 — Make one invariant per subsystem falsifiable against reality; relabel the tautologies

`healthy + inactive = operational` becomes `healthy + inactive + neverReported = operational` under
#223 — **still a tautology** if the three predicates remain literal complements. Add beside it a
check against an independent source: *the operational device count for a plant matches what AutoPlant
reports for the same plant, within a stated tolerance.* `AutoPlantHealthService` already does
source-vs-FSM reconciliation (#217 S3) — extend it rather than building a second mechanism.

Audit the other eight `ReconciliationIdentity` entries and label each **structural** (code-edit guard)
or **empirical** (can fail on data). If a subsystem has only structural ones, that is the gap.

### R2 — A source-contract monitor, per run, on distributions not extremes

One assertion would have caught #222 on 2026-07-07: **p50 of `run.finished_at − normalized_gps` must
be under 1 hour.** It has been 5.58 h on all 95 runs.

Generalise: record a distributional fingerprint per ingested field per run (p01/p50/p99, null rate,
row count) and alert on drift against the trailing window. This also catches
[#226](./226-null-gps-over-real-telemetry.md)'s null-over-real-telemetry as a null-rate step.

### R3 — "Nothing happened" must be distinguishable from "nothing to do"

#218 returned early and reported success; NDD devices produce no ticket and no signal. A pass
processing zero records should emit a **typed** zero — `SKIPPED_DEPENDENCY_MISSING` vs `NO_WORK` —
and any sweep whose output is *structurally* zero should be loud.

The `@Optional()`-without-`@Inject()` lint is **already owned by
[#221](./221-import-type-di-erasure-lint.md)** — that half is filed, do not restate it. What is *not*
covered there is the typed-zero convention across the sweeps.

### R4 — A boot-time DI smoke test

Instantiate the real Nest application context and assert every `@Optional()` collaborator expected in
production actually resolved. **One test file**, and it kills the entire #217/#218 class permanently —
including the 13 `@Optional()` parameters #221 catalogued, which are currently verified by reading
rather than by execution.

Cheapest item here relative to what it prevents. If only one thing ships, ship this.

## Explicitly out of scope

- **"Delete checks that cannot fail on data."** Rejected. Structural guards have real value as
  regression protection. The defect is mislabelling, not existence.
- Rewriting the existing test suite. R2/R4 add instruments; they do not re-litigate coverage.

## Risks

- **R2 will be noisy at first.** Thresholds need a trailing baseline before they alert, or it becomes
  another ignored signal — which is the same failure mode one level up.
- **R1 is the largest and least defined.** The independent-source check depends on AutoPlant
  availability, so it cannot be a hard CI gate; it is a monitor, not a test.

## Open question

Should R2's fingerprints live in a new table or extend `snapshot_runs.chunk_stats`? The latter is
cheaper and already per-run; the former is queryable across runs without JSON extraction. Not decided.

## Acceptance

- R4 shipped: a DI-booted test asserting every production-expected `@Optional()` collaborator resolves.
- Every `ReconciliationIdentity` labelled structural or empirical; at least one **empirical** identity
  exists for the device-state subsystem.
- R2 recording per-run distributional fingerprints, with the p50-GPS-lag assertion live and green
  after [#222](./222-telemetry-staleness.md).
- Typed-zero outcomes on the sweeps that can currently return a silent zero.
- A short note in `docs/agents/` recording the `MAX()`-as-probe trap, so the next investigation does
  not repeat it a fourth time.
