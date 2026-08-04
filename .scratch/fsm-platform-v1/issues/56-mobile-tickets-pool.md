# 56 — M2: Tickets / Day-Plan / Shared Pool (mobile)

Status: ready-for-agent
Type: AFK · Mobile

## What to build

The SE Tickets tab: the assigned Day-Plan ticket list (Issue 11 `/api/schedules/me`) and a separate
Shared Pool list (Issue 12 `/api/me/shared-pool`), with priority/SLA visual treatment matching the
mockup. List rows open Ticket Detail (M3).

## Business rules (authority)

- PRD §503 Flow 1 + §497 (Shared Pool — always-visible secondary list for the SE's covered plants,
  shown alongside Assigned Work; never shows tickets outside coverage; no pick/reject action on the pool).

## Acceptance criteria

- [x] ~~Assigned Day-Plan list rendered from `/api/schedules/me`, ordered/badged per mockup~~ —
      superseded by the 2026-07-28 ratification below: one merged list from `GET /api/me/tickets`.
- [x] ~~Shared Pool list rendered from `/api/me/shared-pool`, visually separate from Assigned~~ —
      superseded; no assigned/pool visual split, grouped by urgency instead (Visit Now / Other).
- [ ] Row tap opens Ticket Detail (M3) — **blocked, not built.** #57 (Ticket Detail) does not exist
      as a screen yet; `TicketCard`'s `onPress` is left unset rather than wired to nothing.

## API contract (authority: backend on `main`)

- `GET /api/schedules/me` → `DayPlanView` (see Issue 55 — stops carry `{ ticketId, sortOrder }` per plant).
- `GET /api/me/shared-pool` → `SharedPoolTicket[]` (`shared-pool.controller.ts`). Read-only list.

## Permissions

- Both SE-only, server-scoped to the caller. The pool is read-only — no Reject/claim action.

## Navigation

- Row tap → Ticket Detail (Issue 57 / M3), passing `ticketId`.

## Offline behaviour

- Lists render from cached `/schedules/me` + `/shared-pool` when offline, with an offline indicator.

## Edge cases & failures

- Empty assigned list (pre-dispatch) → empty state distinct from empty pool.
- A ticket present in both assigned and pool is shown only under Assigned (Assigned takes precedence).

## UI surfaces

- **Mobile:** Tickets tab (list + pool). Owned by this issue.
- **Admin:** n/a.

## Reference

- `docs/ui/mobile/tickets-priority-view.png`

## Tests (TDD targets — red first)

- Assigned list renders ticket rows in `sortOrder`, badged; pool list renders separately.
- Row tap navigates to M3 with the correct `ticketId`.
- Empty assigned vs empty pool render distinct states.

## Blocked by

- #54, #07, #11, #12

## Comments

### 2026-08-04 — built except row-tap navigation (blocked on #57) and Plant-wise grouping (deferred)

`TicketsScreen` renders the merged `GET /api/me/tickets` list (`vehicleNo` added to the row — see
`packages/shared` — the mockup's registration-number display had no source before this), grouped
Visit Now / Other Tickets by `workState`, each with its own empty state; filter chips (All/Visit
Now/Plan/In Work/Verify) narrow the list; offline shows a banner and falls back to in-memory state
(durable cross-restart persistence is Issue 17, same scope line as #54's `WriteQueue`). 8 new tests,
83 mobile tests green overall, `tsc`/`eslint` clean.

**Not built:** row tap → Ticket Detail — #57 doesn't exist as a screen, so `onPress` is left unset.
**Deferred, not blocking:** the Plant-wise/Priority toggle — Priority (this issue's Visit Now/Other
split) ships as the only grouping mode; Plant-wise is presentation-only polish over already-real
data, not a data or contract gap, and left for a follow-up pass.

### 2026-07-28 — #172 decision 3: one merged list

Ratified: the Tickets screen is a **single list grouped by urgency** (`Visit Now` / `Other Tickets`)
with a Plant-wise/Priority toggle and `All / Visit Now / Plan / In Work / Verify` chips — **no
Assigned/Pool visual separation**, overriding PRD §497. Coverage scoping is unchanged.

Contract: one endpoint, `GET /api/me/tickets`, returning `assigned: boolean` and
`workState: 'VISIT_NOW'|'PLAN'|'IN_WORK'|'VERIFY'` per row (the image's V/P/W/✓ glyph). Owned by
**#161**/**#165**. Row fields incl. transporter name and the `Call`/`WhatsApp` buttons depend on
**#171** (no phone column exists yet).
