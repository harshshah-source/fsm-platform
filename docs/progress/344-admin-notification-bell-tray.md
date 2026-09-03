# 344 — Admin notification bell + tray

**Done 2026-09-03.** Wave 1 of the module-gaps completion plan
(`docs/module-gaps/IMPLEMENTATION-PLAN.md` §4), absorbing survey ids NOTIF-08 and INTRA-G2. Red-first.
Admin-only — no backend file changed.

## What it closes

The top-bar bell was a decorative `<button>` for its whole life: no `onClick`, no state, no client
(`TopBar.tsx:215-221`, and `apps/admin/src/api/` had no notifications module at all). Behind it the
notification spine has been writing real in-app rows since Issue 03 and nobody could read them:

- `CROSS_ZONE_AUTO_ESCALATION` / `CROSS_ZONE_MANUAL_FLAG` → a CSM or Operations Head owes a decision
  (`cross-zone-escalation.service.ts:344-353`);
- `CROSS_ZONE_DECISION` / `CROSS_ZONE_RE_ESCALATED` → the home ZM is told what was decided;
- `INTRADAY_ESCALATION_REQUIRED` → a CRITICAL ticket could not be auto-assigned
  (`intraday-insertion.service.ts:552-560`), or an SE went unavailable holding committed work
  (`stranded-work-escalation.service.ts:146-157`). Both say *a human must act now*.

The in-app channel is the one that always fires (`notification.service.ts:81-87`) — so for a
manager sitting in the admin console it was, until this slice, the one channel guaranteed to be
delivered and guaranteed not to be seen.

## The premise, checked

The plan says "backend unchanged" and it is right, with one correction:

- **The three routes exist and are exactly as described.** `notifications.controller.ts:22-40` —
  `GET /notifications` (optional `?unread=true`), `POST /notifications/read-all`,
  `POST /notifications/:id/read`. All authenticated, scoped to `user_id`, no role gate.
- **The default page is 50** (`notification.service.ts:91`), which is why AC2's "newest 50" needs no
  parameter. `unreadCount` is counted over the **whole** mailbox, not the page, so the badge stays
  honest past 50.
- **`?since=` does not exist.** Both the issue file and §4 describe it as "optional `?since=` from
  #165". #165 is still `ready-for-agent` — nothing of it has been built, and the controller takes no
  `since`, `limit` or cursor. The tray therefore re-reads the whole page each poll. Nothing is missing
  for this slice; the note is here so the next reader does not go looking for a parameter.

No backend endpoint was found missing, so nothing was reported up as a blocker.

## Decisions worth keeping

**1. The data lives in `useNotifications`, in the tray's file, and is called by `TopBar`.** The badge
has to be right while the tray is **shut** — that is the whole point of a badge. Mounting the panel to
learn the count would mean the bell only told the truth after someone opened it. So the hook is the
tray module's export and `TopBar` holds it; the panel is a pure consumer of that state.

**2. Read state is optimistic and is never re-fetched on the write.** `markRead` / `markAllRead`
update the local rows and the count first and fire the POST after. A refetch racing an optimistic
update is exactly how a badge flickers back to its old value; the 60 s poll reconciles either way, and
a failed POST surfaces in the tray rather than silently reverting.

**3. The deep link is a function of `(type, role)`, not of type alone.** Type first, entity second: a
cross-zone escalation *is about* a ticket, but the decision the manager owes lives on `/cross-zone`,
not the ticket drawer. The role is part of the answer because both queues are behind `RoleRoute` for
the three manager roles (`AppRoutes.tsx:359,387`) — sending a Warehouse Manager to `/cross-zone` would
bounce them off a gate and read as the tray being broken, so they get `/tickets/:id` instead. This is
what makes AC5 mean something more than "the bell renders".

**4. A row with nowhere to go still marks read, and leaves the tray open.** `DAY_PLAN_DISPATCHED` for
an admin has no admin surface. Closing the tray on a click that moved nothing looks like the click was
swallowed; marking read but staying put is the honest response.

**5. The chip names the *family*, not the raw type.** `CROSS_ZONE_AUTO_ESCALATION`,
`CROSS_ZONE_MANUAL_FLAG`, `CROSS_ZONE_DECISION` and `CROSS_ZONE_RE_ESCALATED` are four types with one
destination, and the row's own title already says which of the four it is. An unrecognised type is
title-cased rather than dropped — a type added by a later backend slice must degrade to something
readable, not to a blank chip.

**6. `relativeTime` is formatted from an explicit month table, not `toLocaleDateString`.** Past a week
the age becomes an absolute date ("01 Jul" beats "63d ago"), and the string must not change shape with
the viewer's locale — the tests would then pass or fail by machine. It also clamps at zero: a row
stamped a few seconds ahead of the browser's clock reads "just now", never "-1m ago".

