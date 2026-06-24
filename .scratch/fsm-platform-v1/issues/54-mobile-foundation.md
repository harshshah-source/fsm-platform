# 54 — Mobile Foundation (RN shell + nav + component kit + offline-aware client)

Status: ready-for-agent
Type: AFK

## What to build

The SE mobile app shell that every mobile UI surface depends on. React Native + Expo. Bottom-tab
navigation (Home / Tickets / Stock / Vouchers / Profile), a shared component kit (`BottomTabBar`,
`TicketCard`, `StatTile`, `IconSelectGrid`, `PhotoCaptureRow`, status pills, charts), an
offline-aware API client (consumes existing backend endpoints; queues writes for Issue 17), session
+ auth wiring (reuse Issue 01 auth shell), and app theming aligned to the mobile mockups. No feature
screens beyond the tab skeletons — those are the M-series (55–61).

## Acceptance criteria

- [ ] Expo app boots with bottom-tab navigation: Home, Tickets, Stock, Vouchers, Profile (empty tab shells)
- [ ] Shared component kit primitives exist and render against the mockup styling
- [ ] Offline-aware API client wraps existing endpoints; auth/session reuse from Issue 01
- [ ] Each tab shell registers its nav entry (no dead labels; role-visible tabs only)

## UI surfaces

- **Mobile:** the shell itself — bottom-tab navigation + component kit + tab skeletons. Owned by this issue.
- **Admin:** n/a.

## Reference

- `docs/ui/mobile/home-dashboard.png.png`, `tickets-priority-view.png.png`, `inventory.png.png`,
  `vouchers.png.png`, `profile.png.png` (tab structure, nav, kit styling)

## Blocked by

- #01
