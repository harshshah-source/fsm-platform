# 60 — M6: Stock / Inventory (mobile van stock)

Status: ready-for-agent
Type: AFK · Mobile

## What to build

The SE Stock tab (Issue 21 `/api/me/van-stock`): van-stock list, Common-Kit completeness, and
component availability. Read surface of the already-built van-stock backend; integrates with the
component request loop (Issue 22) for receipt status. Also hosts the SE **Confirm Receipt** action for
a shipped Component Request (PRD §533 Flow 3 step 4) — previously unowned.

## Business rules (authority)

- PRD §617 Flow 12 (Van Stock — kit completeness, read-only restock via ZM/Warehouse) + §533 Flow 3
  step 4 (Confirm Receipt → Component Request RECEIVED, SLA resumes).

## Acceptance criteria

- [x] Van-stock list rendered from `/api/me/van-stock`
- [x] Common-Kit completeness shown — rendered from the server's own `commonKit.complete` boolean directly (its real rule is "every active kit item carried at ≥ min_qty, or no kit definition, or no stock records at all" — richer than this bullet's shorthand; not reimplemented client-side)
- [x] Component receipt/request status surfaced (Issue 22 link) — via #163's `GET /api/me/component-requests`
- [x] SE Confirm Receipt action posts to `/api/component-requests/:id/confirm-receipt` (PRD Flow 3 step 4)

## API contract (authority: backend on `main`)

- `GET /api/me/van-stock` → `{ stock: VanStockItem[], commonKit: CommonKitStatus }` (`inventory.controller.ts`,
  `@Controller('me')`). Kit-complete when there are no van-stock rows (Issue 21 rule).
- `GET /api/component-requests/by-ticket/:ticketId` → request status (Issue 22/62).
- `POST /api/component-requests/:id/confirm-receipt` (SE) → marks RECEIVED; SLA clock resumes server-side.

## Permissions

- Van-stock + shared-pool reads are SE-only, server-scoped. Confirm-receipt is the requesting SE's action.

## Navigation

- Confirm Receipt success → reopen the Troubleshoot resubmit form (Issue 58) for the same ticket.

## Offline behaviour

- Stock list renders from cache when offline (read-only). Confirm-receipt write queues via Issue 17.

## Edge cases & failures

- No van-stock rows → "Kit Complete" (green); missing kit items → "Kit Incomplete: [items]" (red).
- Confirm Receipt on a non-shipped request → server rejects; surface the error inline.

## UI surfaces

- **Mobile:** Stock tab + Confirm Receipt action. Owned by this issue.
- **Admin:** n/a (admin Component-Blocked queue is Issue 21).

## Reference

- `docs/ui/mobile/inventory.png`

## Tests (TDD targets — red first)

- Van-stock rows render; empty stock → Kit Complete; missing items → Kit Incomplete list.
- Confirm Receipt posts to the correct request id and reopens the resubmit form.

## Blocked by

- #54, #21
- (Confirm-Receipt leg) #22

## Comments

### 2026-07-28 — #172 decision 2: the full Inventory surface, not read-only

Ratified: `docs/ui/mobile/inventory.png` overrides PRD Flow 12's *"Read-only — restocking arranged
through ZM or Warehouse."* The screen keeps its per-row `Request` buttons, `Scan Serial`, the
`Requests` list (`2 Active`, with Approved/Pending statuses), and the **Zone Warehouse** row shown
among SE Stock rows. Backend owned by **#173**; the requests read side by **#163**.

**`Use Part` stays deferred behind #101** — a consumption path arms the non-atomic van-stock
decrement and the CONFLICT-path key-persistence defects.

Useful detail from the image: the three tiles (`13 AVAILABLE / 3 LOW STOCK / 2 HEALTHY`) are Σ`qty`
and the row count split by status — so **one per-row status field renders all three**. The
Kit Complete/Incomplete badge lives here now, not on Home.

### 2026-08-04 — read-only core built; the fuller ratified surface needs #173

`VanStockItem`/`CommonKitStatus`/`ComponentRequestRow`/confirm-receipt DTOs moved to `@fsm/shared`
first (same precedent as #56-#58). `VanStockItem` carries no status column at all — LOW vs OK is
derived by cross-referencing `CommonKitStatus.missing` (the server's own "below required minimum"
signal), verified against this issue's own useful-detail note by reproducing the reference image's
exact tile numbers (13/3/2) from a fixture shaped like it. A missing component absent from stock
entirely renders as a real qty:0 LOW row, not fabricated. Confirm Receipt shown only on `SHIPPED`
requests, refetches on success. 146 mobile tests green, `tsc`/`eslint` clean.

**Not built — needs #173 (confirmed `ready-for-agent`, not started):** the per-row "Request" button
and the Zone Warehouse row from the 07-28 ratification's fuller surface ("the full Inventory
surface, not read-only") — both need SE-facing write/read endpoints that don't exist yet
(`GET /component-requests/by-ticket/:ticketId` is manager-only; no SE-accessible zone-warehouse
read exists). Scan Serial / Use Part stay deferred behind #101 per the ratification's own text.
