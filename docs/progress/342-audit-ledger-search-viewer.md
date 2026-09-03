# 342 — Audit ledger search + admin viewer + drawer Audit tab

**Done 2026-09-03.** Wave 1 of the module-gaps completion plan
(`docs/module-gaps/IMPLEMENTATION-PLAN.md` §4), absorbing survey ids NOTIF-03, NOTIF-04, AC-05 and
**closing #145**. Red-first. No dependencies; **343** and **340** write the rows this slice makes
readable.

## What it closes

`audit_logs` has been written by ~40 call sites since Issue 03 and had exactly one reader:
`GET /audit-trail/tickets/:ticketId`. That route takes no `@Query`, so answering "who did what, in
whose scope, when" required already knowing a ticket UUID — and for anything that is not a ticket
(a setting, a leave request, an export, a plant zone change) there was no reader at all. The only
other path to a row was the Ops Explorer `auditLogs` dataset: Operations-Head-only and behind
`OPS_EXPLORER_ENABLED`, i.e. off.

On the front end nothing called even that. The ticket drawer's history is derived from
`ticket.lifecycle` — the *state* chain — so every audited *action* on a ticket, including who
overrode the engine and under whose authority, was invisible from the ticket it was taken on.

Now: `GET /api/audit-trail` is a filtered, keyset-paged ledger; `/audit-trail` is a manager-facing
page; and the drawer has an Audit tab beside Lifecycle.

## Where the issue's premise was wrong

**1. The ticket audit rows were already half-invisible, and nobody had noticed.** The issue describes
`entityType: 'ticket'` at `audit-trail.service.ts:50` as merely *narrow*. It is worse than narrow: the
writers never agreed on a spelling. `src/` contains `entityType: 'ticket'` (16 sites),
`entityType: 'tickets'` (15) and `entityType: 'TICKET'` (1) — all meaning the same thing, all keyed to
the same `ticketId`. So the existing per-ticket trail was silently dropping roughly **half** of every
ticket's audited actions, and had been since Issue 03. AC4 could not have been met by adding a tab
over the read as it stood.

Both readers now normalise (`TICKET_ENTITY_TYPES`, `lower(entity_type) IN (…)`) rather than picking a
winner. Rewriting 32 call sites would be the tidier fix and is a separate, riskier change to an
append-only compliance table's *history*: normalising the read fixes every row already written, which
rewriting the writers does not. Filed below as a follow-up.

**2. `apps/admin/src/lib/nav.ts` does not exist.** The nav lives at
`apps/admin/src/components/shell/nav.ts`; that is the file edited.

**3. The `(actor_id, created_at)` index the issue asks about does not exist** — see *Schema* below.
Neither does anything on `created_at`, which matters more.

## Decisions worth keeping

**1. A row's zone is derived, in three steps, and that is the whole reason AC2 is not trivial.**
`audit_logs.acting_zone` is written **only when the actor was acting** (`auditActor()` copies
`RequestActor.actingZone`, which `ActingContextGuard` sets only for a proxying CSM/OH). So the obvious
clamp — `WHERE acting_zone = :zone` — would have shown a ZM *every row except their own*: a ledger
whose only content is other people borrowing their authority. The clamp resolves a zone instead:

1. `acting_zone` — the zone whose authority was borrowed. Explicit, so it wins.
2. for a ticket row, the zone of the ticket's plant — where the thing acted on lives. This is what
   makes a pan-India CSM's action on a zone-1 ticket visible to zone 1's ZM, which is precisely the
   row a ZM is most often asked to account for.
3. the actor's own `users.zone_id` — a zoned actor acting in their own scope.

A row resolving to no zone is a genuinely pan-India action (an Operations Head changing a global
setting). It stays invisible to a ZM: that is the correct reading of "own zone only", not an omission.
The e2e fixture carries one row of each of the three kinds *inside* the zone and one of each
*outside*, so a clamp that implemented only step 1 fails, and so does one that implemented only step 3.

