# cross-zone primer — written by the S3 walker, 2026-09-02

Module: `apps/backend/src/cross-zone/` + `apps/admin/src/pages/cross-zone/CrossZonePage.tsx`
(route `/cross-zone`, `AppRoutes.tsx:347`). Admin API base `http://localhost:3000/api`.

Log in with `api-walk` (see `_shared-primer.md`). Roles that matter here:
`ZM`=zm.north (zone 1) · `ZM_SOUTH`=zm.south (zone 2) · `CSM` · `OH`.

## Endpoint map and real role gates (all walked 2026-09-02, E4)
| endpoint | who gets 200 | who gets 403 |
|---|---|---|
| `GET /cross-zone` | ZM (own zone only), CSM, OH | WM, SE |
| `POST /cross-zone/sweep` | CSM, OH | ZM, WM, SE |
| `POST /cross-zone/flag` | ZM (own zone; 403 `TICKET_OUT_OF_ZONE` elsewhere), CSM (any zone) | OH, SE |
| `POST /cross-zone/:id/approve\|deny\|defer` | CSM, OH | ZM, WM, SE |
| `POST /cross-zone/:id/re-escalate` | ZM only | CSM, OH, SE |

## Fixture state left behind by this walk — read before you create more
- Escalations **1–9** exist. `1` APPROVED, `3` DENIED, **`2` and `4`–`9` are PENDING orphans**:
  4–9 have `FORMALLY_ASSIGNED` tickets and will 409 `TICKET_ALREADY_ASSIGNED` on any approve
  (this is CZ-01, reproduced). Esc 2's ticket 404s on approve (CZ-13).
- Ticket `30732620-4b1b-4900-9754-b971fa68ea3a` is the one successful cross-zone hand-off:
  home zone 1, assigned to zone-2 SE Ramesh Rao (`0bbe6100-…`), schedule 1238, batch 1758.
- Useful SE ids: zone 1 `fffebec6-…` Amit Sharma (**triggers the approve 500**),
  `8f7bfda8-…` Vikram Singh; zone 2 `0bbe6100-…` Ramesh Rao (**approve works**), `3e30b656-…`.

## The two data facts that decide what is walkable
- **Every ticket in this DB is SILVER.** 6500 scanned, zero PLATINUM, zero GOLD. The Platinum
  auto-escalation sweep — the module's headline capability — cannot be exercised. Do not read
  `{escalated:0}` as a pass.
- **No SE persona can receive an assignment.** `se.north` has no `engineerMaster` row and no zone-2
  SE has a login, so the SE end of every cross-zone hand-off is UNTESTABLE by API.
