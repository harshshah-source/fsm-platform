# 132 — Stale-run reaper reaps still-alive runs → concurrent double-drain + zombie `finishRun` resurrect
Status: folded into [#261](./261-dispatch-run-heartbeat-reaper.md) item 5 (2026-08-20, #258 Q8.8): heartbeat-based liveness + conditional finishRun for the ingestion ledgers, alongside the new dispatch-run reaper. Evidence and ACs here remain the reference; execution happens under #261.
Type: AFK

> Source: pipeline risk audit 2026-07-16 (`docs/audits/pipeline-risk-audit-2026-07-16.md`, finding
> **NEW-2** — ranked #2). Triaged as the next session 2026-07-17: silent (the zombie `finishRun`
> erases the reaper's FAILED verdict), **guaranteed at target scale** (run-time ≫ the 30-min default
> threshold), and the **last unowned activation blocker for the ingestion cron**.

> **HITL gate:** acceptance criteria below are DRAFTED for review, and the fix approach (options at the
> bottom) needs sign-off **before any code is written**. When approved: TDD — a red test that
> reproduces the reap-alive + zombie-resurrect on today's code first, then the fix goes green.
> Scheduler flags and `eligibility_mode` stay untouched. **Both ledgers** (`snapshot_runs` and
> `master_sync_runs`) are in scope — they share the shape.

## Problem

The stale-run reaper decides liveness from `started_at` alone. A run whose wall-time exceeds
`INGESTION_STALE_RUN_MIN` is reaped `RUNNING→FAILED` **even while it is still draining**, which frees
the single-in-flight partial-unique and lets the next tick start a *second* concurrent run; then the
still-alive run's `finishRun` — an **unconditional** update by `run_id` — flips its own row back to
`SUCCESS/PARTIAL`, resurrecting a "dead" run and erasing the FAILED verdict. The single-in-flight
guarantee the run ledger exists to provide is silently void whenever run-time > threshold. The default
threshold (30 min) **equals** the telemetry cadence, so the margin is zero, and at target fleet scale a
normal run exceeds it every time.

## Evidence (verbatim from the audit, NEW-2)

- **Where:** `ingestion/snapshot-run.service.ts:33-40` (`reapStaleRuns`), `:43` (called first in
  `startRun`), `:85-93` (`finishRun` unconditional `update where runId`); `ingestion/stale-run.ts:11`
  (`DEFAULT_STALE_RUN_MIN = 30`); `ingestion/autoplant/integration-scheduler.service.ts:23`
  (`DEFAULT_TELEMETRY_CRON = '*/30'`). Same shape in `master-sync-run.service.ts:41-48`.
- **What happens:** `@nestjs/schedule` does **not** serialize overlapping cron invocations — the
  code relies entirely on the DB run guard. When a telemetry run's wall-time exceeds
  `INGESTION_STALE_RUN_MIN`, the *next* tick's `startRun()` calls `reapStaleRuns()` first, which
  flips the **still-running** run's row `RUNNING→FAILED` (`startedAt < now − 30min`). The partial
  unique `snapshot_runs_one_in_flight` no longer sees a RUNNING row, so the new tick creates its own
  and **both drain concurrently**. Data stays correct (writes are `ON CONFLICT DO NOTHING`,
  ticket-create is I1-guarded), but: (i) double VPN + DB write load; (ii) when the reaped-but-alive
  run finishes, `finishRun` **unconditionally** overwrites its row back to `SUCCESS/PARTIAL`
  (`:85-93`) — a "zombie" run resurrects itself and re-advances `data_as_of`/`cursor`, erasing the
  reaper's FAILED verdict. The single-in-flight guarantee — the entire point of the run ledger — is
  silently void whenever run-time > threshold.
- **Trigger:** run-time > `INGESTION_STALE_RUN_MIN`. Default 30 min **equals** the telemetry cadence
  and the reaper threshold, so the margin is zero. Snapshot ingest was 353 s at 18k devices
  (07-07 validation audit); linear-ish to ~300k target ⇒ ~90 min ≫ 30 min. At target scale **every**
  run trips this. A slow-VPN night trips it at current scale.
- **Blast radius:** broken single-in-flight across the whole ingestion subsystem; doubled source/DB
  load during the overlap; a run an operator/reaper believes dead can silently resurrect and move the
  freshness watermark. No row corruption observed, but the invariant the ledger sells is gone.
- **Likelihood today:** LOW (schedulers off; dev runs ~7 min). **After activation:** MED at current
  scale, **HIGH at target scale** (guaranteed). The documented mitigation (§6.2 "set
  `INGESTION_STALE_RUN_MIN` above telemetry cadence") is **insufficient**: it must exceed max
  *run-time*, and the cadence itself must exceed run-time or ticks pile up — neither is enforced or
  validated at boot.
- **Detectability:** LOW / silent — health shows the resurrected `SUCCESS`; the transient FAILED and
  the overlap leave no durable trace beyond interleaved log lines.
- **Owner:** unowned (new); adjacent to #97/#104.

### Supplementary evidence found while filing (for the fix design)

- **Twin ledger:** `master-sync-run.service.ts:41-48` (`reapStaleRuns`), `:51` (called first in
  `startRun`), `:79-88` (`finishRun` unconditional `update where runId`) — identical shape; same fix
  applies. Both share `stale-run.ts` (`readStaleRunMs`, `DEFAULT_STALE_RUN_MIN`).
- **Natural heartbeat points exist in both writers:** the snapshot worker drains chunk-by-chunk
  (`snapshot-ingestion.worker.ts:71-101`); master-sync writes in batched groups
  (`master-sync.service.ts:315-316`, `batchUpsert`'s `for (const group of chunk(...))`). Each is a
  per-unit loop where a `heartbeat_at` bump slots in cleanly.

## Acceptance criteria (DRAFT — review before building)

- [ ] **RED first:** a regression test reproduces, on today's code, (i) a run whose `started_at` is
      older than the threshold is reaped `RUNNING→FAILED` while still "alive", **and** (ii) its
      subsequent `finishRun` resurrects the row to `SUCCESS/PARTIAL` (the zombie). Show the failing
      output before building.
- [ ] After the fix, a **slow-but-alive** run (heartbeating past the threshold) is **not** reaped;
      the next tick's `startRun` still sees a RUNNING row and skips (409 → no second concurrent run).
      Prove it: no two RUNNING rows coexist for a heartbeating run.
- [ ] A **genuinely dead** run (heartbeat gone stale / process crashed) is still reaped `→ FAILED` at
      `startRun`, so unattended operation self-heals (no regression of the #97 reaper fix).
- [ ] A reaped run **cannot resurrect itself**: `finishRun` is guarded (updates only while the row is
      still `RUNNING`); a reaped run's finish is a no-op that is **surfaced** (logged + a distinct
      outcome), never a silent `SUCCESS`.
- [ ] Both ledgers covered — `snapshot_runs` **and** `master_sync_runs` (shared `stale-run.ts`
      threshold; per-service `heartbeat_at` + guarded `finishRun`).
- [ ] Threshold semantics documented as **silence-based** (max tolerable gap between heartbeats), not
      total-run-time; SYSTEM-STATE §6.2 note corrected (the "set above cadence / above max run-time"
      guidance is superseded). Boot-validation decision recorded (see the design note).
- [ ] Migration adds `heartbeat_at` to both run tables (nullable; reaper falls back to `started_at`
      when a run has not heartbeated yet); from-zero migrate clean.
- [ ] Existing ingestion + master-sync suites green; tsc + build clean.

## Fix options (BRIEF — decide before building)

Full comparison in the session response. **Instinct: both (a) and (b) — (a) is the correctness fix,
(b) is the guardrail that makes any residual wrong-reap non-silent.**

- **(a) Heartbeat column** (`heartbeat_at`, bumped per chunk/batch): the reaper checks **liveness**
  (`heartbeat_at < cutoff`, falling back to `started_at` when null), not start-time — so a slow-alive
  run is never reaped. Prevents the wrong reap at the root.
- **(b) Guarded `finishRun`** (`updateMany WHERE run_id AND status='RUNNING'` → count): a reaped run
  cannot resurrect itself; when it discovers it was reaped (count 0) it aborts/no-ops and surfaces,
  never silently re-reporting `SUCCESS`.

Are both needed? Yes: (a) stops the wrong reap; (b) ensures that if a reap ever still happens (a GC/
event-loop stall longer than the threshold freezes heartbeats, or a future bug), it can't be silent.

## Blocked by
None. Touches `snapshot-run.service.ts`, `master-sync-run.service.ts`, `stale-run.ts`,
`snapshot-ingestion.worker.ts`, `master-sync.service.ts`, a schema migration, and the SYSTEM-STATE
§6.2 note. Related: NEW-3 (manual dispatch guard) is a separate session. #127 stays at Next-up right
behind this.
