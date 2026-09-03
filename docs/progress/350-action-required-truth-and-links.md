# 350 — Action Required tells the truth and goes somewhere

**Done 2026-09-03.** Wave 2 of the module-gaps completion plan
(`docs/module-gaps/IMPLEMENTATION-PLAN.md` §4), absorbing survey ids **DASH-G02, G03, G05, G08**.
Red-first. No upstream dependency.

## What it closes

The Action Required panel is the manager dashboard's front door, and most of it was painted shut.

- **Five of the nine cards had never been counted.** `dashboard.service.ts` wired four
  (`waiting_component_overdue`, `recovery_stalled`, `vehicle_unavailability`, `failed_verification`)
  and returned `{count: 0, available: false}` for the rest, which the panel painted as *"coming soon"*.
  That is more than half a manager's front door reporting a build state as an operational fact.
- **No card went anywhere.** The four live counts were inert `<li>`s — a number with no way to act on
  it — while `pages/dispatch/console/AttentionBand.tsx` had held the destination map for exactly these
  card keys since Console Phase 3.2.
- **Only the ZM had the panel at all.** `CentralDashboard` and `OpsHeadDashboard` rendered none, so the
  two roles that cover every zone could not see what any zone was waiting on. Worse, the CSM's KPI strip
  already totals these cards into `"{n} action items"` — the page named a number it then refused to
  itemise.
- **`ManagerDashboard` still fetched `apiZoneEngineers()`** on every load and again on every acting-mode
  change, for the Critical Queue assign picker that #277 deleted.

**The issue's premise held in full** — verified against the working tree before building. `dashboard.service.ts`
had exactly four keys in its `wired` map; `ActionRequiredPanel.tsx` had the `coming soon` branch and no
`onClick`/`Link`; `AttentionBand.tsx:30-38` held the map; neither CSM nor OH imported the panel; the
`apiZoneEngineers()` call and its `engineers` state were still there with no consumer. Two things the
issue could not have known are recorded under *Decisions* below: the `manual_assignment_required`
definition already existed in the codebase, and `OPEN` is a TROUBLESHOOT-only status.

## The renamed card

`critical_insertions_awaiting_accept` → **`critical_escalations_pending`**.

