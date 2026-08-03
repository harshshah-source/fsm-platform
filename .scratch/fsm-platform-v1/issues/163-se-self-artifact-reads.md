# 163 — SE self-artifact reads (my vouchers, my leave, my pending intraday offer)

Status: **✅ DONE (2026-08-03)** — all seven reads built. Item 4 (recovery ticket read) was already
satisfied by [#161](./161-se-ticket-read-surface.md) item 1 (`GET /api/me/tickets/:id`, commit
`13d4a10`) — owned there per this issue's own instruction, no new code needed. Items 1/2/3/5/6/7
landed this session. See the dated comment below for scope and judgment calls on each.
Type: AFK · Backend

Filed 2026-07-28 (`docs/status/backend-mobile-readiness-plan-2026-07-28.md` §B N10, §A-§1.2).
Three "one-way street" gaps: the SE can create artifacts they can never read back.

## What to build

1. **My vouchers** — `GET /api/me/vouchers` (or SE branch on `GET /api/vouchers`): the SE's own
   vouchers with status/review outcome. Today `GET /vouchers` is `REVIEW_ROLES` only
   (`vouchers.controller.ts:100-101`, `:26`) — an SE creates (`:62-64`) and resubmits (`:161-163`)
   blind. Consumed by Mobile M7 (#61) "voucher status list" (PRD story 100).
2. **My leave requests** — same shape; `GET /leave-requests` is manager-only
   (`leave-request.controller.ts:66-67`). Consumed by M8b (#86).
3. **My pending intraday offer** — `GET /api/me/intraday-insertions` (pending offer + deadline).
   `GET /intraday-insertions` is manager-only (`intraday-insertion.controller.ts:37-38`); after an
   app restart the SE's live offer is recoverable only by scraping notifications. Consumed by
   M8e (#77) for offer-screen recovery.

All three: keyed on the token's `user_id`, list bounded (`take` + cursor consistent with #165's
pagination contract).

## Acceptance criteria

- [ ] SE lists own vouchers with statuses; never another SE's; review roles unchanged
- [ ] SE lists own leave requests with statuses; never another SE's
- [ ] SE reads own PENDING intraday offer (with expiry deadline); NOT_OFFERED/none → empty, not 403
- [ ] All three bounded + paginated per the #165 contract shape
- [ ] Contracts documented for #61/#86/#77 to pin against

## UI surfaces

n/a (backend contract; screens owned by Mobile #61, #86, #77).

## Reference

n/a.

## Blocked by

- None. Non-blocking for mobile start; blocks completion of M7/M8b/M8e. Align pagination with #165.

## Comments

### 2026-07-28 — widened from 3 to 7 reads (freeze plan §1.1, F2.3)

The field-level screen derivation found this is not three gaps but **seven one-way streets** — the SE
can write and never read back. Add to the three already scoped:

4. **Recovery ticket read** — `recovery.controller.ts` has **no SE-callable GET** at all; its four
   reads (`:86,:93,:100,:107`) are manager/WM. Install has one (`install.controller.ts:216`) and is
   the model to mirror. *(Also listed in #161; own it in exactly one place.)*
5. **Component requests** — manager-only (`component-request.controller.ts:27,:37`), yet the SE is
   the one who must `confirm-receipt` (`:43`). They confirm something they can never read, and the
   Inventory screen's `2 Active` list has no source.
6. **Vehicle-unavailability reports** — `GET /vehicle-unavailability` is manager-only (`:86`) and the
   POST returns only `{result, id}`, so the "expected back on [date]" state cannot be rendered.
   **Withhold the secondary SLA clock** — `primarySlaSeconds`/`secondarySlaSeconds`
   (`vehicle-unavailability.service.ts:134-135`) are manager-only by design (PRD §299) and must not
   leak into the SE variant.
7. **Own availability window** — the SE can set it (`engineers.controller.ts:203`, returns
   `{result, id}`) but only the manager `GET /engineers/:seId` (`:192`) returns
   `availabilityRows[{status, windowStart, windowEnd, reason, setByRole}]`. #87's AC ("current
   availability state + active window shown") is unbuildable today.

**Field detail for the three originally scoped:**
- Vouchers need `plantName` (the manager row carries only a numeric `plantId`,
  `vouchers.service.ts:457`), `reviewNotes` (the rejection reason the SE must act on to resubmit),
  reviewer name, and the rollups the screen shows (`claimed total`, `pending`, `approved`).
- Leave needs `decisionReason` — already built on `LeaveRequestRow`
  (`leave-request.service.ts:138-149`), just behind the wrong role.
- Intraday needs **`acceptanceDeadline`** — the countdown input. Without it the offer screen cannot
  render its timer, and after an app restart the live offer is unrecoverable.

All seven follow **#169**'s envelope + **#165**'s cursor conventions.

### 2026-08-03 — items 1/2/3/5/6/7 landed; issue DONE

Every read now returns `{items, cursor: null}` — the envelope-now/cursor-later convention #161
item 2 established (real pagination is #165's job; `cursor` stays `null` until it lands).

**Item 1 — `GET /api/me/vouchers`** (`src/vouchers/me-vouchers.service.ts` +
`me-vouchers.controller.ts`). Every status, not just the manager queue's active-review bucket, so an
SE sees APPROVED/REJECTED/PAID history. `plantName` resolved via a separate `Plant` lookup —
**`ExpenseVoucher.plantId` has no Prisma relation to `Plant`** (bare FK only), same schema gap
already found on `Ticket`→`Plant` elsewhere. `summary` (`claimedTotal`/`pendingCount`/
`approvedCount`, per `docs/ui/mobile/vouchers.png`'s KPI tiles) is computed over the caller's FULL
voucher set, independent of the bounded `items` page. **Judgment call — status bucketing**:
`pendingCount` = `SUBMITTED ∪ ZONAL_MANAGER_REVIEW ∪ NEEDS_CLARIFICATION` (the image shows two
visually distinct "Pending"/"Manager Review" pills that both map here); `approvedCount` =
`APPROVED ∪ PAID` (PAID is a downstream state of an approval, not a separate SE-facing outcome).
`SUBMITTED`/`DRAFT` are dead states in the current create flow (`create()` always lands a voucher
straight into `ZONAL_MANAGER_REVIEW`) but handled for schema completeness. **New unbuilt gap found,
not this issue's to fix**: `docs/ui/mobile/vouchers.png`'s create form has a free-text
"Description" field with no backing column anywhere (`ExpenseVoucher`/`ExpenseVoucherItem`) — a
write-side gap, out of scope for a reads-only issue; flagged for whoever owns the SE Vouchers screen
build (#61) or the photo/notes contract (#81).

**Item 2 — `GET /api/me/leave-requests`** (`leave-request.service.ts` `listForSe` +
`me-leave-requests.controller.ts`). Smallest of the seven — `decisionReason` was already on
`LeaveRequestRow`, just behind `MANAGER_ROLES`. Extracted the row-mapper (`toRow`) so
`listForZone`/`listForSe` share one definition instead of two copies.

**Item 3 — `GET /api/me/intraday-insertions`** (`intraday-insertion.service.ts`
`getMyPendingOffers` + `me-intraday-insertions.controller.ts`). Deliberately narrower than the other
six: only `PENDING_ACCEPTANCE` offers `offeredSeId === seId` — the caller's currently-live offer(s),
not history. This is what the AC actually asks for ("own PENDING intraday offer") and what the offer
screen needs to recover after an app restart; an ACCEPTED/DECLINED/TIMED_OUT row is not "pending"
and is out of this read's scope. Empty list (not 403) when nothing is offered, per the AC.

**Item 5 — `GET /api/me/component-requests`** (`component-request.service.ts` `bySe` +
`me-component-requests.controller.ts`). Reused `buildRows` as-is (the manager oversight row has no
manager-only field to withhold, unlike vehicle-unavailability) — `bySe` is a one-line wrapper.

**Item 6 — `GET /api/me/vehicle-unavailability`** (`vehicle-unavailability.service.ts` `bySe` +
`me-vehicle-unavailability.controller.ts`). Every status (not just the manager queue's `OPEN`
filter), so a resolved report's outcome stays visible. `secondarySlaSeconds` withheld by destructuring
it out of the shared row builder's output (`MeVehicleUnavailRow = Omit<VehicleUnavailRow,
'secondarySlaSeconds'>`) rather than a parallel row-shape — one `toRow`, two views. Refactored
`listForZone` to share `findReports`/`toRow` with the new `bySe`, no behavior change to the manager
read (existing tests green unmodified).

**Item 7 — `GET /api/me/availability`** (`se-availability.service.ts` `listWindows` +
`me-availability.controller.ts`). `AvailabilityRow` was defined inside `engineers-query.service.ts`
purely because that was the only reader — moved it to `se-availability.service.ts` (the actual data
owner) and had `engineers-query.service.ts` re-export it, reversing a dependency that pointed the
wrong way. `EngineerDetail.getDetail`'s inline availability query was replaced with a call to the
same `listWindows` the new SE route uses — one query, two callers, not two copies.

**Test-fixture note, same as #161/#187's finding**: every new test file seeds its own fresh
`EngineerMaster` rows rather than relying on `se.north@fsm.test` (the global auth fixture has a
`User` row for it but no `EngineerMaster`) — avoids the exact fixture gap #187 already root-caused.

Tests: `me-vouchers-controller.e2e-spec.ts` (3), `me-leave-requests-controller.e2e-spec.ts` (3),
`me-intraday-insertions-controller.e2e-spec.ts` (4), `me-component-requests-controller.e2e-spec.ts`
(3), `me-vehicle-unavailability-controller.e2e-spec.ts` (3), `me-availability-controller.e2e-spec.ts`
(4) — 20 new cases. Full backend suite: 329/333 files, 1393/1400 tests green, `tsc` clean across
backend + admin — only the pre-existing #187 voucher-controller failures.
