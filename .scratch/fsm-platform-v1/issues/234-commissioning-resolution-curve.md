# 234 — Cohort resolution curve: how fast a fitment batch comes online

Status: ready-for-agent
Type: Feature (Backend-only) · Reports · AFK
Filed: 2026-08-13, from `audit/recently-commissioned-devices-investigation-2026-08-13.md` §5
Feeds: [#232](./232-commissioning-cohort-view.md) AC-1 (the admin surface's trend panel)
Coordinates with: [#229](./229-auto-recovery-sweep-unwired.md) (the reason the *calendar-time* series is
deferred rather than built)

## What to build

The operator ask includes *"monitor how their inactivity/status changes over time."* FSM keeps **no
historical device-status series** — `device_states` is overwritten in place and
`raw_device_snapshots` is 7-day retained. The investigation examined every candidate source:

| Source | Usable for cohort trend? |
|---|---|
| `device_states` | No — overwritten, no history |
| `raw_device_snapshots` | No — 7-day retention; the 52 surviving partitions are a `PARTITION_MAINTENANCE_ENABLED=false` accident, not a guarantee |
| `soft_inactive_count_history` | No — zone-keyed, not cohort-keyed (130 rows) |
| `device_downtime_summary_monthly` | Marginal — device-keyed but monthly; a 3-month cohort yields 1–3 points |
| `failure_cycles` interval overlap | **In principle yes — currently distorted, see below** |
| `device_commissioning` + `first_reported_at` | **Yes — two stored facts, one subtraction** |

**Build the fitment-relative curve.** For the fitments in the window, what fraction had come online
by 4 h / 12 h / 24 h / 48 h / 72 h, and what fraction never did. Add the buckets as
`count(*) FILTER (…)` columns to the **same** `GROUPING SETS` pass in `gradedSource` — no second
query, no new endpoint, no new table, no background job, no dependency on the scheduler or on
ticketing.

Measured live on `fsm`, post-epoch, 2026-08-13 (520 samples): `<1h` 52 · `1–4h` 87 · `4–12h` 93 ·
`12–24h` **189** · `24–48h` 91 · `48–72h` 6 · `>72h` 2 — **97.7% inside 48 h, 99.6% inside 72 h.**
This reproduces the feasibility read's AutoPlant-side survival curve on FSM's own stored data for the
first time, and independently confirms the `graceHours = 48` default.

It is also the better operational question: *"is this week's batch coming online as fast as last
month's?"* is a cohort question, not a calendar question.

## Explicitly NOT in this slice — and why

**The calendar-time cohort inactivity series is deferred, not forgotten.** Reconstructing "how many
of this cohort were silent on day X" from `failure_cycles` interval overlap is the textbook approach
and needs no new table. It is currently unusable: measured live, the operational 90-day cohort has
**2,183 failure cycles of which 1,799 (82%) are still `OPEN`**, because auto-recovery has never
executed — it had no production caller at all until [#229](./229-auto-recovery-sweep-unwired.md) and still
has none running, being gated behind `INGESTION_SCHEDULER_ENABLED`. Any calendar series built on that
**rises monotonically as an artefact of the scheduler being off**.

**Precondition for filing it as buildable:** #229's auto-recovery pre-check has actually run and
cycle closure is observed. Do not build it before then, and do not substitute a new daily snapshot
table — that is the unnecessary table this feature was scoped to avoid.

## Acceptance criteria

1. **AC-1** Buckets derive from the **same** `commissioned` expression as the counts. The totals and
   the curve cannot disagree — one definition in SQL, not two.
2. **AC-2** Bucket membership is epoch-gated exactly as `ttfr_hours` is: a pre-`COMMISSIONING_TTFR_EPOCH`
   fitment counts in `fitments` and (if silent) in `never`, but contributes to no timing bucket.
   `sampleSize` stays the honest denominator.
3. **AC-3** Measured, not assumed: the extended query holds the §7.2 plan at `cohortDays=90` — one
   pass, quicksort in memory, no disk spill. Record the `EXPLAIN (ANALYZE, BUFFERS)` in the
   completion report. Baseline to beat or match: **23.9 ms, `shared hit=1634`, zero reads.**
4. **AC-4** Live shape against `fsm` reproduces the distribution above (97.7% inside 48 h).
5. **AC-5** A zero-sample bucket set returns nulls on the same code path as `NO_TIMING` — "nothing
   measured" and "everything instant" must never render as the same claim.

## UI surfaces

n/a — consumed by [#232](./232-commissioning-cohort-view.md) AC-1's page.

## Reference

n/a.

## Blocked by

[#233](./233-commissioning-cohort-counts-warehouse-as-failed.md) — shares `gradedSource`; landing
the population fix first avoids rewriting the same CTE twice.
