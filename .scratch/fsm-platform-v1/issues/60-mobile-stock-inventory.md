# 60 — M6: Stock / Inventory (mobile van stock)

Status: ready-for-agent
Type: AFK

## What to build

The SE Stock tab (Issue 21 `/api/me/van-stock`): van-stock list, Common-Kit completeness, and
component availability. Read surface of the already-built van-stock backend; integrates with the
component request loop (Issue 22) for receipt status.

## Acceptance criteria

- [ ] Van-stock list rendered from `/api/me/van-stock`
- [ ] Common-Kit completeness shown (kit-complete when no van-stock rows)
- [ ] Component receipt/request status surfaced (Issue 22 link)

## UI surfaces

- **Mobile:** Stock tab. Owned by this issue.
- **Admin:** n/a (admin Component-Blocked queue is Issue 21).

## Reference

- `docs/ui/mobile/inventory.png.png`

## Blocked by

- #54, #21
