# 218 — Deployment-lifecycle drift: detection first, then the DI fix

Status: in progress — 218a (detection) + 218b (the fix) landed; the three pre-window deliverables done
(seam assertion, stand-down export, SE-team note); 218c (catch-up window) operator-gated, **not
approved**, no production data written — awaiting explicit operator approval + timing
Type: HITL (operator gates the catch-up window) · Backend
Filed: 2026-08-07
Origin: AutoPlant↔FSM reconciliation against a known-good Excel export
(`audit/autoplant-reconciliation/`), operator-verified by hand before approval
Coordinates with: [#128](./128-device-deployment-lifecycle.md) (owns `device_departures`, the
insert-scope pin and the absence guard — this issue **repairs** its wiring, it does not restate its
semantics) · [#130](./130-*.md) (the three-tier status authority this confirms) ·
[#217](./217-ops-explorer.md) (owns `ReconciliationIdentity`; this adds a ninth identity to it)

## Problem

`MasterSyncService`'s deployment-lifecycle pass has not executed on the Nest-wired path — the
scheduler and the "Run Ingestion Now" API — since the mechanism landed. It fails **silently**: no
error, no log line, and a green CI, because every existing test constructs the service by hand.

Root cause (confirmed in the compiled output, not inferred): `master-sync.service.ts:2-3` import
`DeviceDepartureService` and `PlantEligibleFloatingSeService` with `import type`. TypeScript erases
the import, so `design:paramtypes` in `dist/ingestion/autoplant/master-sync.service.js:364` emits
`Object` for both. Neither parameter carries `@Inject()`, so Nest cannot resolve them, and
`@Optional()` turns that failure into a silent `undefined` — after which `:397`
`if (!this.departures) return;` short-circuits the whole pass.

**Same defect class as `f813b39` (#217, `OpsExplorerQueryDto` import-type erasure).** A repo-wide
scan of 747 files found exactly two silent instances, both in this file.

Only manual CLI runs (`autoplant-sync.ts:68`, which constructs the service by hand) ever did
lifecycle work: runs **64** and **80**. Runs 81–113 recorded `{inserted: 0, updated: 0}`.

### Measured impact (dev DB mirroring production AutoPlant, 2026-08-07)

| | Devices |
|---|---:|
| Missed departures (operational in FSM, UNDEPLOYED at source) | 4,028 |
| Missed restores (departed in FSM, DEPLOYED at source) | 1,130 |
| **Contradicting, excluding `ABSENT_FROM_READ`** | **5,134** |
| Departed with the source row gone — mirror frozen by design | 1,131 |

Downstream: `is_departed` gates inactivity, SLA bucketing, ticket creation, uptime eligibility and
dispatch. **1,050 devices are silent >24 h yet cannot raise a ticket** because FSM believes they are
in a warehouse.

## Slices

### 218a — the contradiction check (DONE)

Detection ships **first and alone**, so the before/after is measured independently rather than
self-reported by the sync that was supposed to be doing the work.

- `AutoPlantHealthService.lifecycleHealth()` — `drift`, `missingFromSource`, `quietRuns`,
  `quietRunsAlert`, `healthy`. Derived entirely in Postgres, so unlike `reconciliationHealth()` it
  stays readable when AutoPlant is unconfigured or the VPN is down. **Not** folded into
  `ReconciliationHealth.entities[]` for exactly that reason — that surface returns `entities: []`
  the moment the source is unavailable, which is when this check matters most.
- `drift` excludes devices with an open `ABSENT_FROM_READ` departure: their source row is gone, so
  the mirror is frozen *by design* and can never agree. They are surfaced as `missingFromSource`
  rather than hidden, which keeps `drift`'s correct value at exactly **0** — any non-zero is a
  defect by construction, not a tolerance to tune.
- `quietRuns` counts consecutive SUCCESS syncs that moved nothing either way. This is the signal that
  sat unread in `entity_stats.departures` for 27 consecutive runs. Threshold via
  `INGESTION_LIFECYCLE_QUIET_RUNS` (default 3), following `readReconMaxDrift`'s convention — a
  *patience* knob, never a tolerance on `drift`.
- Ninth Ops Explorer identity `lifecycleConsistency`, consuming `lifecycleHealth()` rather than
  respelling the predicate, so the two surfaces cannot disagree.

**Baseline reading, captured through the shipped code before any lifecycle change:**

```json
{ "drift": 5134, "missingFromSource": 1131, "quietRuns": 27,
  "quietRunsAlert": true, "quietRunsThreshold": 3, "healthy": false }
```

### 218b — the DI fix (DONE)

Value imports **and** explicit `@Inject()` tokens on both parameters; `@Optional()` kept (load-bearing:
the CLI runner and several tests construct the service with fewer arguments). No cycle introduced —
`master-mapping.ts` is a pure leaf with zero imports and nothing in `org/` imports this module.

> **Correction to the Stage-1 plan, established by experiment.** The plan called dropping `type` "the
> one-line fix" and the `@Inject()` token "redundant once (1) is done". **That was backwards.** The
> declared type is a union (`DeviceDepartureService | null`), and TypeScript erases *any* union to
> `Object` in `design:paramtypes` — independently of import style. Verified by building the
> intermediate variant (value imports, no `@Inject`): **still 4/4 red.** So the token is what makes
> resolution work, and the value import is what makes the token reference a real class instead of
> `undefined`. **Both are required; neither alone suffices.** The third combination —
> `import type` + `@Inject` — does not compile, which is the one loud failure mode of the three.

**Verified through the production graph, not a harness.** `master-sync-di-wiring.e2e-spec.ts` boots
the real `AppModule` — the same graph the scheduler and `POST /api/integration/sync` resolve through
— and overrides **only** `MASTER_SYNC_SOURCE`, which cannot be reached from CI. It asserts both
collaborators resolve, then drives a full DEPLOYED → UNDEPLOYED → DEPLOYED cycle and checks a
departure row opens and then closes with its history intact.

Red-green proof, run in both directions:

| State | Result |
|---|---|
| Pre-fix (`import type`, no `@Inject`) | **4/4 red** — and the behavioural failures reproduce the exact production signature `{ inserted: 0, updated: 0 }` |
| Value imports only, no `@Inject` | **4/4 red** — the correction above |
| Fixed | **4/4 green** |

Regression: **67/67 across 9 files** (including the pre-existing 8-test `device-departure-lifecycle`
and 14-test `dashboard-kpi-reconciliation` suites), `tsc --noEmit` clean.

**No production data written.** The dev-DB lifecycle reading is byte-identical to the 218a baseline
after the fix — `drift 5134 · missingFromSource 1131 · quietRuns 27` — confirming the fix changes
future syncs only and applies no catch-up on its own.

### Gate 3 — read-only rehearsal (2026-08-07). Nothing written.

`npm run autoplant:departure-dryrun` against production AutoPlant. Predicted vs actual:

| Metric | Predicted | Dry-run | Δ | |
|---|---:|---:|---:|---|
| Restores | 1,130 | **1,144** | +1.2% | ✅ |
| Departures via `SOURCE_STATUS` | 4,028 | **3,935** | −2.3% | ✅ (fleet churns ~150/day) |
| **Total departures** | ~4,030 | **5,240** | **+30%** | ❌ **see below** |
| Tickets force-closed | 3,709 | **4,383** | +18% | ❌ consequence of the above |

**Why the total was wrong — my forecast was structurally blind to the absence class.**
The 4,028 came from a *mirror-based* query: `NOT is_departed AND vehicles.status NOT IN
('DEPLOYED','ACTIVE')`. But a device whose source row has vanished keeps a **frozen mirror still
reading `DEPLOYED`** — so it *agrees* with `is_departed = false`, and **no mirror-based query can see
it**. The absence path keys on membership of the source read, not on mirror status. That is the same
frozen-mirror mechanism recorded in #220, seen from the other side: I documented it at Gate 2 and
failed to carry its implication into the departure forecast. The rehearsal is what caught it.

Breakdown of the 5,240: `UNDEPLOYED` 3,889 · **`MISSING_FROM_SOURCE` 1,305** · `MAINTENANCE` 46.
The 1,305 are correct departures — those vehicles have left the estate entirely (#220).

**Known limitation this exposes in 218a:** `drift` cannot detect a *missing* absence departure either,
for exactly the same reason. Only `quietRuns` covers that class. Stated rather than papered over.

**Safety readings.** Absence guard **did not trip**: 1,305 / 19,679 non-departed = **6.63%**, under
the 10% limit — but not far under. Above 10% the entire absence path is abandoned for that run, which
would silently drop all 1,305. Worth watching, not blocking.

**Live-batch exposure:** **1,461 exact** for the SOURCE_STATUS cohort; the absence cohort adds an
**estimated ~300** (unmeasured — pinning it needs a second full source read). Call it ~1,750.

**Nuvista lands where the operator's Excel check expects.** Measured exactly (105 bounded queries):
Nuvista's absence rate is **0.5% (49 devices)** against the platform's 6.6% — its data is far cleaner,
so the +30% surprise is concentrated in other companies (DEPOT_CBT, ESL, SATNA…), not Nuvista.

```
9,437 operational today − 2,438 SOURCE_STATUS − 49 ABSENT + ~755 restores = ~7,705
                                                     Excel Deployed = 7,650  (+0.7%)
```

### Falsifiable post-window predictions (the independent re-measure)

| Reading | Expected after the window |
|---|---|
| `lifecycle.drift` | **0** |
| `lifecycle.missingFromSource` | ~2,436 (1,131 + 1,305) |
| `lifecycle.quietRuns` | **0** |
| FSM operational, Nuvista | **~7,705** vs Excel 7,650 |
| The 10 Check-7 vehicles | `isDeparted` → **false** |

### Pre-window deliverables (DONE 2026-08-07) — the three owed from the Stage-2 approval

**1. The notification seam is asserted programmatically.** `npm run autoplant:window-preflight`
(`src/ingestion/autoplant/window-preflight.ts`), wired into FIX-PLAN §7.5 as **step 4**, run
immediately before the live pass. Read-only; exit code is the contract (0 = proceed, 1 = STOP). It
boots the **real `AppModule`** and checks two things: the bound `NOTIFICATION_CHANNEL_GATEWAY` is
still the inert `LoggingChannelGateway` *and* returns `UNAVAILABLE` on all four external channels
(PUSH/SMS/WHATSAPP/EMAIL), and `INGESTION_SCHEDULER_ENABLED` is not `"true"` — re-verifying §7.5 step 1
at the moment it matters instead of trusting an earlier reading.

> **Identity is checked before behaviour, and that ordering is the safety property.** An unrecognised
> gateway is rejected **without being invoked**: probing an unknown adapter to find out whether it
> sends *is* the send this gate exists to prevent. Behaviour is then probed anyway on the binding we
> do recognise, because a same-class gateway whose behaviour changed would otherwise pass on its name
> alone. Both cases are pinned — one spec uses a gateway that counts touches, another a subclass that
> keeps the `instanceof` identity while replacing the send.

Both paths exercised for real, not just unit-tested: the clean run exits 0; forcing
`INGESTION_SCHEDULER_ENABLED=true` exits 1 with `🛑 DO NOT RUN THE CATCH-UP WINDOW`.

**2. The live-batch stand-down list is exported, and both cohorts are now exact.**
`npm run autoplant:departure-dryrun -- --export-standdown <path>.csv` — folded into the existing
read-only dry-run rather than shipped as its own command, because the export needs the departure plan,
the plan needs the full ~26k-row source read, and that read is capped at 90 rows/query by the AutoPlant
DBA. A second command would cost a second full read *and* risk the two disagreeing across ~150
vehicles/day of churn.

| | Gate 3 (estimate) | Export read (measured) |
|---|---:|---:|
| SOURCE_STATUS cohort | 1,461 | **1,395** |
| Absence cohort | ~300 *(estimated)* | **296** |
| **Total live-batch tickets** | ~1,750 | **1,691** across **234** batches |

The ~300 absence estimate was good. The SOURCE_STATUS side moved −66 because this is a fresh read ~8 h
later. `buildStandDownRows` imports `TERMINAL_TICKET_STATUSES` from `device-departure.service` rather
than respelling the predicate, so the exported set is **by construction** the set the window closes —
the same anti-drift move 218a made by consuming `lifecycleHealth()`.

**3. SE-team note drafted** — `audit/autoplant-reconciliation/SE-TEAM-NOTE.md`, for the operator to
send. Carries the exact closure signature (`closure_type = 'DEVICE_UNDEPLOYED_CLOSE'`) so the team can
isolate the whole set from a query, and states plainly that closure is one-way and batch rows are not
touched. Timing line is a placeholder.

**The Gate-3 figures held on an independent second read** (read-only, production AutoPlant, ~14:05 IST):

| | Gate 3 | Export read | |
|---|---:|---:|---|
| Total departures | 5,240 | **5,238** | UNDEPLOYED 3,886 · MISSING_FROM_SOURCE 1,306 · MAINTENANCE 46 |
| Tickets force-closed | 4,383 | **4,382** | |

±1–2 across ~8 h is fleet churn, not instability.

**Superseded figures in `FIX-PLAN.md` §7.1**, now marked there: 3,709 tickets closed → **4,383**, and
backlog landing "around 14,100" → **~13,400**. Both predate the discovery that the forecast was
structurally blind to the absence class.

New specs: `notification-seam-assertion.e2e-spec.ts` **5/5**, `stand-down-export.e2e-spec.ts` **11/11**;
`tsc --noEmit` clean. **No production data written.**

### 218c — the catch-up window (OPERATOR-GATED, NOT APPROVED)

~4,030 departures + ~1,130 restores in one pass. **3,709 open tickets force-closed**, 1,461 of them
on live dispatch batches; ~1,100 new tickets created for restored devices already silent >24 h.
No human is notified (`LoggingChannelGateway` returns `UNAVAILABLE` for every external channel), but
ticket rows are live and actively written. Read-only `autoplant:departure-dryrun` gates it.
Full procedure: `audit/autoplant-reconciliation/FIX-PLAN.md` §7.

## Follow-ups filed separately

- **#219** — F5: Excel/source row gap (1,251 rows) still unexplained
- **#220** — `mst_vehicle` hard-deletes: 79% of absent devices had rows removed outright, no tombstone
- **#221** — lint rule for the `import type` DI-erasure class + the 13 `@Optional()` params
- **#222** — F2 telemetry staleness (~5.1 h) · **#223** — F3 never-reported devices counted healthy
