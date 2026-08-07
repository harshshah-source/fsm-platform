# 222 — FSM telemetry runs ~5.1 h behind AutoPlant, producing false inactives

Status: needs-triage
Type: AFK · Backend ingestion
Filed: 2026-08-07
Origin: AutoPlant↔FSM reconciliation, finding **F2**
(`audit/autoplant-reconciliation/reconciliation-report.md`)
Deliberately excluded from [#218](./218-lifecycle-drift-detection.md) by operator decision.

## Problem

Per-device GPS comparison against the ground-truth Excel, both sides normalised to UTC
(11,578 matched devices):

```
min -5.50h · p05 -5.50h · p25 -5.15h · p50 -5.10h · p75 -5.10h · p95 -5.05h
99.5% of devices older by >1h · only 2 of 11,578 within ±5 min of zero
```

**This is not a timezone bug** — that was tested and ruled out. The offset is ~5.1 h, not the
5 h 30 m an IST double-conversion would produce, and the distribution has a positive tail. FSM's
conversion is correct; its *data* is old.

Snapshot run 151 *completed* at 07:15 IST, yet the freshest GPS in `device_states` was 01:44 IST — so
this is not simply "no run since". Run 151 took 3m19s against run 149's 9 minutes, which suggests an
incomplete or cursor-bounded pass rather than a missed schedule.

## Impact (measured)

**80 devices were false-inactive** on the 2026-08-07 snapshot: the Excel shows them Active, FSM marks
them inactive, and their true GPS age is **18.2 h – 24.0 h** — precisely the window where a +5.1 h
bias crosses the 24 h inactivity threshold. Each is a spurious SLA breach and a candidate for an
auto-created ticket against a healthy device.

The bias is systematic and one-directional, so it inflates every inactivity-derived figure on the
dashboard, not just the 80 that crossed the threshold on this particular snapshot.

## Possibly related, unverified

`raw_device_snapshots` has daily partitions only through `y2026m07d11`; August rows are landing in
`_default`. Flagged as an observation, not a claim — the partition-maintenance path was not
investigated.

## Acceptance

- The ~5.1 h lag explained: incomplete pass, cursor not advancing, or a genuinely stalled ingest.
- Once fixed, the false-inactive count at the 18–24 h band returns to ~0.
