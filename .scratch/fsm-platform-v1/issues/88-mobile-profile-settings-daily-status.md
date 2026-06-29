# 88 — M8d: SE Profile / Settings / Daily Status

Status: needs-info
Type: AFK · Mobile

## What to build

The SE Profile tab (PRD Screen Inventory): profile details, app settings (logout, local prefs), and a
**Daily Status** view. Profile + Settings are buildable over existing reads; the Daily Status data
source is the one open question (see Dependencies).

## Business rules (authority)

- PRD §479 (Screen Inventory — Profile, Daily Status). `docs/ui/mobile/profile.png.png`,
  `docs/ui/mobile/daily-status.png.png`.

## Acceptance criteria

- [ ] Profile renders the signed-in SE's identity from `GET /api/me`
- [ ] Settings provides logout (Issue 01 session) + local app preferences
- [ ] Daily Status renders the SE's day summary *(source to be confirmed — see Dependencies)*

## API contract (authority: backend on `main` where it exists)

- `GET /api/me` → the authenticated user (id, role, zone, name) (`me/me.controller.ts`).
- Logout / session via Issue 01 (`tokenStore`).
- **Daily Status:** no dedicated endpoint exists. Candidate composition from existing reads
  (`/api/schedules/me` completion counts, soft-state activity) — OR a new read. **Do not invent**:
  confirm the intended Daily Status content + source before building that section.

## Permissions

- SE-only; `/api/me` is server-scoped to the caller.

## Navigation

- Profile tab → Settings / Daily Status sub-views; logout → LoginScreen.

## Offline behaviour

- Profile + last Daily Status render from cache when offline.

## Edge cases & failures

- Daily Status with no completed work → empty/zero state.

## UI surfaces

- **Mobile:** Profile / Settings / Daily Status. Owned by this issue.
- **Admin:** n/a.

## Reference

- `docs/ui/mobile/profile.png.png`, `docs/ui/mobile/daily-status.png.png`

## Tests (TDD targets — red first)

- Profile renders identity from `/api/me`; logout clears the session.
- *(after source confirmed)* Daily Status renders the day summary; empty state when no work.

## Open question (blocks the Daily Status AC only)

- What metrics does Daily Status show, and from which read? Profile + Settings are unblocked and may
  ship first; Daily Status stays `needs-info` until the source is confirmed (no invented metric set).

## Blocked by

- #54, #01
- (Daily Status data source) needs-info — to be confirmed before building that section
