# 87 — M8c: SE Availability — SOFT_UNAVAILABLE flag (mobile)

Status: ready-for-agent
Type: AFK · Mobile

## What to build

The SE self-service Availability screen (PRD Flow 11): set a SOFT_UNAVAILABLE flag with a from/to time
window over the built Issue 25 backend. During the window the SE is excluded from intra-day candidate
scoring; at `to_ts` availability auto-reverts to AVAILABLE (server-side).

## Business rules (authority)

- PRD §611 Flow 11 (SOFT_UNAVAILABLE with from/to; excluded from Intra-day Re-plan candidate scoring
  during the window; ZM notified; auto-revert at `to_ts`). ADR-0010 (time-windowed availability).

## Acceptance criteria

- [ ] SE sets SOFT_UNAVAILABLE with a from/to window → `POST /api/engineers/:seId/availability`
- [ ] Current availability state + active window shown
- [ ] Auto-revert at `to_ts` is server-owned (the screen just reflects it; no client timer)

## API contract (authority: backend on `main`)

- `POST /api/engineers/:seId/availability` —
  `@Roles('ZONAL_MANAGER', 'CENTRAL_SERVICE_MANAGER', 'SERVICE_ENGINEER')` → **SE self-serve is allowed**
  (`:seId` = self). Body `{ status, windowStart?, windowEnd? }`; `status` ∈ `SETTABLE_STATUSES`
  (includes SOFT_UNAVAILABLE) (`engineers/engineers.controller.ts`).
- `GET /api/engineers/:seId` (own) → current availability for display.

## Validation & error codes

- `INVALID_AVAILABILITY_STATUS` (400), `SE_NOT_FOUND` (404).

## Permissions

- SE may set their **own** availability only (`:seId` must resolve to the caller server-side).

## Navigation

- Set success → Availability screen reflecting the active window.

## Offline behaviour

- Set queues via #17 when offline; the active state reads from cache until sync.

## Edge cases & failures

- Invalid status → `INVALID_AVAILABILITY_STATUS`. The SE never sets another SE's availability.

## UI surfaces

- **Mobile:** Availability screen (SOFT_UNAVAILABLE flag). Owned by this issue.
- **Admin:** n/a (manager availability controls are Issue 25).

## Reference

- PRD §611 (no dedicated mobile screenshot — composed from the kit).

## Tests (TDD targets — red first)

- SE sets SOFT_UNAVAILABLE with a window → 200; invalid status → `INVALID_AVAILABILITY_STATUS`.
- The screen reflects auto-revert at `to_ts` (server-driven; no client timer asserted).

## Blocked by

- #54, #25

## Comments

### 2026-07-28 — data-needs spec (#172 D-9 closed; no mockup)

Full spec: `docs/status/se-screen-data-needs-2026-07-28.md` §5.

⚠ **This issue's API-contract line is wrong and two ACs are unbuildable.** It states
`GET /api/engineers/:seId` (own) serves "current availability for display" — that route is
`@Roles(...MANAGER_ROLES)` (`engineers.controller.ts:191-192`). **An SE cannot read their own
availability**, so "current availability state + active window shown" cannot be built. The computed
value exists (`SeAvailabilityService.currentStatus`, `se-availability.service.ts:33-39`, surfaced as
`EngineerDetail.availabilityStatus`, `engineers-query.service.ts:70`) — it is manager-gated. Cheapest
home is `GET /api/me` (**#161**), which today returns four primitives (`me.controller.ts:18-23`).

🔴 **Business-rule violation, live in code — see #162.** `SETTABLE_STATUSES` includes `ON_LEAVE`,
`OFF_SHIFT`, `WEEKLY_OFF` (`engineers.controller.ts:68`) and the service authorises an SE for any of
them on themselves (`se-availability.service.ts:62`). Workflow:1338 is explicit — *"SE **cannot
self-approve**. Only ZM (or acting role) can write `ON_LEAVE` or `WEEKLY_OFF`"* — and PRD:496 gives
the SE only SOFT_UNAVAILABLE. **This screen must offer SOFT_UNAVAILABLE only**, and the server must
enforce it, or the app bypasses the whole Leave Request flow (#86).

**Error codes:** this issue lists only `INVALID_AVAILABILITY_STATUS` / `SE_NOT_FOUND`; the controller
also emits `INVALID_WINDOW_START` (`:214`), `INVALID_WINDOW_END` (`:218`) and `AVAILABILITY_FORBIDDEN`
(`:226`). It also marks `windowStart` optional — the controller makes it **mandatory** (`:212-215`).

**Two open behaviours nothing specifies — decide before the freeze:**
1. An **open-ended window** (`windowEnd: null`) is legal (`schema.prisma:1169`, matched at
   `se-availability.service.ts:35`), so an SE can go SOFT_UNAVAILABLE permanently. PRD:615 assumes a
   `to_ts` and does not contemplate this.
2. **There is no way to clear a window early.** The model is append-only and the only mechanism —
   setting an `AVAILABLE` window on top — is forbidden by `SETTABLE_STATUSES`.

Also: `activity_sourced` (workflow:1658) does not exist (**D7**), so a derived `OFFLINE`
(workflow:1348-1351) cannot be distinguished from a *set* availability. And **no ZM notification is
emitted** despite PRD:614.

### 2026-07-28 — both open behaviours SETTLED (operator)

**1. Clearing early — add `AVAILABLE` to `SETTABLE_STATUSES`** (`engineers.controller.ts:68`).
Uses the latest-window-wins semantics that already exist (`se-availability.service.ts:33-39`
orders by `windowStart DESC`), so no new route joins the frozen contract and no migration is
needed. **Purely service-layer.**

> ⛔ **Must land together with #162's narrowing.** Shipping the unlock alone would let an SE write
> an `AVAILABLE` window on top of a **ZM-set `ON_LEAVE`** and clear it. The SE must be restricted to
> `SOFT_UNAVAILABLE`, and to clearing only their *own* `SOFT_UNAVAILABLE` windows. See #162.

Note the current severity this fixes: `SETTABLE_STATUSES` is checked for **every role**
(`engineers.controller.ts:210`), so `AVAILABLE` is unsettable by anyone — an open-ended
`SOFT_UNAVAILABLE` is today **unrecoverable through the API entirely** and needs a DB edit. A ZM
setting another status only masks it until that window expires.

**2. Open-ended windows — `windowEnd` mandatory in the SE DTO only.** Managers keep `null` for
indefinite leave, so the column stays nullable and **no migration is required**. Implied spec basis:
**PRD:615** — *"At `to_ts`, availability automatically reverts to AVAILABLE"* — presumes a `to_ts`
exists. The spec never says outright that an SE-set window must be bounded; this is the closest
thing to an answer and it is what the auto-revert behaviour is written against.

Both are service-layer. ACs to add: an SE cannot set a status other than `SOFT_UNAVAILABLE`; an SE
can clear their own active `SOFT_UNAVAILABLE`; an SE cannot clear a manager-set window; an SE-set
window without `windowEnd` is rejected; a manager-set window without `windowEnd` is accepted.
