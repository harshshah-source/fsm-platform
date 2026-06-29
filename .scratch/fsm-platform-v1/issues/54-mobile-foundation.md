# 54 — Mobile Foundation (RN shell + nav + component kit + offline-aware client)

Status: ready-for-agent
Type: AFK · Mobile

## What to build

The SE mobile app shell that every mobile UI surface depends on. React Native + Expo. Bottom-tab
navigation (Home / Tickets / Stock / Vouchers / Profile), a shared component kit (`BottomTabBar`,
`TicketCard`, `StatTile`, `IconSelectGrid`, `PhotoCaptureRow`, status pills, charts), an
offline-aware API client **seam** (consumes existing backend endpoints; exposes a write-queue
interface + connectivity state — the durable queue + batched sync are Issue 17), session + auth
wiring (reuse Issue 01 auth shell), and app theming aligned to the mobile mockups. No feature
screens beyond the tab skeletons — those are the M-series (55–61).

> **Scope clarification (no hidden dependency):** this issue ships the offline *seam* only — a queue
> interface, a connectivity detector, and a replay-to-individual-endpoints stub. Durable persistence
> (WatermelonDB/SQLite) and `POST /api/sync/batch` are Issue 17. Nothing here depends on the unbuilt
> batch endpoint.

## Business rules (authority)

- PRD §307 (Architecture — SE Mobile App), §479 (Screen Inventory). DESIGN-SYSTEM §6 (mobile kit,
  NativeWind tokens). Tokens mirror admin values; no raw hex / off-scale spacing.

## Acceptance criteria

- [ ] Expo app boots with bottom-tab navigation: Home, Tickets, Stock, Vouchers, Profile (empty tab shells)
- [ ] Shared component kit primitives exist and render against the mockup styling (DESIGN-SYSTEM §6)
- [ ] Offline-aware API client exposes a write-queue interface + connectivity state; auth/session reuse from Issue 01
- [ ] Each tab shell registers its nav entry (no dead labels; role-visible tabs only)

## API contract

- Auth reuse (Issue 01, already wired in `apps/mobile/src/auth`): `POST /api/auth/login`,
  refresh/session via `tokenStore`. The client attaches the access token to every request.
- No new endpoint is introduced by this issue.

## Permissions

- The app is SERVICE_ENGINEER-facing. Tabs render only for the authenticated SE role.

## Offline behaviour

- The client seam reports `online | offline`; writes issued while offline are handed to the queue
  interface and surfaced as PENDING. Actual durability + batched flush land in Issue 17.

## Edge cases & failures

- Token expired/invalid → route to LoginScreen (Issue 01).
- Offline at boot → shells render; reads show cached/empty state, no crash.

## UI surfaces

- **Mobile:** the shell itself — bottom-tab navigation + component kit + tab skeletons. Owned by this issue.
- **Admin:** n/a.

## Reference

- `docs/ui/mobile/home-dashboard.png.png`, `tickets-priority-view.png.png`, `inventory.png.png`,
  `vouchers.png.png`, `profile.png.png` (tab structure, nav, kit styling)

## Tests (TDD targets — red first)

- App boots to bottom-tabs (Home/Tickets/Stock/Vouchers/Profile); only role-visible tabs render.
- Each kit primitive renders against token values (snapshot/structural).
- Queue interface accepts a write and reports PENDING when offline; replays when connectivity returns.
- Unauthenticated launch lands on LoginScreen.

## Blocked by

- #01
