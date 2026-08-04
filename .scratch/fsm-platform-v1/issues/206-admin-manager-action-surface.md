# 206 — Admin manager-action surface: Action Required + notification badge, and bind the intraday columns

Status: ready-for-agent
Type: AFK · Admin
Parent: [#197](./197-mobile-pilot-readiness-remediation-epic.md) · Filed 2026-08-04
Blocked by: nothing — every backend read this needs already ships

## Root cause

The notification spine (#03) and the intraday insertion lifecycle (#29/#30) are both built, tested,
and serving — and the admin dashboard reads neither. The TopBar bell is a decorative button with no
handler, and the Intra-day Queue page binds only ZM manual updates while its acceptance columns are
still the "forward-compatible placeholders" FE-13 shipped. The states that exist specifically to
demand manager action — `ESCALATION_REQUIRED` after three failed CRITICAL offers, unable-to-collect
routed to the ZM, cross-zone escalations — are therefore invisible to the person who is supposed to
act on them.

## Findings closed

Audit 2: **D4** (intraday states: 5 produced, admin displays 0), **D5** (admin consumes no
notifications). New: **N5** (#29's AC#6 is factually false).

## Evidence — verified 2026-08-04

- `apps/admin/src/components/shell/TopBar.tsx:130-136` — a bell `<button>` with **no `onClick` and no
  data source**. `docs/ui-redevelopment/04-layout.md:51` calls it "decorative, no behavior".
- Repo-wide grep for `notification` in `apps/admin/src` returns only comments — no consumer at all.
- `grep -rn "intraday-insertions|IntradayInsertion" apps/admin/src` → **zero hits.**
  `IntradayQueuePage.tsx:23` still carries the placeholder comment; `:103` hardcodes the acceptance
  column to `"No acceptance required"`, while the page's own subtitle at `:122` claims
  "System-triggered CRITICAL insertions appear here too."
- Admin's only intraday client hits a different endpoint: `apps/admin/src/api/intradayUpdates.ts:26`
  → `/intraday-updates` (the ZM manual audit read), not `/api/intraday-insertions`.
- The manager read exists and is role-scoped: `intraday-insertion.controller.ts:32,37-39`. Five
  states are producible: `PENDING_ACCEPTANCE`, `ACCEPTED`, `DECLINED`, `TIMED_OUT`,
  `ESCALATION_REQUIRED` (`generated/prisma/enums.ts:66-72`).
- Tones are already defined and unused: `apps/admin/src/components/domain/badges.tsx:103-107`.
- 15 notification types are produced backend-side (enumerated in the contract audit §B3); one is
  consumed anywhere, and that one is on mobile.
- **`#29` AC#6 `[x] Intra-day Queue reflects PENDING_ACCEPTANCE / ACCEPTED / DECLINED status in real
  time` is false**, as is its disposition claim that FE-13 "consumes `/api/intraday-insertions`".
  FE-13 deferred it explicitly ("Leave column space… when backend 29/30 ship") and filed no
  follow-up. Corrected in place on #29.
- **Fully specified, so this is unbuilt-AC work, not new design:** `PRD:325` (the page),
  `PRD:384-397` (the flow, including the exact status badges and the "Manual assignment needed"
  Action Required alert after 3 retries), `PRD:213` + `workflow:1471-1483` (the per-role in-app
  event matrix), `PRD:99`/`:354` (Action Required panel), `PRD:384` (header badge).
  Authoritative reference image: `docs/ui/desktop/v2-reference/13-intraday-queue.png`.

## Scope

**In:** an admin notification client over the existing `/api/notifications`; a live header badge; an
Action Required panel fed by it; and binding the Intra-day Queue's insertion rows and status badges
to `/api/intraday-insertions`, including `TIMED_OUT` and the `ESCALATION_REQUIRED` → "Manual
assignment needed" alert.

**Out:** **a notification-centre page.** The PRD deliberately does not have one for managers — the
admin page inventory (`PRD:320-345`) contains no `notifications` route, while the SE mobile screen
table does (`PRD:499`). Building an inbox would be inventing a surface. Also out: push/WhatsApp
delivery to managers (#76/#89, external), and the manual-assignment modal itself if it already
exists — bind to it, do not rebuild it.

**Follow the reference image** per `CLAUDE.md`'s surfacing rule: read
`docs/ui/desktop/v2-reference/13-intraday-queue.png` before touching the queue page.

## Acceptance criteria

- [ ] The header badge reflects real unread notifications for the signed-in manager and clears on read
- [ ] The Action Required panel surfaces the events `workflow:1471-1483` marks "In-app Action
      Required" for that role — at minimum: unable-to-collect, manual-assignment-needed, non-op
      awaiting confirmation, component request pending (WM)
- [ ] The Intra-day Queue renders `SYSTEM_CRITICAL` insertion rows with real
      `PENDING_ACCEPTANCE`/`ACCEPTED`/`DECLINED`/`TIMED_OUT`/`ESCALATION_REQUIRED` badges, replacing
      the hardcoded "No acceptance required" cell
- [ ] An `ESCALATION_REQUIRED` insertion raises the "Manual assignment needed" Action Required alert
      (`PRD:395`) and routes to the assignment flow
- [ ] The page subtitle at `IntradayQueuePage.tsx:122` becomes true rather than aspirational
- [ ] `#29` AC#6 is genuinely satisfiable — re-verify and re-tick it there
- [ ] Regression tests for the badge count and the insertion-status rendering. **Cheap** —
      `IntradayQueuePage` has an existing spec and the admin suite has an established fetch-mock
      pattern

## Verification

```bash
cd apps/admin && npx vitest run src/pages/schedules src/components/shell
```
Plus end-to-end: fire an insertion (`POST /api/intraday-insertions/fire`), let it time out, and
confirm the row transitions `PENDING_ACCEPTANCE → TIMED_OUT → ESCALATION_REQUIRED` on the page and
raises the alert.

## Risk if deferred

A CRITICAL ticket that no SE accepts escalates to the ZM after three retries — and the ZM is never
told, on any surface, because push is external-blocked and the dashboard reads nothing. The ticket
sits. This is the one path in the system explicitly designed to require a human, and it currently
terminates in silence. It also means #76's newly-adopted `RECOVERY_UNABLE_TO_COLLECT` notification to
the ZM (landed 2026-08-04) has no reader on any surface.

## Size estimate

M. The notification client and badge are small; the Action Required panel and the intraday binding
are the bulk, and the reference image constrains the layout.
