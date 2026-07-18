# HANDOFF — #128 Device Deployment Lifecycle (Slice 1 DONE; resume at the Slice-2 approval gate)

**Date:** 2026-07-18 · **Branch:** `feat/autoplant-integration` · **HEAD:** `b9242da` (pushed)
**State:** **Slice 1 (mechanism + tests) is DONE, committed, and pushed. 8/8 e2e green, tsc clean,
regression sweep green.** Slice 2 (dry-run backfill) is **held at the operator approval gate** — do
NOT run it or the live pass without explicit go-ahead on the numbers.

> Reading order: this file → the issue ACs (`.scratch/fsm-platform-v1/issues/128-device-deployment-lifecycle.md`)
> → the investigation (`docs/audits/deployment-lifecycle-investigation-2026-07-17.md`, all evidence).
> Slice 1 is finished — do NOT re-run it. Resume at §3 (Slice 2, gated).

---

## 1. What landed this session (Slice 1)

- Confirmed RED (4/8), applied the test-DB enum fix (`fsm_test` was missing `DEVICE_UNDEPLOYED_CLOSE`
  — rolled back the half-applied `20260717130000_device_departures` migration so `global-setup`
  re-applied the corrected one). That cleared 2 reds.
- The other 2 reds were a **second latent defect the enum error had masked** — a test-setup bug, not a
  code bug: the eligibility/auto-restore tests stamped a "silent" `latest_gps_datetime` via
  `updateMany`, but master-sync never creates `device_states` rows (no code path, no trigger), so it
  matched 0 rows and the control device stayed never-pinged (`is_inactive=false`). Fixed the **test**
  (materialise rows via `recompute()` first); production recompute was already correct.
- **8/8 green** (`test/device-departure-lifecycle.e2e-spec.ts`), `tsc --noEmit` clean, regression:
  device-state 23/23 · plant-deactivation+ticketing+lifecycle 18/18 · recommender 10/10 · dispatch
  12/12 (one flaky `afterAll` teardown, clean on re-run).

## 2. The commit split (the tree was entangled)

The working tree carried a separate **AutoPlant device-enrichment** WIP (DEVICE_TYPE/IMSI_NO +
TRIP_CREATION, migration `20260717120000_autoplant_device_enrichment`) interleaved with #128 across 5
shared files (`autoplant-master-source.ts`, `master-mapping.ts`, `ingestion.module.ts`,
`schema.prisma`, `autoplant-sync.ts`). Split hunk-by-hunk (`git add -p`):

- **`aff1d87`** — `wip: autoplant device-enrichment … not independently verified this session`
  (checkpoint; NOT audited — do not treat as done).
- **`b9242da`** — `feat(backend): #128 device deployment lifecycle … (Slice 1)` — clean, verified.
  `prisma migrate diff` confirms none of the #128/enrichment objects appear as drift (schema ↔
  migrations consistent; remaining diff is pre-existing cosmetic index/FK naming, project-wide).

**Still uncommitted (untouched, intentional):** ~85 items of unrelated churn — admin dashboards,
dispatch/reports FE, `docs/ui-redevelopment/`, other migrations. Not this issue's scope.

## 3. ⚠️ Slice 2 — dry-run backfill (HELD AT OPERATOR APPROVAL GATE — do not start without go-ahead)

`DeviceDepartureService.reconcile({ dryRun: true })` already returns the plan + counts. The task:
wire a one-shot entrypoint that runs the widened read + lifecycle pass in dry-run against the **prod
AutoPlant read** (READ-ONLY; SELECT + `LIMIT ≤ 90` only; no writes anywhere) and reports:
**devices → departed, tickets → cancelled, per-zone/plant breakdown.**

- **Expected (from the investigation):** ≈ **6.9k devices departed**, ≈ **3,700 open tickets
  cancelled**. Dashboards shrinking substantially afterward is the correct, honest outcome.
- **Guard rail:** the absence pass aborts + alerts if one run would mark > N % of the operational
  fleet (`MasterSyncOptions.maxAbsenceRatio`); a partial/failed read marks nothing. For the dry run,
  surface the would-be ratio so the operator can calibrate before the live pass.
- **STOP after the dry run — show the operator the counts and WAIT for explicit approval** before any
  live marking (Slice 3).

## 4. Slice 3 — apply + verify (only after Slice-2 approval)

Run the live pass (same audited, reversible mechanism — no special-case writes, no deletes). Verify:
(a) master-sync survival, (b) re-deploy auto-restore, (c) eligibility now actually filters, (d)
dispatch skips departed. Capture **before/after fleet + dashboard counts in
`docs/SYSTEM-STATE-2026-07.md`** (as the 2026-07-13 zone application did); commit + push; append an
INDEX session-log line.

## 5. Follow-ups already filed

- **#129** (`.scratch/fsm-platform-v1/issues/129-device-departure-ui-parity.md`) — UI parity:
  ZM/OH departed tally, device-detail lifecycle history, integration-health per-run departures/
  restores. Display-only; #128 data layer is ready. Best built after Slice 3 applies real data.

## 6. Env / infra notes

- DEV DB `fsm` (localhost:5433) and TEST DB `fsm_test` — migration fully applied incl. the
  `DEVICE_UNDEPLOYED_CLOSE` enum (the test-DB fix from this session; both DBs now consistent).
- AutoPlant prod creds in `apps/backend/.env` (`AUTOPLANT_MYSQL_*`) — **read-only, VPN**; SELECT +
  `LIMIT ≤ 90` only, no writes. Phase-1 evidence scripts (`p1-*.js`) in the 2026-07-17 scratchpad.
- **Numbering note:** an untracked `.scratch/fsm-platform-v1/issues/128-reaper-reaps-live-runs-zombie-resurrect.md`
  is a pre-existing #128 collision from another session (the reaper/NEW-2 audit finding) — NOT this
  issue. Left as-is; flag to the operator for renumbering.

## Suggested skills for the next session

- **`/verify`** — before the Slice-2 STOP, dry-run the reconcile end-to-end against a bounded prod read
  and eyeball the per-zone counts, not just unit assertions.
- **`field-ops-director`** — sanity-check the departed-tally UX + the cancel-vs-suppress downstream
  behaviour against field reality before Slice 3 touches live data.
- **`/code-review`** — the insert-scope pin is the load-bearing invariant; re-review before Slice 3.
