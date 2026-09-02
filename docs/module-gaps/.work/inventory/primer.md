# inventory primer — first walker, 2026-09-02. Read before any further inventory walk.

Login: `api-walk <ZM|ZM_SOUTH|CSM|OH|WM|SE> <METHOD> <path-no-leading-slash>`, password
`correct-password` for all six. No `psql` and no `docker` on PATH in this shell — the API is the
only instrument; do not plan a DB fixture you cannot apply.

Where the module lives: `apps/backend/src/inventory/` (van stock, component-blocked, shadow use,
zone warehouse stock) + `apps/backend/src/component-request/` (the request lifecycle). Consumption
is written from `apps/backend/src/ticketing/troubleshoot-submission.service.ts`, and the rollback
from `apps/backend/src/verification/verification.service.ts:400-415`.

## Routes and the role that actually gets in (all measured, E4)

| route | 200 | 403 |
|---|---|---|
| `GET me/van-stock` | SE | ZM |
| `GET warehouse/shadow-use`, `POST .../:id/dispute` | WM | ZM |
| `GET warehouse/requests`, `POST .../:id/approve` | WM | ZM, SE |
| `GET inventory/warehouse-stock` (+ `/fulfillment-sla`) | WM, ZM | SE |
| `PATCH inventory/warehouse-stock` | WM, OH | ZM, CSM, SE |
| `GET component-requests` | ZM/CSM/OH | — |
| `GET me/component-requests` | SE | — |
| `GET component-blocked` | ZM/CSM/OH | — |
| `GET recovery/awaiting-receipt` | WM | — |

## Which seeded records sit in which state: NONE

Every inventory surface is empty — van stock `[]`, shadow use `0`, warehouse stock `0`, component
requests `0` in all three lenses, component-blocked `0`, awaiting-receipt `0`, fulfilment SLA
`{totalReceived:0, openRequests:0}`. `se.north` also has `0` tickets. **This module cannot be
walked for persistence at all today.** Never read an empty list as a pass (P19).

The reason the ledgers are empty is itself the headline finding (**INV-G8**): no HTTP request field
carries `consumedComponents`, so nothing can ever write `inventoryTransaction` or decrement
`seVanStock` through the app. Fix that first and the rest of the module becomes walkable.
