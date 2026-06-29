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

- [ ] Van-stock list rendered from `/api/me/van-stock`
- [ ] Common-Kit completeness shown (kit-complete when no van-stock rows)
- [ ] Component receipt/request status surfaced (Issue 22 link)
- [ ] SE Confirm Receipt action posts to `/api/component-requests/:id/confirm-receipt` (PRD Flow 3 step 4)

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

- `docs/ui/mobile/inventory.png.png`

## Tests (TDD targets — red first)

- Van-stock rows render; empty stock → Kit Complete; missing items → Kit Incomplete list.
- Confirm Receipt posts to the correct request id and reopens the resubmit form.

## Blocked by

- #54, #21
- (Confirm-Receipt leg) #22