CONTEXT §21 retired SE Acceptance (#268/#279). There is no acceptance step, so nothing could ever be
"awaiting accept": the key named a workflow the system does not have. That is worse than a missing
card — a missing card is a gap, a card named after a non-existent step *teaches* an operator a
procedure, and the first thing they will do is go looking for the accept screen. The label had already
been corrected twice (2026-08-28 field-ops P0-3) precisely because it kept implying a step somebody
could be late on; the key had not, and the key is what both readers dispatch on.

The key is wire contract, so it was changed with both readers in the same commit: the destination map
(now shared) and the dashboard panel. Grep confirms no third reader. The e2e asserts the old key is
gone, not merely that the new one is present.

## Decisions worth keeping

**1. `manual_assignment_required` reuses `assignableTickets()` rather than re-spelling it.** The plan
defined the card as "OPEN + UNASSIGNED tickets past the dispatch window today". Those first two clauses
are already `ticketing/assignable-work.ts` — the one definition of *"a ticket a manual assign will
actually move"* (#272 R3), which `/assign` both counts and commits through, and which carries a third
clause (`not held to a future date`) the plan's wording omits. The card's destination **is** `/assign`,
so a second spelling here would put a number on the dashboard that the button it links to cannot move —
the exact fork R3 exists to close. Using the shared predicate also inherits the deferral clause for
free, which is the correct behaviour: a ticket a ZM deliberately pushed to Thursday is not manual work
outstanding today.

**2. "Past the dispatch window" is the day's last dispatch *run*, not a clock time.** The dispatch cron
is operator-editable (`dispatch-schedule.service.ts`), so a hardcoded hour goes wrong the first time
someone changes it. The run ledger records what happened rather than what was configured, which is the
question the card asks: *did the engine already have its turn at this ticket and leave it?*

**No run today ⇒ the card is 0.** Before the engine has run, nothing is required of a manager, and
counting the whole open backlog at 06:00 would demand by hand the work the system is about to do by
itself — a card that is loudest exactly when it should be silent.

**3. `unreviewed_batches` counts what auto-dispatch did today, because "reviewed" does not exist.** The
card was specified against the batch-review gate Decisions §7 removed. There is no review step and
therefore no viewed-flag to filter on. Rather than invent one to keep a dead word alive, the count is
the closest true statement — batches the engine placed into this zone today, still exactly as it placed
them (`status = 'AUTO_ASSIGNED'`). That preserves the surviving half of the original intent: a batch a
manager has already overridden is one they demonstrably looked at, and a `COMPLETED` one is finished
work. Neither is still asking for attention. Zone comes off the **schedule**, not the plant — the
schedule's zone is the zone the batch was dispatched into, and a cross-zone batch's plant names the
home zone, which is not what this card is about.

**4. `non_op_awaiting_manager` excludes `AWAITING_CUSTOMER_CONFIRMATION` deliberately.** It is the
queue's other open state, and a card labelled "awaiting manager confirmation" that counted it would tell
a manager to act on rows they cannot advance. The dual confirmation has two halves; this card is one of
them.

**5. `component_blocked` does not filter `wmActionStatus`.** A row the Warehouse Manager has actioned
but not resolved is still a blocked ticket the manager is waiting on. `resolvedAt IS NULL` is the
queue page's own open predicate, so the card and the page it links to count the same set.

**6. `available` survives on the wire even though every card is now `true`.** *"We do not count this
yet"* and *"there is no work"* are opposite statements, and only the boolean distinguishes them. The
day a tenth card is added ahead of its source, the distinction has to already exist — this is the
second time the flag has been the thing that stopped a build state from being read as an operational
one. The panel's stub branch survives with it, saying **"not counted yet"** rather than "coming soon",
which read as a product promise rather than the measurement gap it was. AC4 is met on the literal text
and on the fact that nothing renders that branch today.

**7. The destination map moved to `lib/`, it was not copied.** Two copies would have drifted the first
time a route moved, and the dashboard and the Console would then disagree about where a manager goes to
do the same job. `AttentionBand.tsx`'s behaviour is unchanged — the local `CARD_DESTINATION` name is
kept and now aliases the shared map, so the "no queue page yet" branch still works exactly as before.
It gained the two entries that had no destination (`unreviewed_batches`, `manual_assignment_required`),
which the Console could not have shown anyway while both cards were `available: false`.

**8. Filters ride in the path where the page reads one, and nowhere else.** All nine destinations are
already filtered surfaces (`/component-blocked` lists open blocks and nothing else; `/verification` is
the review queue; `/readiness/non-operational` is the dual-confirmation queue). `recovery_stalled`
lands on the *unfiltered* ticket list on purpose, as it has since Phase 3.2: the Ticket List's filters
are component state, not URL state, so a query string there would be read by nobody. Adding a
decorative `?status=` would imply a control that does not exist. **#351 owns the `/assign` URL preset**
(`useAssignDraft.ts:163`) and `TicketsPage`; when those land, only the map changes.

**9. The v2 reference does not draw this panel — on any of the three dashboards.** `01`, `03` and `04`
were read before building. None of them contains an Action Required grid; the panel is an Issue-06/FE-06
element the v2 rework never redrew. So AC3 was built by **matching the existing ZM placement exactly**
(after the activity trend, above SLA Bucket Distribution) rather than by inventing a v2-styled variant.
A CSM who moves between the two pages by acting as ZM sees the same block in the same place, which is
the property that matters and the one a redesign would have broken.

**10. Every destination is ZM/CSM/OH-gated.** Checked against `AppRoutes.tsx` before mounting the panel
for two new roles: no card on the CSM or OH dashboard opens a door that role cannot walk through.

**11. Pan-India for CSM/OH, as AC3 asks.** The task note said "zone-filtered"; the issue's AC3 says
"pan-India", and the endpoint answers unscoped for a CSM/OH unless a zone is named (B5). Pan-India is
what shipped — it matches AC3, matches the CSM KPI strip that already totals these cards nationally,
and matches the Escalation Queue and Scorecard directly beneath it. `?zoneId=` remains available and is
what the Scheduler Console passes.

## What was tested, and why in that shape

**Deltas, not absolute counts.** These specs run against the shared `fsm_test` fixture database, whose
row counts move with every other spec on the box. A card is proved wired by seeding exactly one row of
its source and showing that card moved by exactly one; an absolute assertion would be either a
tautology (`count >= 0` — which the *old* stubbed endpoint also satisfied) or a flake.

**The dispatch run is seeded before the baseline is taken.** `manual_assignment_required` is the one
card whose count depends on a row that is not its own: seeding the run and the ticket together would
have moved the card by however many fixture tickets the new window caught, and the "exactly one"
assertion would have failed for a reason that was not a defect.

**Zone scoping is asserted from both ends.** Five rows in the ZM's zone and five one zone over: the
ZM's totals move by five, the CSM's by nine (the four zone-scoped sources twice, plus the one batch,
which only exists in the ZM's zone). A "one zone ≤ every zone" check alone — which is what the previous
spec had — is satisfied by an endpoint that ignores the zone entirely when the fixtures happen to be
one-sided. The narrowed CSM read additionally asserts `critical_escalations_pending = 1` and
`unreviewed_batches = 0` for the seeded foreign zone: exclusion proved, not merely "not more".

**The four pre-existing cards are asserted to have *not* moved.** Five new counting paths over the same
tables is exactly where a stray join lands in someone else's card.

**The admin test pins the link target *and* its accessible name.** A card whose whole surface is a link
announcing only "0" is worse than no link; the name is `"{label} — {verb}"`, so the destination arrives
with its subject.

## Acceptance criteria

- **AC1** — met. All nine cards return real, zone-scoped counts.
  `test/dashboard-action-required.e2e-spec.ts`: five per-card delta cases, four no-move cases for the
  pre-existing cards, and the ZM-vs-CSM scoping case.
- **AC2** — met. Every card is a `Link` resolved through `lib/actionRequiredDestinations.ts`;
  `dashboard-critical-action.test.tsx` asserts the `href` and accessible name per card, and that all
  nine keys have an entry.
- **AC3** — met. `CentralDashboard` and `OpsHeadDashboard` mount the panel pan-India, in the ZM's
  placement; asserted by rendering both bodies.
- **AC4** — met. No "coming soon" remains in the panel (the stub branch reads "not counted yet" and
  nothing renders it, since all nine sources are wired).
- **AC5** — met. `apiZoneEngineers()` and its `engineers` state are gone from `ManagerDashboard.tsx`.

## Tests, verbatim

`apps/backend/test/dashboard-action-required.e2e-spec.ts` — **13 tests, all passing**
(1 contract + 5 per-card deltas + 4 no-move + 1 scoping + 1 narrowing + 1 RBAC).
Verified **red first**: against the pre-change service the suite failed on the very first assertion
(`keys` still carried `critical_insertions_awaiting_accept` and five cards were `available: false`).

`apps/admin/test/dashboard-critical-action.test.tsx` — **7 tests, all passing**
(ordering + counts, no "coming soon", per-card link target/name, stub-vs-zero, CSM mount, OH mount,
destination-map coverage). Red first: 4 of 7 failed before the implementation.

Neighbouring backend specs that call `actionRequired` directly re-run green:
`recovery-compliance-stalled.e2e-spec.ts`, `waiting-component-escalation.e2e-spec.ts`,
`dashboard-acting-scope.e2e-spec.ts`.

`npx tsc --noEmit` (backend) → no `dashboard/` diagnostics. `npx tsc -b` (admin) → exit 0.

No migration: every count reads tables that already exist, so the Prisma drift gate was not needed.

## Follow-ups this slice does not own

- **`DashboardData.engineers` is now a field nobody produces and nobody destructures.** It is declared
  in `ZmDashboard.tsx`, which **#351** owns; `ManagerDashboard` passes `[]` so the dead *request* is
  gone (AC5), and the type field should be deleted with #351's edits to that file.
- **`/assign?filter=critical-plus`** — #351 owns the `useAssignDraft.ts` URL preset. When it lands,
  `manual_assignment_required`'s destination can carry the filter; only
  `lib/actionRequiredDestinations.ts` changes.
- **The Ticket List reads no URL filters**, so `recovery_stalled` lands unfiltered. Giving
  `TicketsPage` URL-driven filter state would let that card (and several drill-downs elsewhere) point
  at the rows they mean. Not filed — `TicketsPage` is outside this slice's file set.
- **`docs/codebase-complete-analysis.md:1770`** still lists the five cards as `available: false` stubs.
  It is an analysis snapshot, not a living doc; SYSTEM-STATE is the one the orchestrator updates.
