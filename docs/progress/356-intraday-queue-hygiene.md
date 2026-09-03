# 356 — Intra-day queue hygiene: bounded reads, refresh, labels, dead routes, dead branch

**Done 2026-09-03.** Wave 3 of the module-gaps completion plan
(`docs/module-gaps/IMPLEMENTATION-PLAN.md` §4), absorbing survey ids INTRA-G3, G5, G6, G7, G8, G9,
G10, SCH-06 and NOTIF-05 (as dead code, not a gap), and **closing #331** — both of its acceptance
criteria are met here. Red-first.

## What it closes

The Intra-day Queue is the screen a dispatcher watches through the working day, and it was
untrustworthy in three ways at once — none of them visible from the screen itself.

**It was unbounded.** `listForScope` returned every insertion ever written in scope (552 rows for one
ZM on the day the survey measured it, one more every sweep tick), and `listIntradayUpdates` loaded
every `MANUAL_ZM_UPDATE` audit row there had ever been and then filtered by zone in memory. Both are
append-only tables. The page therefore got slower in exact proportion to how busy the day had been:
slowest on the afternoon it mattered most, with no ceiling on where that ends.

**It never refreshed.** `useEffect(load, [])` — one read, at mount. What was on screen was whatever
had been true when the tab was opened. A dispatcher pressing Assign on a row a colleague resolved
twenty minutes ago is the exact failure this page exists to prevent.

**Its labels were not labels.** `INSERTION_LABEL` was a `Partial<Record<…>>` covering two statuses.
`ACCEPTED` — the status a **manager's own assignment** leaves — fell through to `row.status` and
rendered the raw enum, and so did every historical offer-machinery status. The "SE Acceptance" column
printed `row.status` verbatim for every insertion row. A human decision and a system one read as the
same kind of event on the screen whose whole job is saying what changed and who changed it.

On top of that: three same-day write routes with zero callers, a silent-return on a missing ZM at two
sites, a stale comment, and a dead delivery model.

## Where the issue's premise was wrong

Two corrections, both minor, both built against reality:

1. **"`api/intradayUpdates.ts` — remove the dead clients."** There were none. The three
   `POST /intraday-updates/*` routes never had an admin client at all: #313 made
   `/batches/:id/override` the single same-day write surface before anything in `apps/admin` needed
   them. So AC5's "no client references remain" was already true on the client side and only the
   server-side deletion was outstanding. What the file did need was the *query* half.

2. **`escalateToZm` "uses the role-based resolver introduced by #354".** #354 landed
   `NotificationService.recipientsInRoles` but kept its zone-manager *policy* (designated id first,
   role second) private in `cross-zone-escalation.service.ts`. Reusing it meant either editing that
   file (not mine this round) or copying the policy into two more services. Neither is right for a
   rule three producers now depend on, so it is promoted to
   `NotificationService.zoneManagerRecipients` — the file that owns "who gets told" — and cross-zone's
   private copy can adopt it whenever that file is next open.

## The shape of the fix

### The reads are windows, and the window says it is one

Both reads return `{ rows, nextCursor, limit }`. The envelope is the point: a truncated array that
cannot say it was truncated is **worse** than the unbounded read it replaces, because a dispatcher
reads "that is all of it" off a list that is not. `limit` is the bound actually applied, so a caller
who asks for 10 000 is told they got 200.

`listForScope` orders `createdAt desc, insertionId desc` and carries a Prisma cursor on the primary
key. The tiebreak is load-bearing, not tidiness: the sweep escalating two tickets in one tick writes
two rows sharing a `createdAt` to the microsecond, and an undefined order between them is a cursor
that can skip or repeat a row across pages. It fetches `limit + 1` rows and returns `limit` — the
cheapest honest answer to "is there another page?".