**7. The client goes through `authHeaders()` (#341).** The list is keyed on `user_id`, so acting
changes nothing about *which* rows come back — but `acting-header-builder.test.ts` fails any client
that authenticates on its own, and that pin is worth more than the local convenience of skipping it.
`notifications-client.test.ts` asserts the acting header is on the wire, so the structural pin has a
behavioural twin.

**8. The hook tolerates an unrecognisable payload.** `Array.isArray(list?.items)` /
`typeof unreadCount === 'number'` guards, because this hook now runs in **every** admin surface's
shell. A shape it cannot read must leave the top bar rendered and quiet, not crash the frame every
page hangs off.

## UI reference

`docs/ui/desktop/v2-reference/01-dashboard-zonal-manager.png` draws the bell with a small unread dot
and nothing behind it; the v2 set and `docs/ui/desktop/approved-designs/` never drew the panel. So the
badge is that dot made exact (capped `99+` so the top bar cannot widen), and the tray is the smallest
panel that discharges it — header, mark-all, list, deep link — built in the shell's existing
`surface-card` / `line` / `ink` tokens and the same outside-click/Escape close contract as
`overlay/DropdownMenu.tsx`. No new visual language was introduced.

## What was tested, and why in that shape

**The tests drive the shell, not the tray in isolation.** Both halves of the defect — a badge in the
top bar and a tray that *navigates* — only exist inside the router, and a mounted-in-isolation panel
would have proved neither. Deep links are asserted on the resulting URL via a location probe, not on a
`navigate` spy: the ACs are about where the operator lands.

**The client is mocked at the module, and pinned separately.** This slice adds no backend, so the
component tests mock `api/notifications`; the wire contract (route, method, headers, id encoding,
non-2xx) is `notifications-client.test.ts`'s job against the real client and a stubbed `fetch`.

**Polling is asserted through the exported constant**, driving the real `setInterval` with fake
timers — not a test-only cadence that could drift from the shipped one.

**The pure helpers are tested as functions.** `relativeTime` / `notificationLabel` /
`notificationLink` carry the branch logic; testing them through six rendered trays would say less and
cost more.

## Acceptance criteria

- **AC1** — met. The badge shows `unreadCount` (the backend's mailbox-wide count, not `items.length`),
  disappears at zero, caps at `99+`, and the bell's accessible name carries the number.
- **AC2** — met. The tray lists the backend's page (newest first, default 50) with a family chip, the
  title, the body and a relative age; empty and failed states are distinct.
- **AC3** — met. A click marks read and navigates — `/intraday`, `/cross-zone` or `/tickets/:id` — and
  an already-read row navigates without a second POST.
- **AC4** — met. Mark-all clears every row and the badge in one call, and is not offered when nothing
  is unread.
- **AC5** — met. All four admin roles get the bell, the count and an openable tray; a Warehouse
  Manager's cross-zone row links to the ticket rather than to a queue their role cannot open.

## Tests, verbatim

New: `apps/admin/test/topbar-notifications.test.tsx` (27) and
`apps/admin/test/notifications-client.test.ts` (6) — **33 tests**, all red first (the tray module did
not exist, so the suite failed to resolve the import).

```
npx vitest run test/topbar-notifications.test.tsx test/notifications-client.test.ts
 Test Files  2 passed (2)
      Tests  33 passed (33)
```

`npx tsc -b` (admin) → exit 0.

Regression check on every shell-touching suite —
`acting-header-builder`, `topbar-search`, `sidebar-shell`, `ui-shell-density`, `breadcrumb`,
`acting-banner`, `acting-zone-scope`, `session-lifecycle`, `routing` → **9 files / 46 tests, all
passing**. The acting-header pin matters most: a new client under `src/api/` is exactly what it exists
to catch.

Full admin suite → **123 files / 880 tests, 869 passed**. The 11 failures are 5 unrelated files
(`assign-console-candidates`, `assign-console-grammar`, `dashboard-critical-action`,
`override-impact-preview`, `scheduler-console-phase2`) that **all pass when re-run together in
isolation** — the full run was executed while several agents held this box, and none of the five
touches the top bar.

## Follow-ups this slice does not own

- **#165 (`?since=` / cursor on `GET /notifications`)** — the tray re-reads the whole 50-row page
  every 60 s per open admin tab. Correct today and cheap; the delta read is #165's to add, and this
  client is the caller that will want it.
- **Live push over polling.** 60 s is the plan's cadence and is right for a P2 badge, but an
  `INTRADAY_ESCALATION_REQUIRED` is a *now* signal. A websocket/SSE channel is a separate decision, not
  a defect in this slice.
- **No admin surface exists for `DAY_PLAN_*` notifications**, so those rows mark read and go nowhere.
  That is a backlog gap in the day-plan surfaces, not something the tray should invent a destination
  for.
