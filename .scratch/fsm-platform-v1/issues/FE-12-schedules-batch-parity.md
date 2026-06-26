# FE-12 — Schedules + Schedule Detail parity

Status: done (per-ticket badges → #71)
Type: AFK · Frontend · Phase F3
Effort: M

> Governed by `DESIGN-SYSTEM.md` §8/§9. Global DoD applies.

## What to build

Bring `SchedulesPage` + `ScheduleDetailPage` to parity with `12`: KPI `MetricStrip`, left SE list with
plant-grouped assigned `TicketCard`s (AUTO badge), right selected-SE day-plan with stop cards + position/
shift controls + PARTIAL/CRITICAL badges. **Omit the "Approve" gate** (Decision §7 removed it — render
the `AUTO-ASSIGNED` framing instead). Override flow preserved.

## Dependencies

- FE-03, FE-04

## Acceptance criteria

- [x] Batch board matches `12` (SE list + selected-SE day plan), minus the Approve gate (documented deviation)
- [~] MetricStrip + per-ticket card badges (tier/bucket/PARTIAL/CRITICAL) — MetricStrip done; per-ticket badges → #71 (no un-gated ticket-state on the payload)
- [x] ZM override / reorder actions preserved (existing API + selectors)

## Outcome (done with follow-up — presentation-only, FE-12)

- **SchedulesPage** → `PageHeader` + `MetricStrip` (Schedules / Auto-Assigned / Overridden / Tickets) +
  the canonical `DataTable`. No Approve action, no `approval-countdown` (gate removed — Decisions §7);
  `Batch Schedules` aria-label, `schedule-status-*` test ids, and row→`/schedules/:seId` preserved.
- **ScheduleDetailPage** → reskinned onto tokens + `Button`/`Badge`: AUTO framing on each stop card, the
  ordered stop list, and the full ZM override surface (Remove/Defer/Reassign per ticket; Swap/Split/
  Reorder per stop; the ON_SITE conflict banner). Every test id (`schedule-stop`, `ticket-row-*`,
  `schedule-status-*`, `onsite-conflict-banner`), the override-control labels, the mandatory-reason
  gating, the `POST /api/batches/:id/override` commands, and the conflict-confirm flow are all preserved.

**Documented deviation (Decisions §7):** the mockup's "Approve" gate is omitted — `AUTO-ASSIGNED` framing
is rendered instead.

**Accepted-with-follow-up (#71):** reference 12 shows per-ticket PARTIAL/CRITICAL/tier card badges, but
`ScheduleStopTicket` carries only `ticketId`/`sortOrder`/`reasoning`, and the reasoning (tier/bucket) is
gated behind "Why suggested?" and must stay hidden (asserted by `schedule-detail.test.tsx`). Surfacing
un-gated ticket-state needs a payload enrichment → filed as #71. Everything else ships.

Verified: admin `tsc --noEmit` clean · vitest **98/98** · `vite build` OK.

## Reusable components introduced

- `DayPlanBoard`, `ScheduleStopCard` (composition)

## Affected pages

- `SchedulesPage`, `ScheduleDetailPage` (**[RP]**)

## Reference

- `docs/ui/desktop/v2-reference/12-batch-schedule-review.png`

## Verification

- `schedules-list.test.tsx`, `schedule-detail.test.tsx`, `schedule-override.test.tsx` green; Playwright ≈ `12`
