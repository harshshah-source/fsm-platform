# 116 — SAP PGI feed: `pgi_history` has no writer (canonical eligibility permanently empty)
Status: ready-for-human
Type: HITL (external access + SAP contract)

> Source: SYSTEM-STATE-2026-07 audit (2026-07-10). #112 shipped the `eligibility_mode` mechanism
> (pgi | all-deployed) and its runbook, and review B7 records the *decision* as pending — but no
> issue owns building the feed that would make `pgi` mode real. This stub closes that ownership gap.

## Evidence

- `prisma/schema.prisma:1830-1832` — "the SAP integration that populates it is external (deferred),
  rows seeded directly for now". `grep pgi_history apps/backend/src` → read-only in
  `device-state.service.ts:64`; no writer anywhere.
- INDEX.md funnel table: ticket creation "Paused (business) — `eligibility_mode='pgi'` over empty
  `pgi_history` → 0 eligible".
- 2026-07-07 production validation audit: "Fleet-Uptime is structurally empty because the pipeline
  does not ingest PGI."

## Scope ("build the seam" applies — external integration)

1. Define the PGI source contract with Ops/SAP (file drop? API? table in AutoPlant MySQL?).
2. Build a `PgiFeedSource` port + sync service in the ingestion module (same run-ledger +
   idempotent-upsert posture as master sync; natural key `(device_id, pgi_date, order_ref)`).
3. Backfill history far enough to make the ≤15-day window meaningful at cutover.
4. Flip `eligibility_mode` back to `pgi` (audited) once reconciliation passes.

## Blocked by

External access (SAP/Ops-Head) — same HITL family as #96's R13 tier feed. Until then the
`all-deployed` proxy (#112) is the only path to a live ticket funnel.

## Acceptance criteria

- [ ] `pgi_history` is populated by a scheduled, run-ledgered, idempotent sync.
- [ ] `/api/integration/health` reports PGI feed freshness alongside masters/telemetry.
- [ ] Fleet-Uptime denominator becomes non-degenerate in `pgi` mode.
