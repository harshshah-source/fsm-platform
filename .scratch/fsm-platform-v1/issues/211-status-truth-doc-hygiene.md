# 211 — Status truth: the M-series statuses, CLAUDE.md, and SYSTEM-STATE's self-contradiction

Status: ready-for-agent
Type: AFK · Documentation / tracker hygiene
Parent: [#197](./197-mobile-pilot-readiness-remediation-epic.md) · Filed 2026-08-04
Blocked by: nothing

## Root cause

The project's stated convention is that `docs/SYSTEM-STATE-2026-07.md` is the only current-state
document and `INDEX.md` the only work tracker, both edited in place. In practice, per-issue status
lines were updated when work landed but the *checkbox* state and the *summary* documents were not —
so six mobile issues sit at `ready-for-agent` with every acceptance criterion already ticked,
`SYSTEM-STATE` contradicts itself between two sections, and `CLAUDE.md` still tells every new session
that the mobile app is an auth shell. The cost is not tidiness: it is that "what is left on mobile"
cannot be answered correctly from the tracker.

## Findings closed

Audit 1: stale `CLAUDE.md` description. Audit 2: **B5** (stale `@fsm/shared` comments). New: **N4**
(`SYSTEM-STATE` self-contradiction), **N7** (M-series statuses stale).

## Evidence — verified 2026-08-04

**Statuses that contradict their own contents**
- `#55` (M1 Home) — `ready-for-agent`, **5/5 ACs `[x]`**
- `#57` (M3 Ticket Detail) — `ready-for-agent`, **5/5 `[x]`**
- `#58` (M4 Troubleshoot) — `ready-for-agent`, **4/4 `[x]`** (genuinely open: the photo AC, per its
  2026-08-04 correction — so the *status* is right and the *checkboxes* overstate)
- `#59` (M5 Verification) — `ready-for-agent`, **3/3 `[x]`**
- `#60` (M6 Stock) — `ready-for-agent`, **4/4 `[x]`**
- `#147` (day-plan date filter + closure) — `ready-for-agent`, **6/6 `[x]`**, INDEX records the slices
  as landed
- `#54` 8/9, `#56` 2/3, `#146` 6/9 — same shape, partial
- Conversely ~25 issues carry a `done` status with unticked ACs (worst: `#128` `DONE` with **15**
  unticked, `#161` `✅ DONE — nothing deferred` with 6, `#163` `✅ DONE` with 5). These are
  bookkeeping contradictions in the opposite direction.

**Current-state docs**
- `CLAUDE.md:4-5` — "SE Mobile App (React Native + Expo; **auth shell only so far**)".
- `docs/SYSTEM-STATE-2026-07.md:77-79` — "**auth shell only** today… Issue #54 is not done; every
  M-series mobile surface is unbuilt."
- `docs/SYSTEM-STATE-2026-07.md:802-806` (§4.4) — "**substantially built as of 2026-08-04** —
  foundation/shell, Home, Tickets, Ticket Detail + soft-states, Troubleshoot form, Verification,
  Stock/Vouchers, Vehicle Unavailability, same-day plan cues, Recovery, Install, intra-day
  accept/decline, Notifications, Leave Request, Availability… are done. Still unbuilt: Push (#89)."
- **The same document says both things.** §4.4 is correct; §1 was never edited in place as the
  convention requires.

**Stale contract comments that misdirect the next builder**
- `packages/shared/src/index.ts:389-390` and `:404` — "photo capture is blocked on #81 (Media Upload
  API, unbuilt)". #81 is `done`; two other mobile forms already use it.
- `apps/mobile/src/tickets/dayPlanCues.ts:12-19` — "the server has no 'added/removed since' signal".
  #161 shipped exactly that signal (see #201).
- `apps/backend/src/auth/auth.controller.ts:27-30` — claims one-active-device "only meaningfully
  activates once a client sends a real stable id"; the revoke-all write is fully live (see #202).
- `#169:41` — "Flat `setGlobalPrefix('api')` today; **no `enableVersioning`**" — contradicted by
  `app.config.ts:27` and by #169's own "LANDED ✅" comment.

## Scope

**In:** reconcile the M-series and `#147` status lines with their checkbox state (in whichever
direction is true — several are genuinely done, `#58` genuinely is not); fix `SYSTEM-STATE` §1 in
place to match §4.4; fix `CLAUDE.md`'s mobile description; correct the four stale code comments
listed above; correct `#169`'s stale body text.

**Out:** re-litigating whether any issue is actually done — this slice records reality, it does not
re-adjudicate it. The ~25 `done`-with-unticked-ACs cases: fix the ones touched by this epic and
record the rest as a known bookkeeping backlog rather than sweeping all of them here.

## Acceptance criteria

- [ ] `#55`, `#57`, `#59`, `#60`, `#147` carry a status matching their ACs; `#54`/`#56`/`#146`/`#58`
      state precisely what remains
- [ ] `SYSTEM-STATE-2026-07.md` §1 no longer contradicts §4.4, and §1 points at `INDEX.md`'s session
      log as the live source (as §4.4 already does)
- [ ] `CLAUDE.md`'s mobile line reflects reality
- [ ] The four stale code comments are corrected or deleted
- [ ] Reading only `CLAUDE.md` → `SYSTEM-STATE` → `INDEX.md`, in the order `CLAUDE.md` prescribes,
      yields a correct answer to "what is left on mobile" — this is the actual test

## Verification

Manual read-through in the prescribed order. Cross-check the resulting mobile list against
`INDEX.md`'s 2026-08-04 session-log rows.

## Risk if deferred

Every new session — human or agent — starts from `CLAUDE.md` and is told the mobile app is an auth
shell, then reads `SYSTEM-STATE` §1 and is told the same thing, and only reaches the truth if it gets
as far as §4.4 or the session log. The observable cost is already on record: audit 1 had to
independently rediscover that 21 screens exist. Meanwhile six issues that look like available work
are actually finished, so the next planner picks up work that does not exist.

## Size estimate

S. Entirely documentation; the only care needed is not overstating `#58` (photo AC genuinely open)
and `#54`/`#56` (partial).
