# Handoff — FSM Platform, Issues 05–08 (Issue 08 in progress)

Date: 2026-06-21 · Workspace: `D:\fms_adminDashbooard\fsm-platform-greenfield`
Predecessor handoffs: `docs/progress/fsm-handoff-2026-06-17.md`, `...-mobile-shell-2026-06-18.md`

## TL;DR

Issues **05, 06, 07 are DONE** (each has a canonical progress doc — read those, don't re-derive).
**Issue 08 is mid-flight: slices 1–4 complete and green; slice 5 (escalation scan, AC#5) remains.**
One open decision is flagged below (I1 / REPEAT). All work is strict TDD; nothing is committed (the
repo is not git-initialised).

## Canonical status — read these first

- `docs/progress/05-device-state-inactivity-sla-ticket-creation.md` — device→ticket spine.
- `docs/progress/06-zone-dashboard-home.md` — Zone Operations Dashboard.
- `docs/progress/07-ticket-list-detail-drawer.md` — Ticket List + Detail Drawer (+ `ticket_events`).
- `.scratch/fsm-platform-v1/INDEX.md` — 04/05/06/07 marked `(done)`; 08 still `ready-for-agent`.
- `.scratch/fsm-platform-v1/issues/08-auto-recovery-repeat-failure.md` — the active issue + ACs.
- `docs/adr/0021-...md` — repeat-failure / immutable-VERIFIED rules (governs slices 4–5).

Current green baseline: **backend 48 files / 163 tests**, **admin 10 files / 24 tests**, both
`tsc --noEmit` clean (local PostgreSQL 18, no Docker).

## Issue 08 — what's built (this session)

New backend files under `apps/backend/src/ticketing/`:
- `recovery-criteria.ts` — pure `meetsRecoveryCriteria` (≥3 pings, ≥15-min span). Slice 1.
- `auto-recovery.service.ts` — `runAutoRecovery` (scan + close `CLOSED_AUTO_RECOVERY`, cycle→VERIFIED,
  clears `has_open_failure_cycle`, lifecycle event) and `manualClose` (ZM, zone-scoped). Slices 2–3.
  Wired in `ticketing.module.ts`.
- `ticket-creation.service.ts` — retrofitted with repeat detection (prior VERIFIED cycle ≤24h →
  new cycle `state=REPEAT`, `repeat_failure=true`, `previous_failure_cycle_id`). Slice 4.
- `tickets.controller.ts` — added `POST /api/tickets/:id/auto-recovery-close` (200 / 404 / 409).

Tests added: `recovery-criteria.spec.ts`, `auto-recovery.e2e-spec.ts`, `auto-recovery-manual.e2e-spec.ts`,
`repeat-failure.e2e-spec.ts`.

**AC status:** #1 #2 #3 #4 #6 green. **#5 (ESCALATED) is the only one left.** Issue 07's `InlineBadges`
already renders the ESCALATED + AUTO_RECOVERY conditions, so slice 5 is backend-only.

## Immediate next steps

1. **Slice 5 — escalation scan (AC#5).** Per ADR-0021 it's a daily batch: scan devices with
   `repeat_failure = true`, count `REPEAT` cycles per device in the last 7 days; if ≥3, mark the
   device's active cycle/ticket `ESCALATED` (+ lifecycle event). Build as a service method
   (e.g. `RepeatEscalationService.runEscalationScan(now)`); no cron yet (scheduling is deferred,
   same posture as Issue 04's BullMQ). TDD: seed a device with 3 REPEAT cycles in 7d → asserts
   ESCALATED; a device with 2 → not escalated.
2. **Finalise Issue 08**: tick AC boxes + `Status: done` + `Progress:` line in the issue file; mark
   `08 … *(done)*` in `INDEX.md`; write `docs/progress/08-auto-recovery-repeat-failure.md` (mirror the
   05/06/07 progress-doc format — AC table, slices, deviations, run instructions).

## Open decision (raised, awaiting user) — I1 vs REPEAT

The repeat cycle opens with `state = REPEAT` (ADR-0021), but the LLD's I1 partial-unique
(`failure_cycles_one_active_per_device`) only covers `OPEN / WAITING_COMPONENT / SUBMITTED` — **not
REPEAT**. Current code stays schema-faithful (I1 unchanged) and dedupes repeat cycles via the
`has_open_failure_cycle` flag only. Alternative: a small migration adding `REPEAT` to that partial
index so the DB-level "one active episode per device" guard also covers repeat cycles. **User asked to
pause before slice 5; confirm this choice before/with slice 5.**

## How the user works (match this)

Strict TDD, **RED → GREEN → REFACTOR, one slice at a time**; show RED proof, the impl, GREEN, and
deviations, then continue. AFK mode is active — do **not** ask "Proceed?" between slices; stop only for
(a) an architecture/backlog-ownership decision, (b) an external install, (c) a blocker, (d) issue
completion. The user surfaces genuine forks via questions (eligibility sourcing in 05, trend/export in
06, `ticket_events` in 07) and expects the same. They sometimes interrupt with "wait after slice N".

## Environment gotchas (will bite a fresh agent)

- **Run tests/typecheck via the binaries, not pnpm** (FortiGate blocks pnpm's network deps-check):
  `cd apps/backend && node node_modules/vitest/vitest.mjs run [file]` and
  `node node_modules/typescript/bin/tsc --noEmit`. Same under `apps/admin`.
- **The Bash tool's cwd resets between calls** — always `cd` into the app dir in the command. Output is
  ANSI-coloured; pipe through `sed 's/\x1b\[[0-9;]*m//g'` before grepping.
- **Shared local Postgres → occasional teardown flake** when many e2e files run together (a transient
  "1 failed / N skipped" with no failing assertion). Re-run; it goes green. Tests clean up their own
  rows; **delete `ticket_events` before `tickets`** (FK is `ON DELETE RESTRICT`).
- **Prisma migrations**: edit `schema.prisma` → `node node_modules/prisma/build/index.js migrate dev
  --create-only --name X` → hand-append raw SQL (partial-uniques / CHECKs) → `migrate deploy` →
  `generate`. `migrate dev` alone does not reliably regenerate the client.
- **Agent cannot install deps** — ask the user to run `pnpm add`. "Export to Excel" was delivered as
  CSV to avoid this; the dashboard uses inline SQL (no MV/Redis).
- DB: local PG18, role/db `fsm`/`fsm`; connection in `apps/backend/.env` (gitignored, password redacted).

## Suggested skills

- **`/tdd`** — every slice here is strict RED→GREEN→REFACTOR; invoke before writing slice 5.
- **`/triage`** — the user drives issue scope/state through it; use for any backlog/state review (e.g.
  the I1/REPEAT decision or closing out Issue 08).
- **`/run` or `/verify`** — to launch backend + admin and confirm the dashboard / ticket flows live
  against the real app (not just tests).
