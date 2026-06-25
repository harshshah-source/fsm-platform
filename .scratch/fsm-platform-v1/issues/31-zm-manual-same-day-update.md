# 31 — ZM manual same-day update + ON_SITE conflict warning

Status: ready-for-agent
Type: AFK

## What to build

The ZM manual same-day update path (distinct from the system-triggered CRITICAL flow). From SE Management or Batch Schedule Detail, the ZM adds, removes, or reorders Tickets on an SE's current Day Plan at any time during the shift. The change applies immediately — **no SE Acceptance required** — and a push fires on the SE's device ("Your plan has been updated by [ZM Name]."). If the update removes a Ticket on which the SE holds an ON_SITE soft state, an explicit conflict warning banner shows and the ZM must confirm with a mandatory reason code. The Intra-day Queue logs each change as a `MANUAL_ZM_UPDATE` row (ZM name, action add/remove/reorder, affected Ticket, timestamp). On the SE app, added Tickets highlight at top of the affected plant group; removed Tickets show a "removed" label for one session.

## Acceptance criteria

- [ ] ZM can add / remove / reorder Tickets on an SE's current Day Plan; change applies immediately
- [ ] No SE Acceptance required; SE receives "plan updated by [ZM]" push
- [ ] Removing an ON_SITE Ticket shows a conflict warning + mandatory reason code (audited)
- [ ] Intra-day Queue logs a `MANUAL_ZM_UPDATE` row with ZM, action, ticket, timestamp
- [ ] SE app highlights added Tickets and shows a one-session "removed" label — **mobile → Issue 66** (blocked-by Mobile Foundation #54)

## UI surfaces

- **Admin:** Intra-day Queue (`/intraday`) — built in this issue (slice 4).
- **Mobile:** SE Day Plan added-ticket highlight + one-session removed label → **Issue 66** (blocked-by #54).

## Reference

- `docs/ui/desktop/v2-reference/13-intraday-queue.png` (Intra-day Queue — this issue)
- Mobile: `docs/ui/mobile/home-dashboard.png.png` (SE Day Plan → Issue 66)

## Blocked by

- #11
