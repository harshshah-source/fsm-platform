# 86 — M8b: SE Leave Request (mobile)

Status: done
Type: AFK · Mobile

## What to build

The SE Leave Request screen (PRD Flow 10) over the built Issue 26 backend: submit a leave request
(type + date window), see the PENDING badge, and view approve/reject outcome. ZM approval happens on
the admin side (Issue 26).

## Business rules (authority)

- PRD §604 Flow 10 (type ON_LEAVE / WEEKLY_OFF, start/end, submit for ZM approval; approve →
  SE_AVAILABILITY updated + Recommender excludes the window; reject → reason + revise/resubmit).

## Acceptance criteria

- [x] Leave form (type + window) submits to `/api/leave-requests`
- [x] PENDING state shown after submit
- [x] Approve/reject outcome surfaced (reject shows reason; SE can resubmit)

## API contract (authority: backend on `main`)

- `POST /api/leave-requests` — `@Roles('SERVICE_ENGINEER', 'ZONAL_MANAGER', 'CENTRAL_SERVICE_MANAGER')`.
  Body `{ seId (=self), type, windowStart, windowEnd, reason? }`; `type` ∈ `LEAVE_TYPES`
  (ON_LEAVE / WEEKLY_OFF) (`engineers/leave-request.controller.ts`).
  *(Note: backend fields are `windowStart`/`windowEnd`, mapped from the PRD's start/end dates.)*
- `GET /api/leave-requests` → the SE's own requests with status.

## Validation & error codes

- `SE_REQUIRED`, `INVALID_LEAVE_TYPE`, `INVALID_WINDOW` (unparseable dates), `WINDOW_ORDER`
  (`windowEnd < windowStart`) — all 400; surface inline.

## Permissions

- SE submits for self (passes own `seId`). Approve/reject are manager-only (Issue 26).

## Navigation

- Submit success → list with the new PENDING row. Reject → revise/resubmit from the same form.

## Offline behaviour

- Submit queues via #17 when offline; status reads render from cache.

## Edge cases & failures

- `windowEnd < windowStart` → `WINDOW_ORDER`. Bad type → `INVALID_LEAVE_TYPE`.

## UI surfaces

- **Mobile:** Leave Request form + list. Owned by this issue.
- **Admin:** n/a (ZM approval queue is Issue 26).

## Reference

- PRD §604 (no dedicated mobile screenshot — composed from the kit).

## Tests (TDD targets — red first)

- Valid submit → PENDING; `windowEnd<windowStart` → `WINDOW_ORDER`; bad type → `INVALID_LEAVE_TYPE`.
- Reject outcome shows reason and allows resubmit.

## Blocked by

- #54, #26

## Comments

### 2026-07-28 — data-needs spec (#172 D-9 closed; no mockup)

Full spec: `docs/status/se-screen-data-needs-2026-07-28.md` §4.

⚠ **This issue's API-contract line is wrong and two ACs are unbuildable.** It states
`GET /api/leave-requests` returns "the SE's own requests with status" — that route is
`@Roles(...MANAGER_ROLES)` (`leave-request.controller.ts:66-67`) and returns `listForZone` (`:69`).
**An SE cannot read their own leave requests**, so the PENDING-badge AC and the rejection-reason AC
cannot be built as written.

Good news: `LeaveRequestRow` (`leave-request.service.ts:27-38`) already carries `type`, `status`,
`windowStart`, `windowEnd`, `reason`, `decisionReason`, `createdAt`. **This is purely a role gate
plus a self-scope filter** — owned by **#163**.

- `decidedAt` / `decidedBy` / `decidedByRole` exist (`schema.prisma:1194-1196`) but are absent even
  from the manager row — add them.
- The submit response is only `{result, id}` (`service:21-22`); it should **echo `status`** so the
  PENDING badge renders without a second call.
- **No notification is emitted on approve or reject**, though workflow:1474 requires one — only
  cross-zone and intraday inject `NotificationService`. → **#76**.
- Trust note: `seId` comes from the request **body**, not the token (`controller:49-50`); the service
  does check `canActFor` (`service:63`). Pin that the client always sends self.
- Nothing in doc or code covers **cancel/withdraw**, or overlapping requests (no uniqueness
  constraint on `LeaveRequest`, `schema.prisma:1185-1206`).

### 2026-08-04 — done: #163 already closed the premise blocker (same pattern as #77/#85)

Re-verified this comment against current source before building — same "SE cannot read their own
X" shape as #77 (intraday) and #85 (notifications), and once again already resolved:

1. **Premise blocker resolved by #163 item 2** (done 2026-08-03) — `GET /api/me/leave-requests`
   (`me-leave-requests.controller.ts`, `SERVICE_ENGINEER`-gated, `listForSe`) returns every status
   (not just PENDING) with `decisionReason` already on the row. Consumed as-is, no backend change.
2. **`decidedAt`/`decidedBy`/`decidedByRole` still absent from `LeaveRequestRow`** — confirmed still
   true, and still not built here: no AC asks for a decision timestamp/actor, only the reason (which
   #163 already exposes). Not a blocker for this issue.
3. **Submit response still only `{result, id}`** — also not fixed, and not needed: the mobile screen
   re-fetches the list after a successful submit (`LeaveRequestScreen`'s `onSubmitted` → `load()`),
   the same pattern every other create-then-list screen in this codebase uses (Vouchers, Recovery,
   Install). The PENDING badge renders from that re-fetch, no second endpoint required.
4. **Error codes confirmed accurate as written** — `SE_REQUIRED`/`INVALID_LEAVE_TYPE`/
   `INVALID_WINDOW`/`WINDOW_ORDER`, all 400, matched `leave-request.controller.ts` exactly; no
   correction needed (unlike #68/#71's stale codes).
5. **Cancel/withdraw and overlapping-window validation** — still not built, still out of scope: no
   AC references either, and the backend has no cancel endpoint or uniqueness constraint to drive it.
6. **Notification-on-decision (#76)** — unrelated to this mobile screen; the SE sees the outcome by
   re-opening the list, no push dependency on the core ACs.

**Entry point:** no PRD mockup specifies where Leave Request lives. `ProfileScreen` was the #54
empty stub with no owning issue — gave it its first real content (a "Leave Requests" link, local-swap
navigation, same pattern as every other screen transition in this codebase). Availability (#87) is a
natural sibling entry there later.

**Date input:** plain `YYYY-MM-DD` text fields, not a native date picker — no such library exists in
this project's dependencies and no mockup specifies that input's UX, same call #64's Vehicle
Unavailability form made for its own date field. Server is authoritative on parse (`INVALID_WINDOW`)
and ordering (`WINDOW_ORDER`); the client only pre-checks non-empty.
