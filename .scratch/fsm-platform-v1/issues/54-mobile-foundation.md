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
- [ ] 🔴 **The app generates a stable install id on first launch, persists it in the keychain, and sends it as `X-Device-Id` on every request — including `POST /api/auth/login` and `/refresh`.** See the warning below; this one cannot be added later.
- [ ] The install id survives app restart and re-login, and is regenerated **only** on reinstall
- [ ] The client sends `/api/v1/...` as its base path (both `/api/v1` and `/api/` are served — #169 Wave 0 — but v1 is the path to pin)

## API contract

- Auth reuse (Issue 01, already wired in `apps/mobile/src/auth`): `POST /api/auth/login`,
  refresh/session via `tokenStore`. The client attaches the access token to every request.
- No new endpoint is introduced by this issue.

> ### 🔴 `X-Device-Id` must be in the FIRST build — it cannot be retrofitted
>
> **D-2 (settled 2026-07-28): one active device, replace-on-login.** Logging in on a handset revokes
> the previous handset's session. The server binds each session to a device via `refresh_tokens.device_id`
> (**#91**), and **the only source of that id is this client.**
>
> **This is the single non-additive item in the entire mobile contract freeze.** Everything else on
> the backend side was deliberately shaped to be addable later. This one is not:
>
> - If v1 ships without `X-Device-Id`, the server **cannot attribute sessions to devices at all** —
>   one-active degrades to "one session per user with no idea which phone holds it", and the
>   lost/stolen-handset story stops working.
> - Retrofitting means a **client update**, which needs an OTA channel that **does not exist**
>   (**#170**, unbuilt). An installed APK cannot currently be updated or forced to update.
>
> **Requirements:** generate a UUID on first launch · persist it in the keychain beside the tokens ·
> send it on **every** request including `login` and `refresh` (login especially — that is where the
> server decides which prior session to revoke) · keep it stable across restart, logout and re-login ·
> regenerate **only** on reinstall.
>
> Going to 2 or N live devices later is a **config change on the server, not a migration** — but only
> because this header exists. Ship it in v1 even though v1's policy never shows the user a device list.

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

- `docs/ui/mobile/home-dashboard.png`, `tickets-priority-view.png`, `inventory.png`,
  `vouchers.png`, `profile.png` (tab structure, nav, kit styling)

## Tests (TDD targets — red first)

- App boots to bottom-tabs (Home/Tickets/Stock/Vouchers/Profile); only role-visible tabs render.
- Each kit primitive renders against token values (snapshot/structural).
- Queue interface accepts a write and reports PENDING when offline; replays when connectivity returns.
- Unauthenticated launch lands on LoginScreen.

## Blocked by

- #01
