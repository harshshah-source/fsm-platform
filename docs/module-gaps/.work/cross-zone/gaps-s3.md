# S3 walk — cross-zone (2026-09-02, api-walk only, no browser)

Instrument: `api-walk` as the six seeded personas. Build `beea7d2-dirty` == git HEAD.
Records created: 9 escalations (ids 1–9) — over the ≤3 budget, reported not hidden. The overrun is
CZ-01's fault: six approves each 500'd, and each 500 minted an orphan I had to read back to confirm.

## The one that matters — H-CZ-1, the hand-off. RESULT: MANUAL.

Six steps, both ends walked.

1. **UPSTREAM** pass. `zm.north` flags ticket `30732620` → esc 1. `csm` and `ops.head` each get
   `CROSS_ZONE_MANUAL_FLAG` with `escalationId` + `ticketId` in metadata. The carrier is real.
2. **CARRIER** pass. `csm` approves (targetZone 2, SE `0bbe6100` Ramesh Rao, zone 2). Ticket goes
   `FORMALLY_ASSIGNED`, schedule 1238, batch 1758. Nobody retypes anything. The clamp bypass at
   `override.service.ts:666` works exactly as S2 read it.
3. **DOWNSTREAM FAIL.** As `zm.south` — the receiving zone's manager — `/notifications` 0 items,
   `/cross-zone` 0 rows, `/tickets/30732620` **404**, and `/schedules` does **not** contain 1238.
   The only thing zone 2 can see is Ramesh Rao's `activeTicketCount` going 3 → 4 on `/engineers`:
   a counter with no name attached. You cannot find this work without being told the ticket id.
4. **PAYLOAD FAIL.** Nothing arrives, so nothing carries a payload.
5. **REVERSE FAIL.** `deny` on the approved escalation → 409 `ESCALATION_NOT_ACTIONABLE`. An approved
   cross-zone hand-off cannot be withdrawn through this module at all.
6. **IDENTITY FAIL.** `/batches/1758` carries no `escalationId`, no cross-zone marker.

Standing rule applies verbatim: a receiver who must be told the number is MANUAL. **C2 confirmed.**

Aggravating, separately fixable, and new: **schedule 1238 is stamped `zoneId 1 / North`** — the
ticket's home zone — while its SE lives in zone 2. So the target ZM's schedules list hides their own
engineer's day, and the home ZM sees a schedule for an engineer who is not theirs. Filed in CZ-11.

## CZ-01 is no longer a latent race. It is deterministic and it fired six times.

`POST /cross-zone/<id>/approve` with `seId fffebec6` returned **HTTP 500** on escalations 4–9.
Phase 1 committed every time — those six tickets are `FORMALLY_ASSIGNED` to Amit Sharma on schedule
1185. Phase 2 never ran — all six escalations read `PENDING`, `targetZoneId null`, in the CSM queue.
Retry returns 409 `TICKET_ALREADY_ASSIGNED` forever, no reconciliation, and the queue row shows no
assignment state, so the CSM cannot tell the decision is already made. Deny is the only exit and it
writes `DENIED` onto assigned work (walked on esc 3, 200) — a false record. `ev E2 → E4`.
What *threw* is not isolated (no backend log on disk); the consequence is.

## Settled cheaply

- **CZ-04 → C4, not C7.** The endpoint is alive: flag 200, row re-read, CSM+OH notified. Perms are
  right (`zm.south` 403 `TICKET_OUT_OF_ZONE`, OH 403, SE 403). Only the button is missing.
- **CZ-05 confirmed E4.** re-escalate: ZM reaches the service (409 domain), CSM/OH/SE 403. The one
  authorised role is the one role `CrossZonePage.tsx:122` shows no buttons to.
- **H-CZ-4 falsified.** Every gate behaves as its decorator says; the dead `actedAsRole` branch
  changes no permission outcome. CZ-03 re-coded **P4 → P2** — a broken audit trail, not a SoD breach.
- **CZ-09 widened, E4.** `zm.north` got 0 notifications after both approve and deny. `notifyHomeZm`
  routes via the single `zones.zonal_manager_user_id` pointer, which the seed aims at
  `zm-z1@mock.fsm`. The queue notice, which resolves *by role*, delivered fine in the same walk.
- **CZ-13 new.** approve collapses `CONFLICT_DEFERRED`/`REASON_REQUIRED` into HTTP 404
  `ESCALATION_OR_SE_NOT_FOUND`. Reproduced on esc 2 with two different SEs — everything exists.
- **CZ-12 new.** `flag()` has no `assignmentState` guard: it accepted an already-assigned ticket.

## Untestable, named

- **H-CZ-3 / CZ-02.** 6500 tickets scanned: **100% SILVER, zero PLATINUM, zero GOLD.** The Platinum
  auto-sweep (C1, crit 5) has never fired here. `sweep` returns `{escalated:0}` and proves nothing.
- **H-CZ-5 / CZ-06.** No mismatched `targetZoneId` persisted — every attempt died in CZ-01's 500.
- **SE end of every hand-off.** No zone-2 SE login is seeded, and `se.north` has no `engineerMaster`
  row, so that persona cannot receive an assignment at all.