**2. The clamp is `@CurrentScope()`, so acting narrows the ledger for free.** `resolveManagerScope`
collapses a CSM acting in zone 3 to `{ role: 'ZONAL_MANAGER', zoneId: 3 }`, and the ledger reads that
exactly as it reads a real ZM. There is no acting branch in this slice's code, which is the point of
#339–#341 having landed first.

The caller's own `zoneId` filter is a **separate** predicate from the clamp rather than a default for
it. A ZM who somehow sends `zoneId=2` gets an empty page, not a widened one.

**3. One SQL statement, not a Prisma `findMany`.** Step 2 of the zone resolution is a join, and the
zone predicate has to be applied *before* the `LIMIT` or the keyset is broken — filtering a page after
fetching it silently returns short pages and eventually skips rows. The statement uses
`CROSS JOIN LATERAL` to name the resolved zone once so `WHERE` and `SELECT` cannot disagree about it.

Two details that are load-bearing rather than stylistic:

- `LEFT JOIN users u ON u.user_id::text = a.actor_id`, **not** `a.actor_id::uuid`. `actor_id` is a
  `text` column and six writers put `'SYSTEM'` or `'CUSTOMER'` in it; casting the column would throw
  on those rows rather than returning them with a null actor name.
- the ticket-zone lookup is a **nested** `CASE` (`entity_type` is a ticket type → `entity_id` looks
  like a UUID → subquery). Postgres does not guarantee `AND` short-circuits, but it does guarantee
  `CASE` branch order, so the `::uuid` cast never runs on a non-ticket row.

**4. The cursor is the previous page's `audit_logs.id`, and the keyset compares row values.**
`(a.created_at, a.id) < ((SELECT created_at FROM audit_logs WHERE id = :cursor), :cursor)`. The
alternative — encoding the timestamp in the cursor — round-trips a `timestamptz(6)` through
millisecond-precision JSON, which loses microseconds and can drop or repeat a row when several land in
the same millisecond. One primary-key lookup is cheaper than that class of bug.

**5. The metadata from/to reading lives in the admin client, once.** `metadata` is free-form JSONB and
the writers already use four shapes for "this changed": `{ previous, next }`, `{ previousHours,
newHours }`, `{ dealType, previous }`, `{ from, to }`. The backend returns the blob verbatim; the
page and the drawer share `metadataChanges()` / `metadataReason()` / `metadataDetail()` so they cannot
disagree about what a row says. A blob with no transition in it degrades to visible key/value detail
rather than to an empty cell — otherwise the tab would silently drop most of its rows, which is the
same failure mode this whole slice exists to end.

**6. The page is in Analytics, for every manager — not in Admin.** The Admin nav group is
Operations-Head-only, and the ZM is the role most often *asked* to explain an action taken in their
zone. The route's `RoleRoute` and the endpoint's `@Roles` are the three manager roles; the server
clamps the ZM. The zone **filter** is offered only to the two pan-India roles, so the screen never
shows a control the server would ignore; the zone **column** renders for everyone, because for a ZM it
is the standing proof of the clamp.

## Schema — what is needed, and whether it matters

`prisma/schema.prisma` was read only; **another agent owns it this round, so no index was added and no
migration was written.** `audit_logs` (schema.prisma:1727) has:

- `PRIMARY KEY (id)`
- `@@index([entityType, entityId])`
- `@@index([actedAsRole, actingZone, createdAt])`

What the query shapes in this slice actually want:

| Wanted | Serves | Exists |
| --- | --- | --- |
| `(created_at DESC, id DESC)` | the default page and the sort under **every** filter | **no** |
| `(actor_id, created_at)` | the actor pivot (row click) — the index the issue asked about | **no** |
| `(action, created_at)` | the action filter | no |
| `(lower(entity_type), entity_id)` | the entity filter as this slice writes it | no |

