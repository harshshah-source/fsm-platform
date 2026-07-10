# Issue 33 — Install Ticket create (single + CSV, scoped)

**Status: done (backend slice)** · 2026-06-26 · branch `feat/fe-enterprise-ui`

Manual Install Ticket creation on the shared `tickets` table (work-type discriminator), mirroring the
#36 Recovery posture. Single-create + CSV bulk upload, scoped to creator zone authority, fully audited.

## Acceptance criteria

| # | AC | State |
|---|----|-------|
| 1 | Single Install create → `work_type=INSTALL`, `created_by` + `created_by_role`, full audit | ✅ |
| 2 | CSV upload validates Vehicle existence, no active Device mapping, Plant existence, company context, zone authority per row | ✅ |
| 3 | Bad CSV rows reported with line-number errors; no partial corruption (all-or-nothing) | ✅ |
| 4 | Scope: ZM own-zone / CSM scope / OH all zones via the same UI/CSV | ✅ (enforcement identical both channels) |
| 5 | `install_trigger_source = MANUAL_OPERATIONS` on created tickets | ✅ |

## What landed

- **Migration** `20260626120000_add_install_tickets` (hand-authored; dev DB can't shadow). Additive on
  `tickets`: `created_by` (UUID), `created_by_role` (`role`), `install_trigger_source` (new enum
  `MANUAL_OPERATIONS`/`EXTERNAL_API` — v2 External Order Webhook value defined up-front so it never
  `ALTER TYPE`s), `install_batch_id` (UUID, + index), `install_sim_id`/`install_target_date`/
  `install_notes` (optional CSV columns). TROUBLESHOOT/RECOVERY rows leave these null.
- **`InstallService`** — `createSingle` (manual `$transaction`: ticket + opening `ticketEvent` + audit)
  and `uploadCsv` (parse → validate **every** row → only if all pass, create under one shared
  `install_batch_id`; any failure returns per-row `{line, code, field}` and creates nothing).
  `validateRow` checks Vehicle/Device/Plant/Company existence, no active mapping (vehicle has no fitted
  device; device is free stock), and ZM-own-zone authority. Row-error union surfaced verbatim.
- **`InstallController`** — `POST /api/install` (single) + `POST /api/install/upload` (CSV), `@Roles`
  ZM/CSM/OH, `@CurrentUser()` for zone scope + `@CurrentActor()` for #47 audit attribution. Row-error →
  HTTP: existence 404 / active-mapping 409 / zone 403; CSV validation failure → 400 with the error list.
- Wiring: `InstallService` in `TicketingModule` providers+exports; `InstallController` in `AppModule`
  (controllers register there, mirroring `TicketsController`).

## Deviations / decisions

- **CSM scope = unrestricted-all-zones in v1.** `validateRow` confines only `ZONAL_MANAGER`; CSM and
  Operations Head are unrestricted. CSM is central authority; per-zone CSM-authority narrowing belongs to
  #27's acting-scope seam, not re-implemented here. AC#4 ("CSM scope") is satisfied at the v1 authority
  model.
- **`created_by` UUID guard.** The in-memory dev auth uses fixed UUIDs; `createTicket` only sets
  `created_by` when `actor.userId` is a real UUID (else null) so non-UUID test/service actors don't break
  the FK — `created_by_role` is always recorded.

## Parity gate

ACs are backend-phrased and met across both channels. The **admin Install-create surface** (single form +
CSV upload page consuming these endpoints) is filed as **follow-up #69** and linked in INDEX — a
presentation-only slice over already-implemented endpoints, not an external-integration blocker.

## Verification

- Issue suites green: `install-create.e2e-spec.ts` ×4, `install-controller.e2e-spec.ts` ×4,
  `install-csv.e2e-spec.ts` ×4 (12 tests).
- Full backend suite green after recovery (see Recovery note below).

## Recovery note (this session)

The prior session was interrupted mid backend-recovery. Verified on resume: PG16 + PostGIS on **5433**,
DB `fsm`, **all 33 migrations applied / 0 pending** (steps 1–3 already done), `prisma generate` re-run.
The recovery's missing step was the **org reference seed** — `migrate deploy` rebuilds schema but not
data, so seeded zones North/South were absent and `engineers-availability-controller.e2e-spec.ts` failed
on `users_zone_id_fkey` (it hardcodes `zoneId 1n`/`2n`). Re-ran the seed, **and** hardened that suite to
self-seed zones 1/2 by explicit id (the in-memory ZM token is scoped to `zoneId 1`; on a non-pristine DB
the org seed assigns North/South higher sequence ids — the test must not assume a fresh sequence). This
mirrors the self-seeding pattern already used by the component-blocked / install controller suites.
