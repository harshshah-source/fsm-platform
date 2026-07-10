# Progress — Issue 05: Device state + inactivity + SLA bucket + ticket creation

> Build date: 2026-06-20 · Strict TDD (RED→GREEN→REFACTOR), AFK.
> Status: **DONE**. All 6 acceptance criteria green. Backend **130 tests / 38 files** green,
> `tsc --noEmit` clean (local PostgreSQL 18, no Docker). Eligibility inputs use **minimal real
> tables** (`pgi_history` + minimal `non_operational_markings`) per the agreed Option 1 — not a seam.

## Summary

The core tracer bullet from raw telemetry to an open Ticket. Three units compose the pipeline:

- **`DeviceStateService.recompute`** reads the latest `raw_device_snapshots` ping per device, derives
  `inactivity_hours` (clamped ≥0), `is_inactive` (vs the configurable 24h `inactivity_threshold_hours`),
  the stored `sla_bucket` (pure classifier), and `eligible_for_uptime` (pure predicate over latest PGI
  + active Non-Op), denormalises fitment, and upserts one `device_states` row per device.
- **`TicketCreationService.createForInactiveEligible`** scans `device_states` for
  `is_inactive ∧ eligible_for_uptime ∧ ¬has_open_failure_cycle ∧ plant/company present` and, per
  device, opens one `failure_cycle` (OPEN) + one parented `ticket` (TROUBLESHOOT/OPEN, tier
  denormalised) and flips `has_open_failure_cycle` — all in one transaction.
- **`TicketQueryService` / `TicketsController`** expose `GET /api/tickets` and `/api/tickets/:id`
  (manager-role-gated), each ticket carrying its device's stored SLA bucket.

Built on Issue 01/02/04 primitives (`AuthGuard→RoleGuard`, `@Roles`, global Prisma, `SettingsService`,
`raw_device_snapshots`).

## Acceptance criteria status

| # | Criterion | State | Evidence |
|---|-----------|-------|----------|
| 1 | SLA classifier pure; full boundary set | 🟢 | `src/device-state/sla-bucket.ts` + `test/sla-bucket.spec.ts` (5). Pre-existing slice 1; unchanged. |
| 2 | `device_states` upserted with `is_inactive` + `sla_bucket` | 🟢 | `DeviceStateService.recompute`; `test/device-state-recompute.e2e-spec.ts` (3). |
| 3 | One `failure_cycle` + `ticket` per newly-inactive eligible device | 🟢 | `TicketCreationService`; `test/ticket-creation.e2e-spec.ts` (2). |
| 4 | Eligibility gate (active PGI ~15d AND not Non-Op) | 🟢 | Pure `isEligibleForUptime` (`test/eligibility.spec.ts`, 6) + data side (`test/device-state-eligibility.e2e-spec.ts`, 4) + creation gate (`test/ticket-creation-gate.e2e-spec.ts`, 4). |
| 5 | Duplicate active Ticket prevented | 🟢 | `has_open_failure_cycle` filter + I1 partial-unique backstop; `test/ticket-creation-gate.e2e-spec.ts` (rerun + stale-flag cases). |
| 6 | Tickets retrievable via `/api/tickets/*` | 🟢 | `TicketsController`; `test/tickets-api.e2e-spec.ts` (5: list+bucket, by-id, 404, SE 403, 401). |

## Slices delivered (build order)

1. **SLA classifier** *(pre-existing)* — `classifySlaBucket`, closed-lower/open-upper bands, null = ACTIVE.
2. **Schema** — `devices`, `vehicles`, `device_states`, `failure_cycles`, `tickets`, `pgi_history`,
   minimal `non_operational_markings` (migration `20260620124718_add_device_ticket_spine`); raw-SQL
   invariants I1 (one active cycle/device), I13 (one active Non-Op/device), and the device_states /
   tickets / failure_cycles CHECKs. `test/device-ticket-schema.e2e-spec.ts` (5).
3. **DeviceStateService.recompute** — latest-ping derivation + upsert.
4. **Eligibility** — pure `isEligibleForUptime` + `eligible_for_uptime` wired into recompute.
5. **TicketCreationService** — transactional cycle + ticket + flag.
6. **Gate + invariant** — ineligible/active skipped; duplicate-active prevented (rerun + I1 backstop).
7. **`/api/tickets/*`** — `TicketQueryService` + `TicketsController` + `TicketingModule` (AppModule-wired).

## Data model added (migration, this issue)

- `20260620124718_add_device_ticket_spine` — 8 enums (`deal_type`, `sla_bucket`, `failure_cycle_state`,
  `sla_pause_reason`, `work_type`, `ticket_status`, `assignment_state`, `nonop_state`); 7 tables; FKs;
  hand-appended partial-uniques (I1, I13) + CHECKs (`inactivity_hours>=0`, `TROUBLESHOOT⇒cycle`,
  valid-close, pause-coupling). Back-relations added to `Plant`/`Company`.

## Deviations / deferred (read before extending)

1. **`non_operational_markings` is minimal** — only `state` + effective window + I13, the subset the
   eligibility read needs. The full dual-confirmation lifecycle (tokens, roles, `reason_code`) lands
   with **Issue 35** as an additive `ALTER`. `pgi_history` is full but its SAP feed is external
   (deferred) — rows are seeded directly in tests.
2. **No audit row on cycle/ticket creation** — the LLD audits every transition, but creation here is
   system-generated (no human actor) and the audit/notification spine is **Issue 03** (`ready-for-human`,
   not built). Add audit-on-create when Issue 03 lands a system-actor convention.
3. **Pipeline not orchestrated/scheduled** — `recompute` and `createForInactiveEligible` are standalone
   units (each individually tested); no worker chains snapshot→recompute→ticket and no cron triggers
   them. Belongs to a later scheduling slice (Issue 04 already deferred BullMQ; `POST /run` is sync).
4. **Repeat-failure detection deferred** — always opens a fresh `OPEN` cycle; `REPEAT` / `previous_failure_cycle_id`
   chaining is **Issue 08**.
5. **`tickets` is the TROUBLESHOOT subset** — Install/Recovery-only columns (`se_id`, `created_by`,
   `closure_type`, `import_batch_ref`, …) and the full status×work_type CHECK are added by their owning
   issues (11/33/34/36/37). `vehicle_device_mappings` history table → Issue 18; `transporters` FK and
   the PGI eligibility-window setting are not yet modelled (window is a code constant, default 15).
6. **`/api/tickets` is the cross-zone manager list** — ZM zone-scoping is a later concern (Issue 06 /
   `ZoneScopeGuard`). SEs are 403 here; they read work via Day Plan / Shared Pool (Issues 11/12).

## How to run / verify

```
# backend (local PG18 must be up)
cd apps/backend && node node_modules/vitest/vitest.mjs run          # 130 green
node node_modules/prisma/build/index.js migrate deploy              # apply migrations
node node_modules/prisma/build/index.js generate                    # regenerate client after schema changes

# demo: start backend + admin, log in as any manager role →
#   GET /api/tickets (Bearer token) lists open Troubleshoot tickets with their SLA bucket.
```

Note: `pnpm exec` triggers a network deps-check that FortiGate blocks; run the vitest/prisma/tsc
binaries directly via `node node_modules/...` as above.