`listIntradayUpdates` could not take that shape, and the reason is worth recording. A ZM's rows are
only knowable *after* each audit row's zone is resolved (via the ticket's plant or the batch's
schedule); `audit_logs` carries no zone and Prisma cannot join to one. A naive `take` would hand a ZM
a short page whenever the newest rows belonged to other zones. So it scans newest-first in chunks of
200 and stops at the first of: the page is full, the stream is exhausted, or 2 000 rows have been
examined. The cap makes the worst case finite; the cursor makes the truncation recoverable rather
than a silent loss. `scanFrom` advances **per row, not per chunk** — a page that fills halfway
through a chunk must hand back a cursor pointing at the row it stopped on, or the rest of that chunk
is lost to the caller.

### A missing ZM is a logged miss, never silence (AC4, #331 AC1)

`NotificationService.zoneManagerRecipients(zoneId, client)` is the one answer: the designated
`zones.zonal_manager_user_id` when the zone names one — a zone with an accountable manager does not
want its news fanned out to everyone holding the role there — else the ACTIVE role holders in that
zone, else an empty result that `recipientsInRoles` has already logged as `NO_RECIPIENT`. It takes a
client so it resolves **inside** the producing transaction, which is #338's rule: the outbox row must
record the recipients its own transaction saw.

Both call sites still return `null` when nobody at all holds the role, because there is then genuinely
nobody to tell. What changed is that the miss is on the record.

The second site is the worse of the two, and this is why the fallback matters more than it looks.
`escalateStrandedWork` writes a ledger row per stranded ticket **and** #288's re-escalation guard keys
on those rows. On a zone with no designated ZM the old code created the "a human already knows" marker
for work no human had been told about — and then refused to escalate it again on the next availability
write. The day's work went quiet in a way nothing could reopen.

### Three doors that opened onto nothing

`POST /intraday-updates/add|remove|reorder`, their `SameDayUpdateService` methods and their e2e are
deleted (recorded decision, plan §7 "356 deletion"). `SameDayUpdateService` no longer takes
`OverrideService` at all; it is a read.

A live route with no callers is worse than a missing one. It looks like a supported way in, while its
validation, its error vocabulary and its audit action drift away from the surface people actually use
— and the first caller to find it gets a door that behaves like nobody has walked through it in a
year, which is exactly true.

`MANUAL_ZM_UPDATE` is now a **historical** audit action: nothing in this repo writes it. The read
survives because the history it lists is still the record of what managers did to today's plans, and
`system-efficiency-aggregation` / `zm-performance-aggregation` still count those rows. See follow-ups.

### The dead acceptance branch (AC6)

