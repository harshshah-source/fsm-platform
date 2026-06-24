# 18 — GPS three-phase verification + outcome

Status: done
Type: AFK
Progress: docs/progress/18-gps-three-phase-verification.md — all 6 ACs green (backend +22 tests/+4 files, migration 23). No scheduler yet; plant-geofence fallback + mobile badge UI deferred. 2026-06-23.

## What to build

The `VerificationWorker` three-phase GPS auto-verification for Troubleshoot Tickets, and the SE-facing outcome. After form submission the worker watches device pings. The ±500m check applies **only** to the Phase-1 first ping, anchored on the SE's form-submission GPS (or ON_SITE geofence capture); it is skipped when `presence_source = NONE` (no fraud flag in that case). Phase-2 expects movement. Outcomes: `CLOSED` (verified), `PARTIAL_RECOVERY` (1–2 pings; ping count + 24h escalation window), `FAILED_VERIFICATION` (no pings, or fraud-flagged when Phase-1 ping is far from SE submission location — record distance delta). On mobile, each submitted Ticket shows its outcome badge (CLOSED / PARTIAL_RECOVERY / FAILED_VERIFICATION) and a PARTIAL_RECOVERY badge in VERIFICATION_PENDING when 1–2 pings arrive.

End-to-end: a submitted ticket with a valid nearby ping auto-closes; a far Phase-1 ping is fraud-flagged with a distance delta; the SE sees the outcome without calling the ZM.

## Acceptance criteria

- [x] ±500m rule applies only to the Phase-1 first ping; Phase-2 pings accepted regardless of location
- [x] Phase-1 anchored on form-submission GPS / ON_SITE capture; skipped (no fraud flag) when `presence_source = NONE`
- [x] Outcomes CLOSED / PARTIAL_RECOVERY / FAILED_VERIFICATION computed correctly
- [x] Fraud flag records distance delta when Phase-1 ping is far from SE submission location
- [x] `verification_runs` persisted with phase detail
- [x] Mobile shows outcome + PARTIAL_RECOVERY (N/3 pings) badge — backend read API (`badge` + ping count); on-screen badge with mobile ticket screens

## Blocked by

- #16
