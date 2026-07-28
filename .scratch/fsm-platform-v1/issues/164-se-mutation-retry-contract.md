# 164 — SE mutation retry contract (idempotency keys + 409 disambiguation)

Status: ready-for-agent
Type: AFK · Backend

Filed 2026-07-28 (`docs/status/backend-mobile-readiness-plan-2026-07-28.md` §A-§3, §B N16).
A phone on rural connectivity retries every write. Full 17-endpoint inventory (07-28): 2 carry a
client key (troubleshoot, vouchers), 1 is the reference implementation (intraday accept,
`intraday-insertion.service.ts:140-175`), soft-state/activity-ping are safely idempotent — the rest
are either duplicate-producing or opaque-409 on retry. **This is client-contract work, distinct
from #101** (#101 = server-side race guards; this = what a retrying client experiences).
Retrofit after the client ships means the client handles both shapes — settle before the mobile
write layer is written.

## What to build

1. **Client idempotency keys on the duplicate-producers**, `clientSubmissionId` + unique
   `(se_id, client_submission_id)` per the troubleshoot/vouchers pattern (`schema.prisma:870,931`);
   replay returns the original result:
   - `POST /vehicle-unavailability` — unconditional create (`vehicle-unavailability.service.ts:70-84`); each duplicate lands in the manager queue
   - `POST /leave-requests` — unconditional create (`leave-request.service.ts:65-74`)
   - `POST /engineers/:seId/availability` — unconditional create (`se-availability.service.ts:67-91`)
2. **Already-done-by-you replay on the state-machine 409s** (mirror intraday accept's replay guard):
   on WRONG_STATE / NOT_PENDING, if the caller was the actor of the completed transition, return
   200 with current state; else 409 with an **`alreadyDone: boolean` discriminator** in the body.
   Sites: recovery on-site/collected (`recovery.service.ts:106,122`; bare code at
   `recovery.controller.ts:145`), install on-site/fitted (`install-lifecycle.service.ts:111-128`),
   intraday decline (`intraday-insertion.service.ts:258`).
3. **`unable-to-collect` once-only guard** — today a retry re-stamps `unableToCollectAt` and
   re-fires ZM-queue routing (`recovery.service.ts:178-196`). Guard on `unableToCollectAt IS NULL`
   (transitionOrConflict shape) + idempotent replay for the same SE.
4. **Contract doc**: one table — every SE mutation × retry behaviour (idempotent / keyed / replay /
   409+alreadyDone) — for #54's queue seam and #17 to pin against.

Non-goals: the Shadow-Use CONFLICT-path key persistence and atomic `decrementStock` stay with
**#101** (already its ACs); the batch transport stays with **#82**.

## Acceptance criteria

- [ ] VU / leave / availability: same-key retry returns the original result, no second row (DB unique enforced, concurrent-pair safe — catch P2002, no 500s)
- [ ] Recovery/install/decline: retry after own success returns 200 + current state; genuine conflict returns 409 with `alreadyDone` discriminator
- [ ] `unable-to-collect` cannot double-stamp or double-route
- [ ] e2e per endpoint: the retry-after-success and the concurrent-duplicate cases
- [ ] The retry-contract table is written and linked from #54/#17/#82

## UI surfaces

n/a.

## Reference

n/a.

## Blocked by

- None. Coordinate site list with #101 (no double-fixing); the `alreadyDone` body shape should be
  reviewed against #99's error envelope conventions.

## Comments

### 2026-07-28 — reconciled (freeze plan §1.2, F3.2)

Substance unchanged; three refinements from the contract inventory:

- **The `alreadyDone` discriminator must land with #169's error-shape work**, not separately —
  install/recovery 409s currently carry `{code}` with **no `status` field** at all
  (`install.controller.ts:75`, `recovery.controller.ts:145`), so the client cannot tell which state
  blocked it. Adding a discriminator to a body that is itself being normalised is one change.
- **`recovery/:id/unable-to-collect` re-confirmed as the sharpest case**: it is state-*preserving*
  (stays `ON_SITE`, `recovery.service.ts:178-201`), so a retry **succeeds again with 200**,
  re-stamping `unableToCollectAt` and re-firing `notifier.unableToCollect`. It is the only SE write
  that silently double-fires — everything else at worst 409s.
- `POST /vouchers` has a **check-then-create race** (`vouchers.service.ts:157` vs `:178`): a
  concurrent duplicate pair hits the DB unique as an unhandled P2002 → 500 rather than the DUPLICATE
  contract. Owned by #101; noted here because it is the same client-visible symptom.

Inventory of the five strategies currently in use (troubleshoot/vouchers keys · intraday atomic CAS ·
soft-state/notification idempotent returns · natural overwrite · state-guard-409 · nothing) is in the
freeze plan §4.4 — the goal is that a client needs to know **one** rule, not five.
