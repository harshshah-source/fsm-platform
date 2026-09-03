# 367 — The mobile Tickets screen consumes the SE poll contract

Status: `ready-for-agent` — filed 2026-09-03 as the surfacing half of [#360](./360-se-poll-contract.md)

**Blocked by:** #360 (done, `042aa0b`)
**Parent slice:** #360 · **Plan:** `docs/module-gaps/IMPLEMENTATION-PLAN.md` §4 slice 360

## Why this exists

#360 rebuilt `GET /me/tickets` — keyset paging, a fifth `VEHICLE_UNAVAILABLE` work state carrying
the report that explains the wait, and a `total`. The endpoint is backward-compatible, so nothing
regressed and the app still works. **But the user-visible half of #360 AC2 lands only when the
screen renders it.**

The defect #360 set out to fix is an engineer's experience: they file vehicle unavailability, the
ticket disappears from their list, they conclude work has vanished and ring the dispatcher to ask.
The backend now returns that ticket. Until `TicketsScreen` renders it, the SE still sees it
disappear — the fix exists and nobody in the field can tell.

The same applies to paging: the contract is bounded now, but a client that ignores `cursor` and
`total` still pulls whatever the server's default page happens to be and shows no more, silently.

**This is a surfacing gap, not an external-integration blocker.** Plan §4 scoped #360 to the
backend ("the mobile list that renders it is out of scope"), which is why #360 is correctly marked
done — but the app shell exists, so the parity gate's deferral exemption does not apply and this
cannot be left unfiled. It is filed here rather than silently deferred.

## Acceptance criteria

- [ ] `TicketsScreen` renders a `VEHICLE_UNAVAILABLE` ticket in the list rather than dropping it,
      labelled with why it is waiting (`workStateLabel` already has the entry, added by #360).
- [ ] The VU detail the contract carries (`expectedFrom` / `expectedTo` / `reasonCode`, IST dates)
      is shown on the row or its detail, so the SE knows when the work returns rather than only
      that it is blocked.
- [ ] The screen pages: it sends `take`/`cursor` and appends on scroll (or an explicit "load more"),
      and stops exactly when `cursor` comes back null.
- [ ] A junk cursor 400s by contract — the screen must not retry it in a loop. Handle it by
      restarting the walk from page one, once.
- [ ] `total` is used where the screen already implies a count, rather than counting loaded rows.
- [ ] Tests under `apps/mobile/src/navigation/screens/` cover the VU row and the paging walk.

## Notes for whoever takes it

- The contract types are in `packages/shared/src/index.ts` (`MeTicketRow.vehicleUnavailability`,
  `MeTicketWorkState`, `MeTicketsSection`, `MeTicketsView.cursor | total`). The package's `dist/` is
  gitignored — run `npm run build` in `packages/shared` after pulling.
- `apps/mobile/src/tickets/ticketDisplay.ts` already maps the fifth state to a label.
- The five mobile test fixtures #360 touched show the shape the screen will receive.
- Read `docs/ui/mobile/` for the authoritative reference before changing the screen; match it,
  do not redesign.
- Still open from #360, and not this issue's job: `SWAP_SE` and `moveTickets` are batch-level in
  their producer, so their notices name the plant but not a ticket — the payload accepts a ticket
  ref the moment a producer has one.
