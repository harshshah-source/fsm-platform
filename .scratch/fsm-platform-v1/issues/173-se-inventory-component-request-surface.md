# 173 — SE inventory & component-request surface

Status: ready-for-agent
Type: AFK · Backend

Filed 2026-07-28 (`docs/status/mobile-backend-freeze-plan-2026-07-28.md` F2.9).
The Inventory screen (`docs/ui/mobile/inventory.png`) renders **4 of 18** fields today, and its
entire lower half — the active-requests list — is unreadable by an SE.

## What is missing

**Van-stock payload.** `GET /api/me/van-stock` returns `{componentId, name, qty}` per row plus
`commonKit` (`inventory/inventory.service.ts:50-57`). The screen additionally needs:
- `minQty`/`reorderLevel` — drives the `OK`/`LOW` pill and the `3 LOW STOCK` / `2 HEALTHY` tiles.
  **No column exists**: `SeVanStock` is `{id, seId, componentId, qty}` (`schema.prisma:1048-1059`).
  `CommonKitDefinition.minQty` covers kit items only and is OH-gated (`org/common-kit.controller.ts:16`).
- `targetQty` — the row progress bar has no denominator anywhere.
- `location` — the screen shows a **`Zone Warehouse`** row beside `SE Stock` rows, i.e. it merges
  van stock with warehouse stock. `GET /api/inventory/warehouse-stock` is
  `@Roles(...READ_ROLES)` = WM/ZM/CSM/OH (`inventory/warehouse-stock.controller.ts:37`) — not SE.
- `serialTracked` (`ComponentMaster.serialTracked`, `schema.prisma:1012`) — drives `Scan Serial`.
- `category`.
- Disambiguate `commonKit.complete: true`, which today means **three different things**: the kit is
  complete, no kit definition is active (`inventory.service.ts:66`), or the SE has zero stock rows
  (`:70`).

**Component requests — the SE can act but cannot see.** There is **no SE-callable component-request
create route**: requests exist only as a side effect of `componentUnavailable: true` on a troubleshoot
submit. The screen has three per-row `Request` buttons and a `2 Active` list. Reads are manager-only
(`component-request.controller.ts:27,:37`), yet the SE is the one who must
`confirm-receipt` (`:43`) — they confirm something they can never read. (The read half is **#163**;
the missing create path and ownership check are here and in **#162**.)

**`Use Part`** — consumption happens implicitly inside a troubleshoot submit; there is no standalone
route. Note the interaction: wiring a consumption path arms the #101 van-stock decrement defects
(non-atomic read-then-write, and the CONFLICT path never persisting `clientSubmissionId`).
**#101 must land first.**

## What to build

1. Enrich `GET /api/me/van-stock` with the fields above (schema change for min/target quantities).
2. An SE-visible zone-warehouse view — merged into van stock or a sibling read; the screen shows
   both in one list.
3. `POST /api/component-requests` — SE-initiated, idempotency key per **#164**'s contract.
4. Optionally a standalone consumption route (`Use Part`) — **only after #101**.

Scope note: the PRD (§617) scopes Inventory as read-only van stock while the reference image shows
all of the above. That conflict is **#172** item 2 and should be resolved before this is built.

## Acceptance criteria

- [ ] Van-stock rows carry status/threshold/location/serial-tracked fields sufficient to render the screen without client-side invention
- [ ] `commonKit.complete` is unambiguous (the three cases are distinguishable)
- [ ] An SE can create a component request directly, idempotently
- [ ] An SE can read their own requests (with #163) and confirm receipt only on their own (with #162)
- [ ] Zone-warehouse stock is visible to the SE at the granularity the screen shows
- [ ] Any consumption path lands after #101's atomic decrement

## UI surfaces

n/a (backend; consumed by Mobile #60, which owns the screen).

## Reference

- `docs/ui/mobile/inventory.png`

## Blocked by

- **#172** (Inventory scope conflict) for the field list; **#101** before any consumption path.

## Comments

### 2026-07-28 — #172 decision 2: this issue stands as filed

The PRD-vs-image conflict is resolved **in the image's favour**, so nothing here shrinks: SE-initiated
component-request create, van-stock enrichment, zone-warehouse visibility and the requests list are
all in scope. `Use Part` remains deferred behind **#101**.

The tiles (`13 AVAILABLE / 3 LOW STOCK / 2 HEALTHY`) are Σ`qty` and the row count split by status —
so the per-row `status`/threshold field is the highest-leverage single item here: it renders all
three tiles and both row pills.
