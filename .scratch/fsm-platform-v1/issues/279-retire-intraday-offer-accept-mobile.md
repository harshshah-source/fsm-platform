# 279 — Retire the intra-day CRITICAL offer Accept/Decline screen and its endpoints (mobile half of #268)

Status: done (2026-08-24) — see `docs/progress/268-critical-direct-assignment.md`
Type: AFK · Mobile + `@fsm/shared`
Filed: 2026-08-24, from #268's build. Recorded here per #268's own instruction ("file the mobile
screen retirement in the M-series rather than dropping it silently") and per #169's process (SE API
contract removal).

## Objective

Record, as its own tracked issue, the mobile-side retirement #268 required to ship in the same
change as its backend removal — `#268` item 4's own text: *"the backend removal and the mobile
retirement must land in one coordinated change; the pilot is not live (#197/#209 open), which is what
makes this acceptable rather than a migration problem."* This is not new work being proposed; it is
the paper trail for work already done, so a future session (or #169's own contract audit) has a named
issue to point at instead of an unattributed diff.

## What was retired (verified against the #268 diff)

**Backend endpoints** (all now 404, per #169's error-shape process): `GET /api/me/intraday-insertions`,
`POST /api/intraday-insertions/:id/accept`, `POST /api/intraday-insertions/:id/decline`,
`POST /api/intraday-insertions/sweep-timeouts`. `MeIntradayInsertionsController` deleted outright.

**Mobile screen + client:**
- `src/intraday/IntradayOfferScreen.tsx` + its test — the full-screen Accept/Decline prompt (#77).
  Deleted; nothing renders it any more.
- `src/intraday/intradayDisplay.ts` (`formatDeclineReasonLabel`, `formatAcceptByLabel`) — deleted,
  its only caller was the offer screen.
- `apiGetMyIntradayOffers`, `apiAcceptIntradayInsertion`, `apiDeclineIntradayInsertion` +
  the shared `intradayPost` helper — removed from `src/api/client.ts`.
- `SeTabShell`'s one-time mount check (offer poll → gate the tab navigator behind the offer screen)
  and its ghost-assignment toast (`INTRADAY_GHOST_ASSIGNMENT`) — both removed. The ghost toast is not
  merely unreachable, it is now provably dead: `notifyGhostAssignment` only ever fired from the
  retired `reroute()` method, so no code path can create that notification type again. `SeTabShell`
  now renders the tab navigator unconditionally, no mount-time network call.
- `TicketsScreen`'s `justAcceptedTicketId` prop (threaded from `SeTabShell` after a watched Accept) —
  removed; its source no longer exists. The "CRITICAL INSERTION" badge it drove is **not** dropped —
  `badgeFor` now derives the identical distinction from data every row already carries (the ticket's
  own `slaBucket`, checked against the same `CRITICAL`/`HIGH_CRITICAL` set the backend's
  `TRIGGER_BUCKETS` uses), so a newly-added CRITICAL/HIGH_CRITICAL ticket still earns the distinct
  label — derived from the ticket, not from a flag with no more source.

**`@fsm/shared`:** `IntradayDeclineReasonCode`, `INTRADAY_DECLINE_REASON_CODES`,
`IntradayInsertionOffer`, `MyIntradayOffersView`, `DeclineIntradayInsertionRequest`,
`AcceptIntradayInsertionResponse`, `DeclineIntradayInsertionResponse` — all removed (zero remaining
references anywhere in the monorepo, confirmed by grep before deletion). Package rebuilt
(`dist/{cjs,esm,types}`).

## What was NOT retired, deliberately

- `manualAssign` / `availableSesForManualAssign` (the ZM escalation-queue resolution) — unaffected;
  Q2's administrative right is a human action, not the acceptance machinery.
- `SE_ACCEPTANCE` as a `NotificationDeliveryModel` in `notification.service.ts` — now unreferenced by
  any caller (confirmed by grep) but left in place. It is generic notification-spine machinery, not
  intraday-specific code, and removing it touches the spine's own tests and `NotificationDeliveryModel`
  type for a cleanliness gain outside this issue's scope. Flagged here as a candidate follow-up rather
  than done silently.
- `#201` (open) — the *future* mobile push signal for "new work landed". Nothing in this retirement
  anticipates it; the assigned ticket surfaces through the existing #66 `addedIds` diff exactly as any
  other newly-appeared ticket would.

## Acceptance criteria

- [x] The offer screen, its test, and `intradayDisplay.ts` are deleted; nothing imports them.
- [x] `apiGetMyIntradayOffers` / `apiAcceptIntradayInsertion` / `apiDeclineIntradayInsertion` are
      removed from the mobile client; the retired backend routes are pinned 404 in
      `test/intraday-insertions-controller.e2e-spec.ts`.
- [x] `SeTabShell` performs no mount-time offer/notification check; ghost-assignment toast removed.
- [x] `TicketsScreen` still distinguishes a CRITICAL direct-assignment from an ordinary newly-added
      ticket, now derived from `slaBucket` instead of a threaded flag — pinned in
      `TicketsScreen.test.tsx`.
- [x] `@fsm/shared`'s retired types have zero remaining references anywhere in the monorepo; package
      rebuilt.
- [x] Full mobile suite green post-removal: 48 files / 331 tests.

## UI surfaces

Mobile: `SeTabShell` (offer gate + ghost toast removed), `TicketsScreen` (badge logic re-derived,
same visible label). No Admin surface (that is #268's own admin half — the Intra-day Queue page).

## Reference

`docs/ui/mobile/` — no reference image changes; the offer screen had no shipped reference in the
first place (#77 built it ahead of a mobile UI reference set), and its removal restores the tab
navigator to what the reference set does show.

## Blocked by

None — retroactive record of work landed inside #268.
