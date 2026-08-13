# 230 — A partial telemetry ingest silently manufactures fleet-wide inactivity; run 153 opened 3,439 phantom tickets

Status: ready-for-human — **the guard (item 1 + item 3) is IMPLEMENTED 2026-08-10; see "§ Implemented".
Items 2, 4, 5 and the remediation of the 3,439 existing cycles are still open.**
Type: HITL (it corrupts the operational picture every ZM and OH reads) · Backend
Filed: 2026-08-10
Origin: measured while diagnosing an operator report of *"inaccurate data on the dashboard"*, 2026-08-10.
Coordinates with: [#229](./229-auto-recovery-sweep-unwired.md) (same run triggered the auto-recovery
pre-check) · [#231](./231-manual-pipeline-trigger-ungated.md) (how that run was started) ·
[#228](./228-guard-pattern-remediation.md) (**same class**: a mechanism that fails toward a confident
wrong answer instead of failing loudly) · [#222](./222-telemetry-staleness.md)

## Problem

**`DeviceStateService.recompute()` recomputes every device in the mirror, including devices the
telemetry read never reached.** For an unreached device its stored `latest_gps_datetime` is whatever
the last successful run left, so wall-clock time alone carries it past the inactivity threshold. The
device is then marked `is_inactive`, given an SLA bucket, and handed to ticket creation — which opens
a Failure Cycle and a Troubleshoot Ticket for a device **nobody actually checked**.

A partial ingest therefore does not produce *less* data. It produces *confidently wrong* data, at
fleet scale, indistinguishable on every dashboard from a genuine outage.

## Evidence — run 153, 2026-08-10 **[MEASURED against live `fsm`]**

An operator triggered `POST /integration/run-pipeline`. Master sync 117 SUCCESS (07:32–07:37 UTC),
then snapshot run **153**, finished 07:40:36 UTC, status **`PARTIAL`**.

| | |
|---|---:|
| Devices in the FSM mirror | **27,032** |
| Devices run 153 fetched telemetry for | **2,610 (9.7%)** |
| Ping rows written by run 153 | 2,610 |
| Chunks recorded | 29, **all `SUCCESS`** |
| Failure cycles opened immediately after | **3,439** |
| — on devices run 153 **did** refresh | **14** |
| — on devices run 153 **never read** | **3,425 (99.6%)** |

**The run is `PARTIAL` with zero failed chunks**, which by `snapshot-ingestion.worker.ts:109-118` is
reachable only through the `readError` branch: the source scan threw mid-drain (29 chunks × the
pipeline's `chunkSize: 90` = exactly 2,610 rows) and the run finalised on what it had.

Resulting fleet picture, all of it downstream of that one aborted read:

| `device_states` | |
|---|---:|
| `is_inactive` | 14,629 |
| `has_open_failure_cycle` | 15,057 |
| Devices 60–120 h since their last known ping | **15,765** |
| `SEVERE` bucket | 11,596 |
| `LONG_PENDING` | 2,504 |

**Cross-checked against the source (AutoPlant `ap_widgets.tb_vehiclemaster`):
19,806 of 56,588 devices pinged within the last 6 hours.** A large share of the devices FSM now calls
inactive are demonstrably alive. The open book went 12,571 → **15,057** on the strength of a read that
covered under a tenth of the fleet.

## Not the cause — checked and cleared

- **Timestamp/timezone skew (#222) is behaving.** `raw_device_snapshots` future-dated rows: **0**.
  `device_states` with negative `inactivity_hours`: **0**. In AutoPlant only **5 of 56,588** rows sit
  ahead of `UTC_TIMESTAMP()` (the known IST-writer devices, dropped by the skew guard). `MAX()` on
  that column reads 5.5 h ahead purely because of those 5 — the trap #222 documents; percentiles show
  the column is UTC for everyone else.
- **The ingest is not merely "stale".** Staleness would be uniform and visibly old. This is worse:
  the run *succeeded loudly enough* to stamp a fresh `data_as_of` (2026-08-10 13:09 IST) and drive
  ticket creation, while 90% of the fleet's evidence was never fetched.

## Why this is the #228 class

Three separate mechanisms each behaved "reasonably" and composed into a wrong answer:

1. The worker correctly finalises `PARTIAL` rather than losing the run — **but records the read error
   nowhere.** `snapshot_runs` has no error column for it; the only trace is a log line already rotated
   past. The status alone cannot tell an operator *how much* was missed.
2. Recompute correctly derives inactivity from `latest_gps_datetime` — **but has no notion of "this
   device's evidence is not from this run"**, so it cannot distinguish "silent" from "unread".
3. Ticket creation correctly acts on `is_inactive` — and cannot know it was fabricated.

No component is individually wrong. The composition is.

## What to build

1. **Recompute must not age devices the run did not cover.** Options, in preference order:
   (a) pass the run's covered `device_id` set into `recompute()` and leave uncovered rows untouched
   (their `computed_at` then honestly lags, which is the correct signal); (b) refuse to recompute at
   all on a `PARTIAL` run below a coverage threshold; (c) recompute but suppress *transitions into*
   `is_inactive` for uncovered devices. **(a) is the honest one** — the others hide the gap differently.
2. **Persist the read error and the coverage ratio on `snapshot_runs`** (`read_error`,
   `devices_covered`, `devices_expected`). A `PARTIAL` that covered 9.7% and one that covered 99.7%
   are not the same event and must not present identically.
3. **Gate ticket creation on ingest coverage.** A pipeline pass whose telemetry covered under some
   threshold (start strict, e.g. 90%) must not open Failure Cycles at all — log a typed refusal.
4. **Surface `data_as_of` honestly on the dashboard**: it currently advances on a 9.7% read, so the
   freshness banner actively reassures during exactly the failure this issue describes.
5. **Root-cause the abort itself** (separate from the blast radius). **[MEASURED 2026-08-10]** — the
   reader's exact keyset scan was replicated read-only against AutoPlant and **completed cleanly**:
   **629 pages, 56,591 rows, 1,289 s (21.5 min)**. So run 153's abort was **transient, not
   deterministic** — there is no poison row at page 30. But the timing is sharply uneven:

   | Pages | Elapsed | Rate |
   |---|---:|---:|
   | 1 – 29 | 139.7 s | **4.8 s/page** |
   | 29 – 31 | ~24 s | **~12 s/page** |
   | 100 – 200 | 455.6 s | 4.6 s/page |
   | 400 – 500 | 71.0 s | 0.71 s/page |
   | 500 – 600 | 37.5 s | **0.375 s/page** |

   **Run 153 died at page 30 — inside the slowest region, where pages run 10–30× slower than the tail.**
   A per-query or connection timeout is therefore the leading hypothesis, not bad data. Actions:
   (a) set and log an explicit query timeout so the failure names itself instead of surfacing as a bare
   `PARTIAL`; (b) retry the *read* with backoff, as chunk *writes* already are — today a single read
   throw ends the whole scan while a write failure gets three attempts; (c) revisit `chunkSize: 90`,
   which forces **629 sequential round trips** and ~21 min of continuous VPN dependency for one pass —
   the DBA cap is ≤100/query, so 90 is near-maximal and the real lever is (b) plus resumable
   continuation from the last scanned `device_id` rather than restarting the scan.

   Note also: 56,591 rows this pass vs 56,588 measured minutes earlier — the source churns during the
   21-minute scan, so a run is **not** a consistent snapshot of the fleet. Harmless at this magnitude,
   but it means "covered the whole fleet" is always approximate.

## Remediation of the damage already done

The 3,439 cycles/tickets opened by run 153 are **not** field reality and must not be dispatched.
A complete ingest followed by a recompute will show most of those devices active again — but their
Failure Cycles are already open, so they need either the auto-recovery pre-check (#229, which closes
exactly this shape once the device is seen healthy) or an explicit reversal. **Decide before the next
dispatch run**, or SEs will be sent to ~3,400 working devices.

## Implemented — 2026-08-10 (items 1 and 3)

**The design changed on one measurement.** "What to build" item 1(a) proposed passing the run's covered
`device_id` set into `recompute()` and leaving uncovered rows untouched. **That approach is unsound
here**, and the reason matters: `SnapshotIngestionService.ingestChunk` writes
`createMany({ skipDuplicates: true })` against a `(device_id, gps_datetime)` UNIQUE, so a device that
*was read* but has not pinged since the last run produces **no row for this run**. "Has a
`raw_device_snapshots` row for run N" therefore means **new ping**, not **was read** — and a per-device
coverage filter built on it would refuse to age exactly the genuinely-silent devices the platform
exists to catch. Wrong in the dangerous direction.

*(This also refines the §Evidence figure: the "3,425 tickets on devices run 153 never fetched" join
measures devices with no **new ping row**. The hard bound on coverage is the chunk arithmetic —
29 chunks × 90 = 2,610 source rows scanned of 56,588 — which stands independently.)*

**So the gate is the run's own SUCCESS/PARTIAL verdict**, which was already correct and already
recorded. Nothing new had to be measured; what was missing was anyone *consulting* it before writing.

| Change | |
|---|---|
| `DeviceStateService.recompute(now, trigger, { skipDerivation })` | Step 1 (ensure a row per device) still runs — that is not a derivation and cannot be wrong. The derive UPDATE, the ledger and the canary are skipped, so `inactivity_hours` / `is_inactive` / `sla_bucket` / `computed_at` keep their last-good values. Returns `{ upserted, derived }`. |
| `IntegrationSyncService.runPostIngestStages()` | New shared stage: `ingestComplete = snapshot.status === 'SUCCESS'`. When false, derivation, the auto-recovery pre-check **and** ticket creation are all skipped, with a loud WARN. Shared by `ingestTelemetry()` **and** `runPipeline()` — gating only the cron would have prevented nothing, since #231's ungated OH trigger is the path that actually fired. |
| `PipelineSummary.ingestComplete: boolean` | A typed field, not a log line — "we chose not to act" and "there was nothing to do" must not look identical downstream (#228 R3). |

`computed_at` deliberately lagging is the point: the dashboard shows **stale-but-true** instead of
**fresh-and-fabricated**, and the staleness is visible rather than inferred.

**Tests:** 4 pipeline cases (PARTIAL and FAILED both refuse on both entry points; SUCCESS still runs
everything, so the gate is not a blanket off-switch) + 2 device-state cases — the key one advances the
clock 500 h under `skipDerivation`, asserts the device does **not** become inactive, then re-runs the
same clock **without** the guard and asserts it does, so the test cannot pass vacuously.

**Not covered by this change:** items 2 (persist `read_error` / coverage on `snapshot_runs` — needs a
migration), 4 (`data_as_of` still advances on a partial read, so the freshness banner still reassures),
5 (why the scan aborts), and the remediation of the 3,439 cycles already open.

## Acceptance criteria

- A `PARTIAL` ingest covering a fraction of the mirror does **not** flip uncovered devices to
  `is_inactive` — asserted by test with a fault-injected source reader.
- `snapshot_runs` records the read error and coverage; `/integration/health` surfaces both.
- Ticket creation refuses to run below the coverage threshold, and says so in the pipeline summary.
- The 3,439 run-153 cycles are resolved (closed or confirmed genuine) and the decision recorded here.

## Blocked by

Nothing. Ordering: this should land **before** `INGESTION_SCHEDULER_ENABLED` is turned on, because a
scheduled pipeline repeats this failure mode every 30 minutes unattended.
