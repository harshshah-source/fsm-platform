# 222 — FSM shifts every GPS ping 5.5 h into the past (`AUTOPLANT_UTC_OFFSET_MIN` is wrong)

Status: **done 2026-08-09** — shipped as one slice with [#223](./223-ndd-counted-healthy.md).
Constant flipped, pinned test replaced by a contract test, two-directional skew guard shipped in the
same release (P6), provenance comment corrected. The **expected auto-recovery closure count is recorded
below, measured before any code changed** — the operator's blocking gate — and answering it produced
[#229](./229-auto-recovery-sweep-unwired.md).
**One acceptance criterion is not locally verifiable:** "after a recompute, per-run
`p50(finished_at − gps_datetime)` < 1 h" needs a post-fix snapshot run against AutoPlant, which is
VPN-gated and sits behind the same operator gate as #218c. The code change that produces it is landed
and tested; the measurement is owed on the first real run.
Type: AFK · Backend ingestion
Filed: 2026-08-07
Origin: AutoPlant↔FSM reconciliation, finding **F2**
(`audit/autoplant-reconciliation/reconciliation-report.md`)
**Re-diagnosed 2026-08-07** by the independent PRISM read + cross-analysis
(`audit/prism-independent/`, `audit/cross-analysis.md`). The original diagnosis on this issue was
wrong; see "Correction" below.
Coordinates with: [#223](./223-ndd-counted-healthy.md) (the two defects move Fleet Health in opposite
directions and must ship together) · [#228](./228-guard-pattern-remediation.md) (the guard class that
let this survive)

## Correction — what this issue used to say, and why it was wrong

This issue originally concluded:

> **This is not a timezone bug** — that was tested and ruled out. The offset is ~5.1 h, not the
> 5 h 30 m an IST double-conversion would produce […] FSM's conversion is correct; its *data* is old.

**That is wrong.** It is a timezone bug, the conversion is wrong, and the data was fresh. The
reasoning failed because the measurement compared FSM against the **Excel snapshot** rather than
against the live source, and the two were read **25 minutes apart**.

Reconstructing the original numbers under the timezone hypothesis:

- Excel snapshot instant `06:49:21 IST` = **01:19:21 UTC**.
- FSM snapshot run 151 finished **01:45 UTC** — ~25 min later.
- **Frozen device** (stopped pinging before both reads): both systems see the same source value `V`.
  Excel renders `V` correctly, FSM stores `V − 5:30`. Delta = **exactly 5.5000 h**.
- **Live device:** Excel captured `≈01:19 UTC`; FSM read `≈01:44 UTC` and stored `01:44 − 5:30`.
  Delta = **5 h 05 m ≈ 5.10 h**.

Against the distribution this issue reported — `min -5.50 · p05 -5.50 · p50 -5.10 · p95 -5.05` —
every feature is predicted: a **hard floor at exactly −5.50** (frozen devices), a **median at −5.10**
(live devices, offset by the read gap), and a **total spread of ~27 min** matching the gap between
the two reads. The floor reported as `min`/`p05` *was the bug's signature*. Staleness cannot produce
it: stale data yields a long tail, not a wall at exactly 5.50 h.

The supporting detail was also inverted: *"run 151 completed at 07:15 IST yet the freshest GPS is
01:44 IST."* `07:15 IST − 5:30 = 01:45 IST`. **The "staleness" was the shift, to the minute.** And
run 151 was not an incomplete pass — it wrote **20,578 rows**, in line with every healthy run.

## Problem

`apps/backend/src/ingestion/autoplant/mapping.ts:15`

```ts
/** AutoPlant source timestamps are naive IST (+330). */
export const AUTOPLANT_UTC_OFFSET_MIN = 330;
```

`normalize.ts:32` subtracts that offset. But `ap_widgets.tb_vehiclemaster.latest_gps_datetime` is
stored in **UTC**, so FSM writes every ping 5.5 h earlier than it happened, inflating
`inactivity_hours` fleet-wide.

Source probe re-run by hand 2026-08-07:

```
@@system_time_zone    UTC
NOW()                 2026-08-07 11:48:30
UTC_TIMESTAMP()       2026-08-07 11:48:30     TIMESTAMPDIFF = 0 sec
```

Host wall clock at that instant: `11:48:31 UTC` / `17:18:31 IST`. Server clock accurate to the second.

## The source never changed — the original verification measured five outlier devices

`mapping.ts:17-30` documents a live verification on 2026-07-17 that appeared to show the column
tracking IST:

> *newest `latest_gps_datetime` **11:49:46** · real IST wall clock **11:50***

"Newest" = `MAX()`. Counting devices whose value sits **ahead of UTC-now** (impossible for a UTC
column):

| Bucket | Devices |
|---|---:|
| `> UTC_now + 5h` — IST-stored, fresh | **4** |
| `> UTC_now` — IST-stored, older | **1** |
| within last 24 h UTC | 21,245 |
| older than 24 h UTC | 35,314 |

**Five devices out of 56,564** (plants `GSR`, `SCNEL GHY CEMENT`, `ACC CEMENT LIMITED-LONI KALBHOR`)
genuinely write IST into a UTC column, and they alone decide `MAX()`. Today the same probe gives
`17:18:16` against an IST wall clock of `17:18:31` — a 15-second gap, versus 14 seconds on
2026-07-17. **Identical signature, one month apart.** The 2026-07-17 verification generalised from a
maximum to a population.

### Decisive proof: the contract never moved

`raw_device_snapshots.gps_datetime` stores the **post-conversion** value and `snapshot_runs` records
when each run ran, so per-run `percentile(finished_at − gps_datetime)` time-travels the contract.
(`MAX()` must not be used here — it selects the same IST outliers and the lag looks like ~0.03 h on
every run. That trap fired three separate times during this investigation.)

| Run | Finished (UTC) | Rows | p50 lag | p10 lag | p01 lag |
|---|---|---:|---:|---:|---:|
| 2 | 07-07 04:51 | 21,945 | 5.592 | 5.552 | 5.536 |
| 26 | 07-08 06:29 | 18,627 | 5.594 | 5.565 | 5.552 |
| 91 | 07-21 11:23 | 19,109 | 5.582 | 5.541 | 5.527 |
| 107 | 07-29 12:32 | 19,263 | 5.571 | 5.552 | 5.532 |
| 148 | 08-06 05:01 | 21,055 | 5.606 | 5.549 | 5.531 |
| **152** | **08-07 10:02** | **20,466** | **5.571** | **5.542** | **5.534** |

**95 runs measured, every one in the 5.52–5.65 h band. Flat, no discontinuity, including across
2026-07-17.** FSM has over-subtracted since the first snapshot run on 2026-07-07. **`+330` was wrong
when it was written.** There is no vendor change to chase and no announcement to find.

Device-level confirmation, run 152 (ran 09:58–10:02 UTC):

| device | source raw (at probe time) | FSM stored (UTC) | reading |
|---|---|---|---|
| 867542081342639 | 11:50:38 | 04:31:09 | source ≈10:01 at run time → **stored = source − 5:30** ✗ |
| **860103064768360** | **17:20:15** | **09:58:34** | IST-writer: 15:28 IST at run time → 09:58 UTC ✓ correct |

Lag bimodality on the newest run: **4** devices `<1h` (IST-writers, `+330` correct) · **18,486** at
5.0–6.0 h (UTC-writers, over-subtracted) · 1,976 `>6h` (genuinely stale).

## Impact (measured 2026-08-07, re-verified)

| | Fleet-wide |
|---|---:|
| Operational devices | 15,696 |
| Currently counted inactive | **2,675** |
| Inactive with the shift backed out | 2,241 |
| **Falsely inactive** | **434 (16.2% of the inactive queue)** |
| Falsely inactive devices **holding an open TROUBLESHOOT ticket** | **434 — all of them** |

Every device silent 18.5–24 h is misclassified. Because `sla_bucket` derives from the same inflated
`inactivity_hours`, severity bands inflate with it — of the 665 devices currently in `CRITICAL`
(24–48 h), **434 are fabricated (65% of the band)**. This propagates into ticket priority, the
recommender's ordering, SLA reporting and Fleet Uptime.

## Why it failed silently

`mapping.ts:168` rejects a timestamp only when it is **ahead** of now:

```ts
if (normalized.gpsDatetime.getTime() > now.getTime() + maxSkewMs) return null;
```

An error pushing timestamps into the **past** cannot trip it. And
`apps/backend/test/autoplant-mapping.spec.ts:131` asserts `expect(AUTOPLANT_UTC_OFFSET_MIN).toBe(330)`
— **a test that pins the wrong value in place** and will go red on the correct fix. Every mapping
test constructs its own input rather than reading the live source, so a source contract that was
never true could not be falsified by the suite. See [#228](./228-guard-pattern-remediation.md).

## Scope warning — this is NOT a one-line constant change

**Added 2026-08-09.** [#228](./228-guard-pattern-remediation.md)'s fourth specimen establishes that
**Proposed step 5 (the two-directional skew guard) must ship in the SAME release as step 1**, not as a
follow-up. Flipping the constant alone does not drop the ~5 IST-writing devices as this issue long
claimed — it makes them read as permanently fresh, so they can never be detected as inactive or
ticketed again (see the corrected Open Question below). Shipping step 1 without step 5 converts a
visible fleet-wide 5.5 h error into five permanently invisible devices.

Whoever picks this up should size it as: constant + guard + pinned-test removal + recompute +
P6 answered, coordinated with [#223](./223-ndd-counted-healthy.md) — not as a one-line edit.

## Proposed

1. `AUTOPLANT_UTC_OFFSET_MIN = 0`.
2. **Delete or rewrite** `autoplant-mapping.spec.ts:131`. Replace the literal assertion with a live
   source probe (opt-in, VPN-gated) or a distributional guard, not another pinned constant.
3. Correct the now-false provenance comment at `mapping.ts:17-30` — record that the column is UTC,
   that ~5 devices write IST, and that `MAX()` is not a valid probe for this contract.
4. Recompute `device_states`; ~434 devices leave the inactive queue.
5. **Two-directional skew guard** — reject a timestamp implausibly far in the *past* as well as the
   future. A ping older than the fleet p99 by a wide margin is as suspect as one in the future.

### Open question — the ~5 genuine IST-writing devices

**Corrected 2026-08-09.** This section previously said the skew guard "will reject them and they will
stop ingesting entirely," and P6 was framed as a choice about accepting that drop. **That is not what
today's code does**, and the decision should be taken on the real behaviour.

`DEFAULT_MAX_SKEW_MINUTES` is **24 h** (`mapping.ts:34`) and no caller overrides it —
`autoplant-source-reader.ts:77` passes through a `maxSkewMinutes` that `ingestion.module.ts:160-166`
never sets. Flipping the constant to `0` puts these devices **5.5 h** into the future, which is well
inside a 24 h tolerance, so `mapping.ts:168` **does not reject them**. They keep ingesting.

The actual failure mode is worse than a drop, because it is silent: a timestamp in the future makes
`inactivity_hours` negative, which `device-state.service.ts:100` clamps to 0 via `GREATEST(0, …)`.
These five devices would read as **permanently fresh** — never inactive, never eligible for a
TROUBLESHOOT ticket, no matter how long they actually stay dark. A dropped device is visible as a
gap; a permanently-healthy device is invisible.

Rejection only becomes the outcome if **Proposed step 5** (the two-directional guard) ships with a
past/future threshold tighter than 5.5 h — i.e. it is a consequence of this issue's own proposed fix,
not of the constant flip. The two therefore have to be decided together.

**Operator decision — recorded as P6 in `audit/cross-analysis.md`, unresolved.** Options, restated:
accept five permanently false-healthy devices, special-case the ~5 device ids, or detect per-device
convention at ingest. "Accept the drop" was never on the table under current code.

### Independent corroboration from a second column (2026-08-09)

Measured while scoping the commissioning capture, and worth recording here because this issue has
been wrong once already: `tb_vehiclemaster.FIRST_INSTALLED_DATE_TIME` is **also** a naive MySQL
`DATETIME`, and it too is written in **UTC**. Measured against `device_installation_date` — a
`TIMESTAMP` in the *same row*, which the server returns already-UTC — **17,985 devices differ by
exactly 0 minutes, and not one differs by ±330**, with no step across 2025–2026.

So the "naive DATETIME ⇒ IST" inference that produced `+330` is wrong as a *house rule*, not just for
`latest_gps_datetime`. Two unrelated columns, two independent methods, same answer.

## Expected auto-recovery closure count — MEASURED 2026-08-09, before any code change

Recorded here **before** the fix is applied, per the operator's gate: *"Tell me the expected closure
count for the auto-recovery sweep […] I want that number in the issue before the sweep runs, not after
someone asks why SE productivity spiked."*

Every figure this issue and [#223](./223-ndd-counted-healthy.md) assert re-measured clean against `fsm`
first — operational 15,696 · inactive 2,675 · healthy 13,021 · null-GPS 913 · falsely-inactive 434 ·
open TROUBLESHOOT 12,571 (⚠ **an unswept queue, not a count of devices in trouble** — 11,042 of those
tickets already meet the auto-recovery criterion and 9,888 are on devices that are healthy right now,
because nothing closes them; see [#229](./229-auto-recovery-sweep-unwired.md). Any rate expressed
against 12,571 is diluted roughly 8× and should be read against ~1,500 real open work) ·
CRITICAL 665 of which 434 fabricated (65.3%). All 434 falsely-inactive
devices do hold an open failure cycle and an open TROUBLESHOOT ticket — 434/434/434, exactly as
claimed.

**The answer to the question asked is `+5` tickets. The answer to the question behind it is `11,042`.**

| Measurement | Tickets |
|---|---:|
| Open TROUBLESHOOT tickets today ⚠ *not a count of devices in trouble — see below* | 12,571 |
| …that already satisfy the auto-recovery criterion **today, with no fix applied** | **11,042** |
| …that would satisfy it after the timestamp correction | **11,047** |
| **Marginal closures caused by this fix** | **+5** |
| Of the 434 falsely-inactive: already auto-closable today | 367 |
| Of the 434 falsely-inactive: would stay open either way | 67 |

**Why the fix barely moves it.** `AutoRecoveryService.runAutoRecovery` never reads `is_inactive`. It
scans open TROUBLESHOOT tickets and asks one question of `raw_device_snapshots` — ≥3 pings spanning
≥15 min with `gps_datetime > cycle.opened_at` (`auto-recovery.service.ts:31-52`). Making a device
healthy does not close its ticket; **the pings already did, months ago.** Shifting every
`gps_datetime` 5.5 h later changes that verdict for 5 tickets at the margin.

**What the number actually exposes — two findings the gate did not anticipate:**

1. **The auto-recovery sweep has never run, and nothing can run it.** `runAutoRecovery()` has **no
   production caller** — not a `@Cron`, not a controller route, not a CLI script; the only call site in
   the repo is `test/auto-recovery.e2e-spec.ts:99`. The single wired entry point is
   `POST /tickets/:id/auto-recovery-close`, which closes **one** ticket manually. Confirmed at the
   data: `ticket_events` holds **31,162 OPEN and 11,792 CLOSED transitions and zero
   `CLOSED_AUTO_RECOVERY`** — the state has never been written.
2. **11,042 open tickets are already stale, and 9,888 of them sit on devices that are healthy right
   now.** The queue does not shrink when a device recovers, because the only thing that would shrink it
   is unwired. This is a **pre-existing 88% overstatement of the open TROUBLESHOOT queue**, and it will
   fire the instant anyone wires the sweep — with or without this fix, with or without #223.

**Consequence for the release plan.** The SE-productivity distortion the operator is guarding against is
real, but **this slice does not cause it and cannot trigger it**: no sweep runs. Attributing an
11,042-closure event to #222 would be the same class of error as the original "not a timezone bug"
call — a real signal attributed to the wrong cause. Filed separately as
[#229](./229-auto-recovery-sweep-unwired.md); it must not be quietly bundled into this slice, because
wiring it is a step change in every SE productivity and auto-recovery metric that needs its own
operator decision.

*Method: read-only queries against `fsm` (last snapshot run 2026-08-07 10:02 UTC, last recompute the
same instant). Counted over stored `gps_datetime` and again over `gps_datetime + 5.5h` — the corrected
value a post-fix ingest writes — since the fix changes future rows only and never rewrites the 1.65 M
existing ones. The two counts differ by 5.*

## What breaks

- **434 open TROUBLESHOOT tickets** sit on devices that are about to become healthy — but they will
  **not** close, because nothing runs the sweep (see the measured section above). They simply stop
  being counted as inactive while their tickets stay open. That is a *smaller* immediate disruption
  than this issue originally predicted and a *larger* latent one: the queue drifts further from the
  fleet's real state.
- Fleet Health % moves **82.96% → 85.72%** on this fix alone. Shipping it with #223 (which moves it
  down 1.06) gives the correct **84.84%**.
- `soft_inactive_count_history` shows a step discontinuity on the day of the fix — correct, but
  expect it.

## Withdrawn from the original issue

- *"Not a timezone bug"* — withdrawn, see Correction.
- *"Run 151's 3m19s duration suggests an incomplete pass"* — not supported; 20,578 rows written.
- The `raw_device_snapshots` partition observation (August rows landing in `_default`) is **unrelated
  to this defect** and remains an open, separate observation. `PARTITION_MAINTENANCE_ENABLED="false"`
  in `apps/backend/.env` is the likely cause.

## Acceptance

- ✅ `AUTOPLANT_UTC_OFFSET_MIN = 0`; the pinned-constant test is gone — replaced by a contract test that
  maps a wall clock through `mapVehicleMasterRow` against a **literal**, so no future offset value can
  satisfy it by agreeing with itself. The two `parseTripCreation` tests that derived their expectation
  from the constant were re-pinned to a literal `330` for the same reason: at offset 0 they had become
  tautologies.
- ✅ The expected auto-recovery closure count is recorded in this issue **before** the fix was applied
  (2026-08-09 — the operator's blocking gate).
- ⏳ After a recompute, per-run `p50(finished_at − gps_datetime)` is **< 1 h** (was 5.58 h). **Owed on
  the first post-fix snapshot run** — needs AutoPlant access, which is operator-gated. Not verifiable
  locally, and deliberately not claimed.
- ⏳ The 18–24 h false-inactive count returns to ~0. Same gate: it needs an ingest + recompute against
  the real source.
- ✅ The skew guard rejects both directions, with a test proving each — plus a test that it does **not**
  reject a genuinely silent device, which is the failure mode a percentile-based past guard would have
  had.
- ✅ P6 answered and implemented: the ~5 IST-writers are **rejected** (future tolerance 24 h → 1 h) and
  the rejection is **counted and logged** rather than silent, since P6's whole justification was that a
  dropped device is visible and a permanently-fresh one is not.
