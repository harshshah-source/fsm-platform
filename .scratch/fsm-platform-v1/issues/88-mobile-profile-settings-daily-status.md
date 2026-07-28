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

## Comments

### 2026-07-28 — the `needs-info` question is answerable from the reference image (freeze plan §1.3)

This issue has been parked on "do not invent — confirm the intended Daily Status content."
`docs/ui/mobile/daily-status.png` specifies it precisely:

- **Four counters** — `ASSIGNED`, `COMPLETED`, `IN-PROGRESS`, `PENDING` — plus a completion
  percentage (`86%`) and an `X/Y Tickets done` line.
- **Tab counts**: `Done (n) / In-progress (n) / Pending (n)`.
- **Day rows in the same shape as the Tickets list**: ticket number, vehicle reg, per-ticket status
  pill, `DEVICE ID`, `TRANSPORTER`, SLA chip, technical hint.
- **A date chip (`10 MAY`) implying historical selection** — `GET /api/schedules/me` serves only the
  current live schedule (`day-plan-query.service.ts:41-46`, ordered by `dispatchedAt`, no date
  param), so this needs a date parameter, not a new metric family.

That is one query with a date filter reusing the Tickets row shape. **Close `needs-info` on this
evidence and rewrite the ACs** rather than escalating (governed by **#172**).

Separately, the **Profile** half of this issue is far larger than "profile details, app settings"
(PRD §479): `profile.png` renders **21 data points** including a 3-level reporting hierarchy with the
**ZM's name, phone and email** — against a `GET /api/me` that returns 4 primitives
(`me.controller.ts:18-23`). The backend fields are owned by **#161**; the PRD-vs-image scope conflict
is **#172** item 10.

Note also: this issue's `## Reference` line cites `.png.png`; the files on disk are `.png`
(all 22 mobile issues have this) — fixed under **#172**.
