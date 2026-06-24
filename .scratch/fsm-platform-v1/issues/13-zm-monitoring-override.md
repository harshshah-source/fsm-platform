# 13 (13a) — ZM Monitoring & Override engine + API

Status: done
Type: AFK
Progress: docs/progress/13a-zm-monitoring-override-engine.md — monitoring reads + override engine (6 actions) + ON_SITE conflict seam + critical-queue assign; all 6 ACs green (backend 253 tests / 81 files). Admin UI is 13b.

> **Scope note (2026-06-21):** split into **13a** (this issue — backend override engine + API +
> contract tests) and **13b** (the React admin ZM monitoring/override UI). The admin UI ACs moved to
> `13b-zm-monitoring-override-admin-ui.md`. The ON_SITE conflict check is built as a seam (default
> no-conflict) because `soft_states` lands in Issue 15.

## What to build

The Batch Schedule **monitoring reads** and the **override engine + API** — **monitoring and override
only, no approval gate**. Monitoring: `GET /api/schedules` (per-SE rows: batch ticket count, date
range, `AUTO_ASSIGNED`/`OVERRIDDEN` status) and `GET /api/schedules/:engineerId` (ordered stop list +
per-ticket "Why suggested?" Recommender reasoning). Override: `POST /api/batches/:id/override` with
action — **Swap SE**, **Split Batch**, **Remove Ticket**, **Reorder**, **Defer Ticket**, **Reassign** —
each commits immediately, flips status to `OVERRIDDEN`, re-points the SE Day Plan, fires a push, and is
audited with a mandatory reason code. Override of work an SE holds `ON_SITE` on returns a conflict
payload and requires `confirm=true` + reason (audited `OVERRIDE_AFTER_ON_SITE`). Also: the Grouped
Critical Work Queue one-click assign endpoint (creates a Formal Assignment).

## Acceptance criteria

- [x] `GET /api/schedules` returns per-SE rows with `AUTO_ASSIGNED`/`OVERRIDDEN` status; no approval/countdown semantics
- [x] `GET /api/schedules/:engineerId` returns the ordered stops + per-ticket Recommender reasoning ("Why suggested?")
- [x] Swap / Split / Remove / Reorder / Defer / Reassign each commit immediately and flip status to `OVERRIDDEN`
- [x] Override propagates to the SE Day Plan and fires a push notification
- [x] Override while SE holds ON_SITE returns conflict + requires confirm + mandatory reason (audited `OVERRIDE_AFTER_ON_SITE`) — via a seam until Issue 15 wires soft_states
- [x] Grouped Critical Work Queue one-click assign creates a Formal Assignment

## Blocked by

- #11
