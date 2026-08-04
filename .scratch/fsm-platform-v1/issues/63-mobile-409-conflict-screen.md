# 63 — SE mobile full-screen 409 (Ticket already closed) screen

Status: done except Shadow-Use end-to-end demonstration (blocked on #101)
Type: AFK · Mobile

## What to build

The SE mobile full-screen business-409 result (CONTEXT §Business 409 Conflict, Issue 24 AC#3). When a
troubleshoot submit returns HTTP 409 `TICKET_ALREADY_CLOSED`, the app shows a full-screen message:
"This Ticket was already closed by [SE] at [time]. Your consumed components have been logged as Shadow
Use and will be reconciled by the Warehouse." with **View Van Stock** / **Go Back** actions. Reads the
409 payload (`winnerSeId`, `winnerAt`, `shadowUseRecorded`) the backend already returns.

## Business rules (authority)

- PRD §591 Flow 8 + CONTEXT §Business 409 Conflict. Van stock is decremented on the server regardless
  of the rejected submission; the loser's consumption is logged as Shadow Use for reconciliation.

## Acceptance criteria

- [x] On a 409 `TICKET_ALREADY_CLOSED` submit response, the full-screen conflict screen renders
- [x] Copy shows the winning SE + time and whether Shadow Use was logged
- [x] View Van Stock navigates to the Stock screen; Go Back returns to the Day Plan
- [x] Idempotency duplicates (not 409) do not trigger this screen

## API contract (authority: backend on `main`)

- Triggered by `POST /api/tickets/:id/troubleshoot` returning HTTP 409 with body
  `{ code: 'TICKET_ALREADY_CLOSED', winnerSeId, winnerAt, shadowUseRecorded }`.
- No new endpoint; this screen is a client response to the existing 409 payload.

## Validation & error codes

- ONLY HTTP 409 `TICKET_ALREADY_CLOSED` triggers this screen. A `client_submission_id` idempotency
  duplicate returns the existing submission (200) and must NOT render this screen.

## Permissions

- SE-only (it is the loser SE's submit response).

## Navigation

- View Van Stock → Stock tab (Issue 60). Go Back → Day Plan (Issue 56).

## Offline behaviour

- N/A for trigger (a 409 is an online server response). If the submit was queued offline, the 409 is
  surfaced when the queued item is rejected on sync (Issue 17 marks it FAILED → opens this screen).

## Edge cases & failures

- `shadowUseRecorded=false` → copy omits the Shadow-Use reconciliation line.

## UI surfaces

- **Mobile:** full-screen 409 conflict result. Owned by this issue.
- **Admin:** n/a (the warehouse side is the Shadow Use Queue, Issue 24).

## Reference

- `docs/ui/mobile/ticket-detail-ready.png` (the submit context); 409 state copy per CONTEXT §Business 409 Conflict

## Tests (TDD targets — red first)

- 409 `TICKET_ALREADY_CLOSED` renders the screen with winner SE/time + Shadow-Use line when `shadowUseRecorded`.
- 200 idempotency duplicate does NOT render the screen.
- View Van Stock / Go Back navigate correctly.

## Blocked by

- #54
- #24
- #58 (the troubleshoot submit whose 409 response this screen renders/routes from)

## Comments

### 2026-07-28 — data-needs spec (#172 D-9 closed; no mockup)

Full spec: `docs/status/se-screen-data-needs-2026-07-28.md` §6. The only screen whose copy the PRD
gives verbatim (PRD:593), which makes its two gaps unusually concrete.

🔴 **The headline field is unbuildable.** PRD:593 is *"already closed by **[SE Name]** at [time]"*,
but the 409 carries `winnerSeId` — a bare UUID (`troubleshoot-submission.service.ts:269`, `:308`;
emitted `troubleshoot.controller.ts:105`) — and **no SE-callable endpoint resolves an SE UUID to a
name**: `/api/engineers/:seId` and `/api/engineers` are manager-only
(`engineers.controller.ts:191-192`, `:91-92`), `/api/me` returns only the caller. Either add
`winnerSeName` to the 409 body or the app renders a UUID at a field engineer. → **#161**/**#169**.

🔴 **AC#2 (Shadow Use) cannot be demonstrated end-to-end.** `TroubleshootBody`
(`troubleshoot.controller.ts:32-44`) has **no `consumedComponents` field** and the controller never
passes one (`:81-96`), so `SubmitTroubleshootInput.consumedComponents`
(`troubleshoot-submission.service.ts:37`) is always empty, `consumed.length > 0` (`:275`) is never
true, and **`shadowUseRecorded` is permanently `false`** — no `SHADOW_USE` row (`:284-291`), no
van-stock decrement (`:277`), ever, over HTTP. This independently confirms the freeze plan's
"armed but unreachable" finding from the opposite direction. Fix is structural and belongs with
**#101** before #82/#21 wire the consumption leg.

**Good news — pin what already works.** The 409 body's existing `status` field
(`troubleshoot.controller.ts:104`, from `handleConflict(status, …)` `:264`) **is** the auto-recovery
discriminator: with `CLOSED_AUTO_RECOVERY` there is no winning SE at all
(`troubleshoot-submission.service.ts:266-271` returns nothing), and rendering PRD:593's copy would
be a lie. This issue's payload list omits `status` — add it.

Also needed: `shadowUseComponents: [{componentId, name, qty}]` (PRD:593 says "components", plural),
and for an offline-replay 409, which queued submission was rejected — that needs the
`offline_submission_receipts` ledger (**D2**), which does not exist.

### 2026-08-04 — DONE except Shadow-Use end-to-end (blocked on #101)

The headline-field blocker is resolved: `handleConflict()` now resolves the winner's `User.name`
via `EngineerMaster.user` (one extra join) and returns `winnerSeName` alongside `winnerSeId` in the
409 body. `ConflictScreen` (mobile) renders PRD:593's exact copy, replacing `TroubleshootFormScreen`
entirely — not the inline banner #58 shipped as an interim. `status === 'CLOSED_AUTO_RECOVERY'`
renders without naming an SE (matches this comment's own note that there is no winner in that case).

**Still not built:** the Shadow-Use AC can't be demonstrated end-to-end over HTTP —
`TroubleshootSubmitRequest` still has no `consumedComponents` field, so `shadowUseRecorded` stays
permanently `false` from a real client submission (structural gap, still owned by #101, unchanged
from the original finding above). `ConflictScreen`'s Shadow-Use line is correct and will render
once #101 wires that field through; not exercised by a real HTTP payload today. `shadowUseComponents`
(plural, itemized) and the offline-replay 409 case (needs D2's `offline_submission_receipts` ledger)
remain unbuilt for the same reason — no consuming feature produces that data yet.
