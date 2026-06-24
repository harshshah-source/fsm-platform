# 26 — Leave request + SOFT_UNAVAILABLE

Status: accepted (backend + ZM admin approvals page done; mobile SE submit/PENDING badge → M-series)
Type: AFK
Progress: docs/progress/26-leave-soft-unavailable.md — AC#1–#5 backend + admin `/leave-requests` page. Migration `20260624180000_add_leave_request`. SOFT_UNAVAILABLE exclusion+auto-revert reuse Issue 25's windowed model. Mobile SE submit/PENDING + ZM notify → M-series/#03 seams. 2026-06-24.

## What to build

SE-initiated availability flows. **Leave Request**: SE submits from mobile (type ON_LEAVE / WEEKLY_OFF + date range) for ZM approval; ZM receives in-app notification; SE sees PENDING badge. ZM **approves** → SE notified, `se_availability` updated, Recommender excludes the SE for the approved window before batches are generated; ZM **rejects** → SE notified with reason, can revise and resubmit. **SOFT_UNAVAILABLE flag**: SE sets a from/to window from mobile; during it the SE is excluded from intra-day candidate scoring and the ZM is notified; at `to_ts` availability auto-reverts to AVAILABLE.

End-to-end: an SE files leave, the ZM approves it, and the Recommender stops considering that SE for the window.

## Acceptance criteria

- [x] SE submits leave (ON_LEAVE / WEEKLY_OFF + range); ZM notified (seam #03); SE sees PENDING (mobile → M-series)
- [x] ZM approve updates `se_availability` and excludes the SE from candidate scoring for the window
- [x] ZM reject notifies the SE with reason (seam #03); SE can revise and resubmit
- [x] SOFT_UNAVAILABLE window excludes the SE from intra-day scoring (recommender Hard Filter) and notifies the ZM (seam #03)
- [x] SOFT_UNAVAILABLE auto-reverts to AVAILABLE at `to_ts` (time-windowed model — no cron)

## UI surfaces

- **Admin:** ZM Leave Requests approvals page (`/leave-requests`) — own-zone leave list + Approve /
  Reject (mandatory reason). Built here. (No dedicated v2 mockup; modeled on the queue pattern.)
- **Mobile:** SE leave submit + PENDING badge + SOFT_UNAVAILABLE set — **blocked-by Mobile Foundation
  #54**, deferred to the M-series.

## Blocked by

- #25
