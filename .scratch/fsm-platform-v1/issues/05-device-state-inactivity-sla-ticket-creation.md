# 05 — Device state + inactivity + SLA bucket + ticket creation

Status: done
Type: AFK
Progress: DONE (2026-06-20) — strict TDD slices 1–7. All 6 AC green; backend 130 tests / 38 files,
typecheck clean (local PG18). Eligibility uses minimal real pgi_history + non_operational_markings
(Option 1). Deferred (flagged): audit-on-create → Issue 03 spine; pipeline orchestration/scheduling
→ later worker; repeat-failure → Issue 08. See docs/progress/05-device-state-inactivity-sla-ticket-creation.md.

## What to build

The core tracer bullet from raw telemetry to an open Ticket. `DeviceStateService` normalizes raw snapshots into `device_states` (latest GPS, `is_inactive`, `sla_bucket`). The SLA Bucket classifier maps inactivity age to a `BucketKey` (WARNING 4–8h · EARLY_RISK 8–12h · RISK 12–24h · CRITICAL 24–48h · HIGH_CRITICAL 48–72h · SEVERE 3–5d · VERY_SEVERE 5–7d · LONG_PENDING 7d+; ACTIVE 0–4h never enters queues). `TicketCreationService` opens a `failure_cycle` + `ticket` for each newly-inactive **eligible** device (eligibility-gated: active PGI within ~15 days AND not Non-Operational), enforcing the duplicate-active-ticket invariant (one open Troubleshoot ticket per device).

End-to-end: an inactive eligible device from a snapshot reliably produces exactly one Troubleshoot Ticket with the correct SLA bucket, visible via `/api/tickets`.

## Acceptance criteria

- [x] SLA Bucket classifier is a pure function; full boundary set tested (0, 4, 8, 12, 24, 48, 72, 120, 168+ h)
- [x] `device_states` upserted with `is_inactive` and `sla_bucket` from latest snapshot
- [x] One `failure_cycle` + `ticket` created per newly-inactive eligible device
- [x] Eligibility gate applied (active PGI ~15 days AND not Non-Operational)
- [x] Duplicate active Ticket prevented (no second open ticket for the same device/cycle)
- [x] Tickets retrievable via `/api/tickets/*`

## Blocked by

- #04
