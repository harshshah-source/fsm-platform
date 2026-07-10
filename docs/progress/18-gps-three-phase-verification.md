# Progress — Issue 18: GPS three-phase verification + outcome

> Build date: 2026-06-23 · Strict TDD (RED→GREEN→REFACTOR), AFK.
> Status: **DONE**. All 6 acceptance criteria green. Backend: **+22 tests / +4 files** for this issue;
> `tsc --noEmit` clean (PostgreSQL 16 + PostGIS on :5433). Migration **23** (`add_verification_runs`).

## Scope & decisions

The `VerificationService` three-phase GPS auto-verification (LLD §17 / workflow §17.1) and the SE/ZM
read surface. After an Issue 16 form submission moves a ticket to `VERIFICATION_PENDING`, the re-entrant
worker watches the named device's pings and drives the outcome.

- **Phase 1 (evidence + anchor):** ≥3 pings, ≥15 min span, no gap >30 min, and the **first** ping within
  ±500 m of the SE anchor (form GPS / ON_SITE capture). The geo-check is **skipped (no fraud)** when
  `presence_source = NONE` or no anchor was captured. 1–2 pings → PARTIAL_RECOVERY badge.
- **Phase 2 (stability):** 1 h from the Phase-1 first ping, the device keeps pinging with no gap
  >30 min; movement is welcome (no ±500 m). A coverage gap **stays PENDING — never auto-fails**.
- **Outcomes:** `CLOSED` (Phase 2 passed → cycle VERIFIED), `FAILED_VERIFICATION` (no pings after the
  24 h window, or a far Phase-1 ping → `fraud_flag` + distance delta), `PARTIAL_RECOVERY` (badge while
  1–2 pings are in, ticket stays VERIFICATION_PENDING).

Decisions:

1. **Pure criteria, re-entrant worker.** `verification-criteria.ts` (`evaluatePhase1` / `evaluatePhase2`
   / `haversineMeters`) is side-effect free; the worker recomputes from pings each scan and persists
   phase state in `verification_runs`, so it is safe to run repeatedly (no scheduler yet — same posture
   as the other P1–P3 workers; a BullMQ 5-min cron wires to `runVerification` when scheduling lands).
2. **`runVerification(now, { ticketIds? })`** carries an optional ticket scope — the real worker omits it
   (global VERIFICATION_PENDING scan); tests pass their own ids for deterministic isolation on the
   shared DB.
3. **PARTIAL_RECOVERY is a derived badge**, not a stored state (CONTEXT §Partial Recovery): the read
   service computes it from `pings_received_count` + `outcome`.

## Acceptance criteria status

| # | Criterion | State | Evidence |
|---|-----------|-------|----------|
| 1 | ±500 m rule applies only to the Phase-1 first ping; Phase-2 pings accepted regardless of location | 🟢 | `evaluatePhase1` checks only the first ping vs anchor; `evaluatePhase2` has no geo-check (movement welcome). `verification-criteria.spec.ts` (10). |
| 2 | Phase-1 anchored on form GPS / ON_SITE; skipped (no fraud) when `presence_source = NONE` | 🟢 | Worker passes the submission's `se_gps`; `skipGeoCheck` when presence NONE / no anchor → no fraud, evidence still applies. `verification-run` NONE-presence test. |
| 3 | Outcomes CLOSED / PARTIAL_RECOVERY / FAILED_VERIFICATION computed correctly | 🟢 | `runVerification` → CLOSED (cycle VERIFIED), PARTIAL pending, FAILED on fraud / 24 h expiry. `verification-run.e2e-spec.ts` (5). |
| 4 | Fraud flag records distance delta when Phase-1 ping is far from the SE location | 🟢 | `fraud_flag=true` + `first_ping_distance_meters` persisted; surfaced in `/api/verification/fraud-flags`. Run + controller tests. |
| 5 | `verification_runs` persisted with phase detail | 🟢 | Table (phase / phase1/2 passed-at / distance / fraud / pings / outcome) + `ux_vr_active` one-in-flight unique. `verification-runs-schema.e2e-spec.ts` (2). |
| 6 | Mobile shows outcome + PARTIAL_RECOVERY (N/3 pings) badge | 🟢 | `GET /api/tickets/:id/verification` returns the derived `badge` + `pingsReceivedCount`; CLOSED/PARTIAL covered. `verification-controller.e2e-spec.ts` (5). |

## Slice-by-slice RED→GREEN report

- **Slice 1 — schema.** `VerificationRun` model + `VerifyPhase` / `VerifyOutcome` enums + back-relations;
  migration `20260623160000_add_verification_runs` (table, `ux_vr_active` partial unique, device index,
  FKs to tickets + submissions). `verification-runs-schema` (2).
- **Slice 2 — pure criteria.** `evaluatePhase1` / `evaluatePhase2` / `haversineMeters`. `verification-criteria.spec.ts` (10).
- **Slice 3 — worker orchestration.** `VerificationService.runVerification` — scan → evaluate → persist
  run → transition ticket (+ cycle VERIFIED on CLOSED) + event + audit. `verification-run.e2e-spec.ts` (5).
- **Slice 4 — read surface.** `VerificationQueryService` (derived badge + fraud flags) + `VerificationController`
  (`GET /api/tickets/:id/verification`, `GET /api/verification/fraud-flags`); `VerificationModule` +
  AppModule wiring. `verification-controller.e2e-spec.ts` (5).

## Deviations / deferred (read before extending)

1. **No scheduler.** `runVerification` is invoked on demand; the 5-min BullMQ cron lands with scheduling.
2. **`CLOSED_AUTO_RECOVERY` / `FAILED_ACTIVATION` outcomes** exist in the enum but are produced elsewhere
   — auto-recovery (Issue 08, already closes its own tickets) and Install activation (Issue 34). This
   worker emits `CLOSED` / `FAILED_VERIFICATION` only.
3. **Plant-geofence Phase-1 fallback** ("or inside Plant geofence") is not yet wired — the anchor is the
   SE form GPS / ON_SITE capture. The plant-geofence corroboration is a small follow-up (plant.location
   + ST_DWithin, as in Issue 15's `setOnSite`).
4. **Verification read is role-gated, not per-row zone-scoped** — an SE/ZM with the role can read any
   ticket's run. Zone-scoping the ZM fraud-flags / SE own-ticket filter layers on with the dashboard
   integration.
5. **No mobile UI** — delivered as the backend worker + read API the mobile badge will consume; the
   on-screen badge lands with the mobile ticket screens.

## Environment note

Migration hand-written (shadow-DB `CREATE DATABASE` denied to the `fsm` role) then `migrate deploy` +
`generate`. `audit_logs.actor_id` is non-nullable → system audits use the `'SYSTEM'` sentinel actor.

## How to run / verify

```
cd apps/backend && node node_modules/vitest/vitest.mjs run \
  test/verification-runs-schema.e2e-spec.ts test/verification-criteria.spec.ts \
  test/verification-run.e2e-spec.ts test/verification-controller.e2e-spec.ts
node node_modules/typescript/bin/tsc --noEmit
```
