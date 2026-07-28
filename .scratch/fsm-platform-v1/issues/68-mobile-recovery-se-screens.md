# 68 — SE mobile Recovery screens (on-site / Collection Form / Unable to Collect)

Status: ready-for-agent
Type: AFK · Mobile
Origin: Issue 36 parity follow-up (2026-06-25).

## What to build

The SE-facing mobile surfaces for the Recovery Ticket field workflow (Issue 36). The backend lifecycle
+ endpoints are built and green (`/api/recovery/:id/{on-site,collected,unable-to-collect}`); these are
the mobile screens that drive them. RECOVERY appears in the Day Plan as a first-class work type.

- **Recovery in the Day Plan / Ticket Detail** — RECOVERY work-type card with the lifecycle status.
- **Mark On-Site** action (SCHEDULED → ON_SITE).
- **Collection Form** — mandatory device-serial confirmation + mandatory condition notes → COLLECTED.
- **Unable to Collect** — reason picker (COMPANY_REFUSED / VEHICLE_UNREACHABLE / DEVICE_MISSING /
  OTHER) → routes to the ZM decision queue.

## Business rules (authority)

- PRD §567 Flow 7 (lifecycle SCHEDULED → ON_SITE → COLLECTED → RECEIVED_AT_WAREHOUSE → CLOSED; serial
  validated against the ticket record; condition notes mandatory; unable-to-collect routes to ZM).

## Acceptance criteria

- [ ] RECOVERY tickets render in the SE Day Plan / Ticket Detail with lifecycle status
- [ ] Mark On-Site, Collection Form (serial + condition), and Unable to Collect drive the #36 endpoints
- [ ] Collection Form requires a non-empty serial + condition notes; the **server** is authoritative on serial match

## API contract (authority: backend on `main`, all `@Roles('SERVICE_ENGINEER')`)

- `POST /api/recovery/:id/on-site` — no body (SCHEDULED → ON_SITE).
- `POST /api/recovery/:id/collected` — body `{ deviceSerial, conditionNotes }` (→ COLLECTED).
- `POST /api/recovery/:id/unable-to-collect` — body `{ reasonCode }`,
  `reasonCode` ∈ `COMPANY_REFUSED | VEHICLE_UNREACHABLE | DEVICE_MISSING | OTHER` (routes to ZM queue).

## Validation & error codes (CORRECTION — serial is server-validated)

- Serial validation is **server-side**: `deviceSerial` must equal the ticket's device id, else
  `INVALID_SERIAL` (400). The client may pre-check non-empty, but the **server is authoritative** —
  surface `INVALID_SERIAL` inline. (Supersedes the earlier "client-side" wording.)
- `INVALID_REASON` (400) on unable-to-collect.

## Permissions

- SE actions only (assigned SE). Warehouse receipt + ZM decisions are other roles (Issue 36/37).

## Navigation

- Unable to Collect submit → confirmation that the ticket moved to the ZM decision queue.

## Offline behaviour

- on-site / collected / unable writes queue via Issue 17 when offline; replay preserves order.

## Edge cases & failures

- Wrong serial → `INVALID_SERIAL`; empty condition notes → blocked client-side before POST.
- After COLLECTED, closure is auto on warehouse receipt — no SE action (PRD §573).

## UI surfaces

- **Mobile:** Recovery Day-Plan card + on-site / Collection Form / Unable-to-Collect. Owned by this issue.
- **Admin:** n/a (WM receipt queue + ZM decision queue are Issues 36/37).

## Reference

- No mobile screenshot exists — build to PRD §567 Flow 7 (PRD-flow-driven; satisfies the parity gate).

## Tests (TDD targets — red first)

- Mark On-Site posts to `/on-site`.
- Collection Form with a serial mismatching the ticket → `INVALID_SERIAL` rendered; matching serial → COLLECTED.
- Unable-to-Collect reason picker posts the enum; UI confirms routing to the ZM queue.

## Blocked by

- #54 (Mobile Foundation — RN/Expo shell)
- #36 (done — backend + endpoints)

## Comments

### 2026-07-28 — data-needs spec (#172 D-9 closed; no mockup)

Full spec: `docs/status/se-screen-data-needs-2026-07-28.md` §1. Three things this issue must absorb:

1. 🔴 **This issue's premise is not satisfiable today.** "RECOVERY appears in the Day Plan as a
   first-class work type" — `/api/schedules/me` reads `plantBatchAssignment` → `batchAssignmentTicket`
   only (`day-plan-query.service.ts:49-60`), and the recommender selects `TROUBLESHOOT`
   (`recommender.service.ts:113-115`) and `INSTALL` (`:477-479`) — **there is no RECOVERY path**.
   `POST /api/recovery/:id/schedule` sets `assignedSeId` and creates no batch row
   (`recovery.service.ts:92-98`). This is a **design decision**, not a field addition.
2. **The expected device serial is unreadable.** `collected` compares
   `deviceSerial === String(ticket.deviceId)` exactly (`recovery.service.ts:124`), and there is
   **no `GET /api/recovery/:id`** — every read on that controller is WM/manager (`:85-111`). The SE
   types blind against an exact-match check. Owned by **#163**.
3. **Error codes:** this issue pins `INVALID_SERIAL`; the controller emits **`INVALID_DEVICE_SERIAL`**
   (`recovery.controller.ts:146`). It also omits `CONDITION_NOTES_REQUIRED` (`:147`), which the
   server *does* enforce. Freeze the server's codes (#169).

Also (b) on `RecoveryView` itself (`recovery.service.ts:26-36`): `unableToCollectAt`
(`schema.prisma:2056`) and `closureReason` (`:2058`) exist but are not in the view — so a ticket
sitting at `ON_SITE` with an unable-to-collect already filed is indistinguishable from a fresh one.