**Does it matter today?** Not for correctness, and not yet for latency: `audit_logs` is small in
dev/test and every query here is `LIMIT ≤ 200`. It will matter — the table is append-only and takes a
row per audited write, so it only grows, and the missing `created_at` index means the default ledger
page is a full scan plus a sort. The one to add first is `(created_at DESC, id DESC)`, not the
`(actor_id, created_at)` the issue named: the sort is on every query, the actor filter on some.

Note also that `lower(entity_type)` makes the *existing* `(entity_type, entity_id)` index unusable for
the entity filter. That is a deliberate trade — see premise correction 1; an expression index restores
it without reintroducing the dropped-rows bug.

**The Prisma drift gate was not run** (this box cannot `CREATE DATABASE`), but this slice changes no
schema, so there is nothing for it to check.

## Acceptance criteria

- **AC1 — filters are honoured.** `action`, `actorUserId`, `actedAsRole`, `entityType`, `entityId`,
  `zoneId`, `from`, `to`. The e2e compares row-**id sets** per filter, not counts, and asserts two
  different filters do not produce byte-identical bodies. The admin test asserts that applying a
  filter **re-queries the server** rather than filtering the page already loaded.
- **AC2 — ZM sees own zone only.** Backend e2e over all three zone-resolution steps, in and out of
  zone. The page adds no clamp of its own and sends no `zoneId` for a ZM.
- **AC3 — `metadata` rendered as from/to where present.** Backend returns it verbatim; seven unit
  cases over the four shapes actually in `src/`, rendered by both surfaces.
- **AC4 — drawer Audit tab shows the action chain, including acting role.** Actions only (the state
  chain stays on Lifecycle), lazy-loaded, with actor, `acted_as_role` + acting zone, from/to and
  reason. Includes the `'tickets'`/`'TICKET'` rows the read used to drop.
- **AC5 — keyset pagination, `limit ≤ 200`.** e2e walks two pages with no repeat and no gap;
  `limit=201`, `limit=0`, a malformed cursor and a malformed date are each 400.

## Tests

Backend, through `.scratch/locks/backend-test.sh`:

```
 ✓ test/audit-ledger-search.e2e-spec.ts (8 tests) 4800ms
 ✓ test/audit-trail-controller.e2e-spec.ts (6 tests) 5564ms

 Test Files  2 passed (2)
      Tests  14 passed (14)
```

Admin:

```
 ✓ test/audit-metadata.test.ts (7 tests) 13ms
 ✓ test/ticket-drawer-audit-tab.test.tsx (4 tests) 662ms
 ✓ test/audit-trail-page.test.tsx (7 tests) 1624ms

 Test Files  3 passed (3)
      Tests  18 passed (18)
```

Regression: `routing`, `sidebar-shell`, `help-center`, `dispatch-timeline-nav`, `build-health-page`,
`bulk-unassign-page`, `assignment-threshold`, `dispatch-runs`, `recovery-drawer-close`,
`special-ticket-surface`, `ticket-components-tab`, `ticket-drawer-tabs` — 61 passed.

## Follow-ups this slice does not own

1. **Normalise the `entity_type` spellings at the writers** (`'tickets'` / `'TICKET'` → `'ticket'`),
   and then narrow the readers back to one value. 32 call sites; needs a backfill decision for the
   rows already written, which is why it is not folded in here.
2. **The indexes in the table above**, once `schema.prisma` is free. `(created_at DESC, id DESC)`
   first.
3. **`docs/ui/desktop/approved-designs/README.md`** — record the Audit Trail ledger as an
   approved-design gap (no v2 image exists; this page follows the Ops Explorer table chrome). Not
   edited here: another agent may be appending to the same README this round.
4. **A pre-existing crash in the drawer's Assignment History tab.** `attempts.attempts.length`
   (`TicketDetailDrawer.tsx:537`, from #244) throws when `/tickets/:id/attempts` returns a shape
   without `attempts`. It surfaces today as an unhandled error in `ticket-drawer-tabs.test.tsx` — the
   test still passes. Present at HEAD, untouched by this slice.
