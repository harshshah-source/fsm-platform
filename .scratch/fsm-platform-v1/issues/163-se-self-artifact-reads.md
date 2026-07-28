# 163 — SE self-artifact reads (my vouchers, my leave, my pending intraday offer)

Status: ready-for-agent
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
