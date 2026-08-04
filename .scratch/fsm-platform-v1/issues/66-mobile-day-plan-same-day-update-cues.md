# 66 — SE mobile Day Plan: highlight ZM-added Tickets + one-session "removed" label

Status: done
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

- [x] A ZM-added Ticket highlights (client set-diff vs cached plan) — **relocated**: a "Newly Added" badge on the Tickets-list row, sorted to the top of its urgency section, not "top of its plant group" (see 2026-08-04 comment — that structure no longer exists)
- [x] A ZM-removed Ticket shows a one-session "removed" label (from the client cache), then clears on next cold start
- [x] SE receives the "plan updated by [ZM]" push — delivery seam is Issue 03's existing spine; nothing new needed from this issue

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

- `docs/ui/mobile/home-dashboard.png` (SE Day Plan / plant groups)

## Tests (TDD targets — red first)

- Cached {A,B} → live {A,B,C}: C highlighted at top of its plant group.
- Cached {A,B} → live {A}: B shows the removed label this session; gone after a simulated cold start.
- No cache → no cues.

## Blocked by

- #31
- #54

## Comments

### 2026-08-04 — cue location relocated to the Tickets list, per operator decision; DONE

This issue's "highlight at top of its plant group" assumes a per-ticket, plant-grouped Day Plan
view. That structure doesn't exist in the ratified mobile screens: **Home** (#55, #172 Decision 1)
shows Plant Workload as aggregate ratio cards ("3/5 done"), not individual ticket rows; **Tickets**
(#56, #172 Decision 3) merged the day-plan/pool split into one list grouped by *urgency* (Visit Now /
Other), not by plant. #66 is conspicuously absent from #172's own ratification-propagation list
(which explicitly touched #55, #56, #58, #60, #61, ...) — it predates that restructuring and was
never reconciled against it. Flagged to the operator rather than guessing at a UI-location decision;
answer: **land the cue on the Tickets list as a badge per row**, no new plant-grouped structure.

Built exactly as decided: `TicketCard` gained an optional `badge` prop (`Newly Added` / `Removed`).
`dayPlanCues.ts` implements the already-adopted Option A contract (client-side set-diff, in-memory,
resets on cold start = "one session") — diffed against `/me/tickets`' `assigned:true` set (which
`TicketsScreen` already fetches) rather than opening a separate `/schedules/me` fetch/cache just for
this, since the two ticketId sets track the same underlying fact for this purpose. Added tickets sort
to the top of their urgency section; removed tickets are reconstructed from the cached full
`MeTicketRow` (not just an id) and placed in their correct section since `workState` travels with the
cached row. The push delivery AC needed nothing new — Issue 03's spine already carries it.

207 mobile tests green, `tsc`/`eslint` clean both apps.

### 2026-08-04 — the server signal this issue's "Option B" anticipated now exists (and has no reader)

Recorded from the cross-surface contract audit (`audit/mobile-contract-sync-audit-2026-08-04.md`,
finding D1). **Not a criticism of the Option A decision** — it was correct on the information
available, and its stated Option B trigger (per-ticket "[ZM Name]" attribution) is still unmet.

What changed: #161 (DONE 2026-08-03) added `removedFromPlanAt` and `deferredToDate` to every
`/api/me/tickets` row (`me-tickets-query.service.ts:61-68,127-128`; contract at
`packages/shared/src/index.ts:103-114`). Those fields have **zero production readers** in
`apps/mobile/src` — only three test fixtures reference them.

Two consequences of the client-diff approach that were not weighed at decision time, because the
server signal did not exist yet:

1. **Cold start shows nothing.** `dayPlanCues.ts:23-26` returns no cues on the first call after
   launch, so a removal that happened while the app was closed is invisible — the SE can travel to a
   plant that left their plan hours earlier. `PRD:510` requires the SE be *told*.
2. **DEFER and REMOVE are indistinguishable.** The server distinguishes them (`deferredToDate` is set
   only for a defer; `override.service.ts:23-24,:129-158,:165-210`), but `TicketsScreen.tsx:149,172`
   render one generic "Removed" badge with no return date.

Also stale: this module's own comment at `dayPlanCues.ts:12-19` still says *"the server has no
'added/removed since' signal"*.

Whether to switch is a product call, not a mechanical one — filed as
[#200](./200-decision-deferred-vs-removed-presentation.md) (defer presentation + cold-start
durability), with implementation at [#201](./201-mobile-consumes-server-day-plan-signal.md). If #200
rules that session-scoped is correct, the fields stay unread **by decision** and that is recorded here
so the next reader stops rediscovering it.