`deliveryModel: 'SE_ACCEPTANCE'` delivered WhatsApp as a "first-class" confirmation for the SE
Acceptance step that CONTEXT §21 retired (#268/#279). No producer had passed it since; every live call
site spells `'GENERAL'`. The branch is gone, `DeliveryView.firstClass` is gone from the service's
shape, and nothing writes `notification_deliveries.first_class` any more (the column keeps its `false`
default — see follow-ups). The union is kept as a single-member type rather than deleted so call sites
still say which model they mean, and so #337's push work has somewhere to land a second one.

## Decisions worth keeping

**1. The response shape is a breaking change, taken deliberately.** Both reads used to return arrays
and now return envelopes. Silently capping the array at 50 would have been non-breaking and much
worse: the one consumer is a screen a human makes dispatch decisions on, and it would have shown a
truncated list with nothing to say so. The client is the same slice, so the change costs nothing and
buys `nextCursor`.

**2. Malformed query values are 400s, not silent fallbacks.** `?since=not-a-date`,
`?cursor=not-a-number` and `?status=NOT_A_STATUS` all refuse. A dispatcher who filters to "escalations
since 09:00" and silently gets the unfiltered queue back is being lied to by the screen they use to
decide where engineers go. An unknown *status* is the sharpest case: coerced, it would match nothing
and render as "no escalations right now" — the single answer this page must never give wrongly. A
`take` that is not a number is likewise a malformed request; a `take` of 10 000 is merely an ambitious
one and is clamped with `limit` reporting what happened.

**3. A status filter excludes the ZM-update stream rather than pretending to apply to it.** A
`MANUAL_ZM_UPDATE` audit row has an update *type*, not a status. Mapping the two would be inventing a
correspondence; showing those rows through a filter that never touched them would be worse. So a
narrowed queue is insertions only, and says so by simply not listing them.

**4. The auto-refresh does not blank the table, and does not poll a hidden tab.** `load(at,
background)` distinguishes the 30 s tick from a click: a background refresh never drops the page into
its loading skeleton under a dispatcher's cursor and never replaces good rows with an error banner
because one poll landed during a redeploy — it keeps the last good page and tries again in thirty
seconds. A hand-driven load says both things out loud. The tick is gated on
`document.visibilityState`, so a queue left open overnight comes back to one read rather than twelve
hundred, and it re-reads the *current* position rather than jumping home — a manager reading page 3
does not want the page to walk out from under them every half minute.

**5. Prev is a trail, not a subtraction.** Keyset paging only goes forward, so the pager keeps a stack
of visited positions. Each position is a *pair* of cursors, since the two streams page independently.
This is also why the pager offers Prev/Next rather than page numbers: there is no total to compute
without the unbounded count this slice exists to remove.

**6. Every status gets a label, not only the live ones.** `INSERTION_LABEL` is now a total
`Record`. The retired offer statuses (`PENDING_ACCEPTANCE` / `DECLINED` / `TIMED_OUT`) still sit on
historical rows that a wide-enough `since` will fetch, and a `Partial` record is exactly how `ACCEPTED`
came to be printed as an enum in the first place.

**7. The layout is the reference's, extended in place.** `13-intraday-queue.png` already draws a
filter band above the table (search · type · result count). The chips, the date filter, the pager and
Refresh ride `DataTable`'s own `toolbar` slot in that band. Nothing was redesigned; the metric strip,
the `iq-*` test ids, the columns and the drawer navigation are untouched.

## Acceptance criteria

- **AC1 — default page ≤ 50 rows, newest first, filterable by status and date, cursor paging.** Met on
  both streams and on both HTTP doors. `intraday-insertions-controller` proves it end to end over 60
  synthetic rows; `same-day-update-service` proves the zone-scoped scan over 60 in-zone rows plus one
  out-of-zone; `intraday-queue.test.tsx` proves the page asks for `take=50` and walks the cursor.
- **AC2 — the queue refreshes without a page reload.** Refresh button + a 30 s visible-tab tick, both
  asserted, plus a negative assertion that a hidden tab is not polled.
- **AC3 — no raw enum label is shown.** `ACCEPTED` renders "Manager assignment"; a sweep asserts that
  none of the six enum spellings appears anywhere in the table's text.
- **AC4 — a missing ZM → role fallback or a logged miss, never a silent return.** Both sites, each
  with its own e2e; the `NO_RECIPIENT` log is asserted directly.
- **AC5 — the three same-day write routes return 404 and no client references remain.** Asserted for a
  **ZM** — the caller these routes were built for — because a 403 for an SE would prove nothing about
  the door being gone.
- **AC6 — the dead acceptance branch is removed and its test rewritten.** #76's two tests are rewritten
  rather than deleted: what #76 protected (a channel the gateway did not send is never recorded SENT)
  outlives the branch and keeps its test.

### #331, absorbed

- **AC1 — a missing ZM can no longer silently swallow an escalation alert.** Both sites, above.
- **AC2 — no mutation-adjacent list read is unbounded.** `listForScope` and `listIntradayUpdates`,
  above. #331's caution about "a too-small default window hiding rows a page relies on" is answered by
  the envelope: the page reports what it applied and offers the next one.

## Tests

Backend (through `.scratch/locks/backend-test.sh`):

```
 ✓ test/same-day-update-service.e2e-spec.ts        (7 tests)
 ✓ test/intraday-insertions-controller.e2e-spec.ts (15 tests)
 ✓ test/intraday-updates-controller.e2e-spec.ts    (5 tests)
 ✓ test/notification-service.e2e-spec.ts           (8 tests)
 ✓ test/intraday-critical-insertion.e2e-spec.ts    (11 tests)
 ✓ test/se-unavailable-stranded-work.e2e-spec.ts   (9 tests)

 Test Files  6 passed (6)
      Tests  55 passed (55)
```

Regression sweep over everything that touches the changed surfaces:

```
 test/mutation-door-input-validation.e2e-spec.ts, test/dispatch-changes-today.e2e-spec.ts,
 test/intraday-notification-outbox.e2e-spec.ts, test/intraday-ledger-atomicity.e2e-spec.ts,
 test/notifications-controller.e2e-spec.ts, test/notification-seam-assertion.e2e-spec.ts,
 test/business-sweep-scheduler-intraday.e2e-spec.ts, test/acting-scope-route-sweep.spec.ts,
 test/cross-zone-escalation.e2e-spec.ts, test/day-plan-notification-outbox-writers.e2e-spec.ts

 Test Files  10 passed (10)
      Tests  106 passed (106)
```

Admin:

```
 ✓ test/intraday-queue.test.tsx (19 tests)

 Test Files  1 passed (1)
      Tests  19 passed (19)
```

`apps/backend` `tsc --noEmit` reports nothing in any file this slice touched; `apps/admin` `tsc -b` is
clean.

Deleted: `test/same-day-update-remove-reorder.e2e-spec.ts` — it tested only the two deleted service
methods. Its one piece of independent value, the engine's ON_SITE confirm gate, is covered on the
surviving surface by `batch-override-onsite.e2e-spec.ts`.

## Follow-ups this slice does not own

1. **Drop `notification_deliveries.first_class`.** Nothing writes it and nothing reads it. The column
   drop needs `apps/backend/prisma/schema.prisma` + a hand-written migration + `prisma generate`,
   and this slice ran concurrently with five others: regenerating the Prisma client mid-round changes
   it under all of them. Deferred deliberately, not overlooked. **The Prisma drift gate was not run**
   (it cannot run on this box) — and no migration was written, so there is nothing for it to check.
2. **Index `audit_logs(action, created_at)`** (the plan's own "if absent" — it is absent; the table has
   `(entity_type, entity_id)` and `(acted_as_role, acting_zone, created_at)`). Same reason as (1): a
   schema file five other agents are building against. The read is bounded either way; the index is
   what would make the ZM-scoped scan cheap rather than merely finite.
3. **`MANUAL_ZM_UPDATE` is now a dead audit action.** Nothing writes it; `dispatch-changes-today`,
   `system-efficiency-aggregation` and `zm-performance-aggregation` all still read or count it, and
   the queue still lists its history. Whether the Intra-day Queue should instead surface the
   `/batches/:id/override` audit rows that replaced it is a product question about what "intra-day
   change" means, not a hygiene fix — worth an issue.
4. **`mutation-door-input-validation.e2e-spec.ts:172-178`** still asserts 404 on
   `intraday-updates/remove|reorder` for a non-numeric `batchId`. Those two now pass because the route
   is gone rather than because the parse guard works, so they no longer test what their names say.
   That file is not this slice's to edit; the assertions are harmless but hollow.
5. **`cross-zone-escalation.service.ts`'s private `zoneManagers`** should adopt
   `NotificationService.zoneManagerRecipients` — it is now the same policy written twice. Left alone
   because #354's file was not this slice's to edit.

## Shared files touched outside the owned set

`apps/backend/test/fixtures/outbox-crash-injection.ts` — one additive change, called out under the
parallel-round shared-leaf exception. `throwingNotifications()` stubbed `notify` only; the escalation
producers now **resolve recipients** through the notification service before delivering through it, so
the stub made them fail at resolution, before the row the fixture exists to prove durable was ever
written. It now takes an optional `PrismaService`: with one, everything except `notify` is the real
service and the injected crash stays where it belongs (delivery). The no-argument form is byte-for-byte
unchanged for the producers that only deliver, so no other spec's behaviour moves.
