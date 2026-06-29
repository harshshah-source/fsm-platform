# 66 — SE mobile Day Plan: highlight ZM-added Tickets + one-session "removed" label

Status: ready-for-agent
Type: AFK · Mobile

## What to build

The SE-side mobile cues for a ZM manual same-day Day Plan update (Issue 31 AC#5). When the ZM adds a
Ticket to the SE's current Day Plan, the added Ticket **highlights at the top of its plant group**;
when the ZM removes a Ticket the SE holds, it shows a **"removed" label for one session** (then
disappears on next app open). The SE also receives the "Your plan has been updated by [ZM Name]" push
(delivery via the notification spine, Issue 03). No SE Acceptance is involved — these are immediate
ZM-initiated changes (distinct from the CRITICAL-insertion Accept/Decline flow, Issue 29/77).

## Business rules (authority)

- PRD §510 Flow 1 step 4 (added highlighted at top of affected plant group; removed shows "removed"
  label for one session). Issue 31 AC#5.

## Change-detection contract (DECISION — Option A adopted; no new backend)

The SE has **no server "added/removed since" signal**: `GET /api/schedules/me` returns only live
`{ ticketId, sortOrder }` per plant **with removed rows filtered out** (`removedAt: null`), and
`GET /api/intraday-updates` is **manager-RBAC** (not callable by an SE).

- **Option A (adopted):** the client caches the previous `/schedules/me` ticketId set per plant group.
  On refresh it set-diffs: **added** = ids new to the set → highlight at top of the plant group;
  **removed** = ids gone from the set → render a one-session "removed" label reconstructed from the
  cached previous row (the server no longer returns it). "One session" = until the next cold app start.
- **Option B (only if per-ticket "[ZM Name]" attribution on the cue is required):** add an SE-scoped
  same-day change-feed endpoint (new backend issue). Not adopted unless the attribution becomes a hard AC.
- The "plan updated by [ZM]" **push** delivery → Issue 03 spine (in-app today; external channels → #76).
  The [ZM Name] attribution rides the push payload, not the cue diff.

## Acceptance criteria

- [ ] A ZM-added Ticket highlights at the top of its plant group in the SE Day Plan (client set-diff vs cached plan)
- [ ] A ZM-removed Ticket shows a one-session "removed" label (from the client cache), then clears on next cold start
- [ ] SE receives the "plan updated by [ZM]" push (delivery seam → Issue 03)

## API contract (authority: backend on `main`)

- `GET /api/schedules/me` → `DayPlanView` (see Issue 55). Removed rows are absent (`removedAt: null` filter)
  — removals are detectable ONLY by diffing against the client's cached prior set.

## Permissions

- SE reads own plan only. `/api/intraday-updates` is manager-only and MUST NOT be called by the app.

## Offline behaviour

- The cached prior plan is the diff baseline; offline → no diff until the next successful `/schedules/me`.

## Edge cases & failures

- First-ever load (no cache) → no highlights/labels (nothing to diff against).
- Cold restart clears the "removed" labels (one-session semantics).

## UI surfaces

- **Mobile:** SE Day Plan — added-ticket highlight + one-session removed label. Owned by this issue.
- **Admin:** n/a (Intra-day Queue built in Issue 31).

## Reference

- `docs/ui/mobile/home-dashboard.png.png` (SE Day Plan / plant groups)

## Tests (TDD targets — red first)

- Cached {A,B} → live {A,B,C}: C highlighted at top of its plant group.
- Cached {A,B} → live {A}: B shows the removed label this session; gone after a simulated cold start.
- No cache → no cues.

## Blocked by

- #31
- #54
