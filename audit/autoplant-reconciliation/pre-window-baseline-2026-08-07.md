# Pre-window baseline — recorded 2026-08-07, before #218c runs

Recorded per the operator's step-1 request after `9c00ad6`/`aac8fdf` landed (the #218a detection +
218b fix commit, and the doc/INDEX follow-up). Read-only. No production data written.

## Why this reading is still trustworthy as "before"

**No sync has run since either commit.** Latest `master_sync_runs` row:

| run_id | status | started_at (UTC) | finished_at (UTC) | build_fingerprint |
|---:|---|---|---|---|
| 113 | SUCCESS | 2026-08-07T01:39:58.934Z | 2026-08-07T01:42:18.575Z | `f813b39-dirty` |

`9c00ad6` was committed at `2026-08-07T08:59:13Z` (`14:29:13+05:30`) — **run 113 finished over 7 hours
before the fix commit existed**, and its `build_fingerprint` is the pre-#218 HEAD. Nothing has run
since. The reading below is therefore the same "before" state 218a originally captured, not a new one
contaminated by an intervening sync.

**A live backend process is running on this machine, and it predates the fix too.** `dist/main.js`
(PID 19412 at check time) has been running since 2026-08-06 17:55:09 IST, serving from a build
stamped `f813b39-dirty` — i.e. it has **not** picked up 218b. Nothing about this session touched or
restarted that process. Two `npm run build` invocations were run this session (for the preflight tool)
but a running Node process does not hot-reload `dist/` — it keeps whatever it loaded at its own boot.
**`FIX-PLAN` §7.5 step 2 ("deploy the fix") means restarting this process** once the operator is ready
— there is no other deployment mechanism (confirmed below).

**The scheduler is empirically dormant on that live process, not just configured off.**
`INGESTION_SCHEDULER_ENABLED="false"` in `.env` (mtime 2026-08-06 17:21:24, ~34 min before the process
booted, so it almost certainly booted with this value — the flag is read once at construction and
cached for the process's lifetime, `integration-scheduler.service.ts:60`). Independently confirmed by
observed behaviour: telemetry ticks every 30 min would produce roughly 15 more `snapshot_runs` rows in
the ~7h39m between the last one (run 151, finished `01:45:37Z`) and this reading (`09:25:19Z`) if the
scheduler were active. **Zero appeared.** `npm run autoplant:window-preflight` also read OFF at
`14:29` IST this session.

## The reading

```json
{ "drift": 5134, "missingFromSource": 1131, "quietRuns": 27 }
```

Read at `2026-08-07T09:25:19.347Z` UTC (`14:55:19 IST`), same raw SQL `lifecycleHealth()` runs.
**Byte-identical to the 218a baseline captured at ship time** — confirming, independently of the run
history above, that nothing has moved: `healthy: false`, `quietRunsAlert: true` (threshold 3).

`missingFromSource` (1,131) differs from the Gate-3 `MISSING_FROM_SOURCE` departure-plan figure
(1,305/1,306) on purpose — they are different populations. This reading counts devices with an
**already-open** `ABSENT_FROM_READ` departure in FSM today; Gate-3 counted devices AutoPlant would put
in that bucket on the **next** sync, most of which have no departure row yet (that gap is exactly what
218c closes). Not a discrepancy to chase.

## Push safety — the two checks the operator asked for before pushing

**1. Does this branch deploy anywhere?** No. `.github/workflows/ci.yml` runs build/typecheck/test
against ephemeral, CI-only databases (`fsm_test`, `fsm_drift`) and has no deploy step of any kind.
There is no Dockerfile, compose file, or deployment manifest anywhere in the repo — confirmed by grep
and independently documented as still-open in
[`issues/111-deployment-packaging-runbook.md`](../../.scratch/fsm-platform-v1/issues/111-deployment-packaging-runbook.md)
(`ready-for-human`, unactioned). Pushing `feat/autoplant-integration` triggers CI only; nothing in the
repo can turn that push into a running process anywhere. Caveat: this is a repo-visible-mechanism
answer — it cannot rule out a human manually pulling and restarting a server outside this repo's
control, but that would be a deliberate operator action, not a consequence of the push itself.

**2. Scheduler state, every environment this branch could land in.** The only environment visible
from here is this machine, and its live process is confirmed dormant above (config + zero observed
ticks in a 7h39m window that should show ~15 if active). No other environment exists to check — #111
confirms there is nowhere else this branch currently lands.

## Verdict

Safe to push. No deploy is triggered by the push itself, and the one live process this branch could
eventually reach is both unrestarted (still pre-fix) and empirically not ticking.
