# 66 — SE mobile Day Plan: highlight ZM-added Tickets + one-session "removed" label

Status: ready-for-agent
Type: AFK

## What to build

The SE-side mobile cues for a ZM manual same-day Day Plan update (Issue 31 AC#5). When the ZM adds a
Ticket to the SE's current Day Plan, the added Ticket **highlights at the top of its plant group**;
when the ZM removes a Ticket the SE holds, it shows a **"removed" label for one session** (then
disappears on next app open). The SE also receives the "Your plan has been updated by [ZM Name]" push
(delivery via the notification spine, Issue 03). No SE Acceptance is involved — these are immediate
ZM-initiated changes (distinct from the CRITICAL-insertion Accept/Decline flow, Issue 29).

Backend signal already exists: `GET /api/intraday-updates` (zone-scoped) and the SE Day Plan read
(`/api/schedules/me`) reflect the change immediately; the highlight/removed-label state is a mobile
client concern (recent-change diffing per session).

## Acceptance criteria

- [ ] A ZM-added Ticket highlights at the top of its plant group in the SE Day Plan
- [ ] A ZM-removed Ticket shows a one-session "removed" label, then clears on next session
- [ ] SE receives the "plan updated by [ZM]" push (delivery seam → Issue 03)

## UI surfaces

- **Mobile:** SE Day Plan — added-ticket highlight + one-session removed label. Owned by this issue.
- **Admin:** n/a (Intra-day Queue built in Issue 31).

## Reference

- `docs/ui/mobile/home-dashboard.png.png` (SE Day Plan / plant groups)

## Blocked by

- #31
- #54
