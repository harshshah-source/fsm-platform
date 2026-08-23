# 268 — CRITICAL direct assignment: retire acceptance from the critical path, wire the automatic trigger

**Status:** DONE · 2026-08-24 · branch `feat/autoplant-integration`
**Issue:** `.scratch/fsm-platform-v1/issues/268-critical-direct-assignment.md` · **Decision:** #258
Q3 (no PENDING_ACCEPTANCE / no 10-min window / no accept-decline / no acceptance-driven retry for
CRITICAL) + Q2 (system path respects capacity; manual overload remains a manager right)
**Companion issue:** [#279](../../.scratch/fsm-platform-v1/issues/279-retire-intraday-offer-accept-mobile.md)
(mobile retirement, filed per #268's own instruction)
**Suite at completion:** backend 4/4 chunks green (documented per-chunk below); admin 104 files /
547 tests (the one reported error is the pre-existing, unrelated `TicketDetailDrawer.tsx:440` fault);
mobile 48 files / 331 tests, all green.

---

## 1. What changed, in one paragraph

A CRITICAL/HIGH_CRITICAL ticket used to become a `PENDING_ACCEPTANCE` offer to one SE, with a 10-minute
window, a 3-retry reroute chain, and no automatic trigger ever firing it (`fireForZone` had exactly one
non-test caller: a manual controller route). It is now assigned **directly** — same hard-eligibility →
coverage-tier → score discipline the morning batch uses, landed at stop 1 of the chosen SE's Day Plan,
with no offer step for anything to time out. A ticket with no capacity-eligible candidate escalates to
the Zonal Manager on the first evaluation, not after three exhausted offers. The 2-minute sweep that
used to expire offers now drives the direct-assign itself, renamed `business-critical-assign`.

## 2. What was built

| Piece | File |
|---|---|
| Shared tier+score chooser, extracted from the morning batch | `src/recommender/tier-score-chooser.ts` |
| Shared weight/cluster/capacity reads (base weights, cluster multiplier, engineer capacity) | `src/recommender/scoring-config.ts` |
| `urgencyFromBucket` moved out of `RecommenderService` (was a private duplicate of `canonical-sort.ts`'s own severity order) | `src/recommender/canonical-sort.ts` |
| The direct-assign engine (`assignCriticalForZone`, `assignCriticalForActiveZones`) | `src/intraday/intraday-insertion.service.ts` (full rewrite) |
| Migration: `ASSIGNED_DIRECT` enum value; `offered_se_id`/`acceptance_deadline` made nullable | `prisma/migrations/20260824120000_critical_direct_assign/` |
| Scheduler rename `business-intraday-timeout` → `business-critical-assign` | `src/scheduling/business-sweep-scheduler.service.ts` |
| `manual_assignments` cube excludes SYSTEM-actor `CRITICAL_ASSIGN` rows | `src/reports/system-efficiency-aggregation.service.ts` |
| Admin Intra-day Queue now reads `intraday_insertions` (closes a pre-existing #197-flagged gap) | `apps/admin/src/api/intradayInsertions.ts`, `IntradayQueuePage.tsx` |
| Mobile offer screen, ghost toast, and their endpoints retired | see #279 |

Retired outright: `accept`, `decline`, `sweepTimeouts`, `reroute`, `offer`, `pushOffer`,
`notifyGhostAssignment`, `getMyPendingOffers`, `MeIntradayInsertionsController`, the mobile
`IntradayOfferScreen` + client functions + `@fsm/shared` offer types.

## 3. Decisions worth keeping

**The tier+score chooser is one function now, not two implementations that happen to agree.**
`chooseWithinTier` (`recommender/tier-score-chooser.ts`) is steps 1–3 of the morning batch's per-ticket
selection — winning tier, within-tier score, pin-or-top-score — lifted out verbatim and imported by
both `RecommenderService` and `IntradayInsertionService`. This is the same move #274 made for hard-filter
eligibility (`buildCandidateReadiness`) and #269 made for capacity (`committedDayLoad`): the second
caller is what proves an extraction is needed, and "reused not re-implemented" was the issue's own
explicit instruction. The full recommender regression suite (17 files / 58 tests) stayed green
throughout the refactor — the extraction is behavior-preserving by construction, not by re-testing.

**Intraday scoring deliberately never uses PREVENTIVE-mode weights.** `scoring-config.ts`'s
`readBaseActiveWeights` is the base/DEFICIT read only; `RecommenderService.activeWeights` layers its
own PREVENTIVE branch on top for the morning batch, but the intraday direct-assign never does.
PREVENTIVE's repeat-failure-bonus / aged-device bias exists to redirect attention toward backlog when
a zone is *healthy* — applying that logic to an active CRITICAL emergency would be a live contradiction.
This is a scope decision the issue's own text does not make explicitly; recorded here and in the code
rather than silently inherited.

**No SE Planner pin on the intraday path.** `chooseWithinTier`'s `pinnedSeIds` is optional precisely so
a caller with no planner concept of its own can omit it. None of #268's eight ACs mention the ADR-0022
soft bias, so CRITICAL selection stays pure tier+score — no new rule invented beyond what was asked.

**Race safety against a concurrent write comes from `assignTicket` itself, not a new guard.** The
direct-assign loop calls `assignTicket` exactly the way `manualAssign` always has; a concurrent writer
(a ZM's manual assign, a second sweep instance) makes it return non-`OK`, which the loop treats as "skip
silently, nothing to undo" — no insertion row, no counter increment, no retry. AC-4's negative assertion
("capacity map exhausted → zero new `batch_assignment_tickets` rows") holds because the capacity check
happens entirely in `applyHardFilters` *before* `assignTicket` is ever called for an over-capacity SE —
there is no code path that reaches the write with a bad candidate to reach it with.

**In-tick counters are read-modify-write across the whole sweep, not per ticket.** `committedCount` and
`plantsBySe` seed from `committedDayPlan` once, then get incremented after every successful assignment
within the same `assignCriticalForZone` call — the same pattern the morning batch's `assigned` map uses.
This is what makes AC-7 (N criticals spread by capacity/score, not stacking on one SE) true: a second
CRITICAL ticket in the same tick sees the first ticket's assignment before it is scored.

## 4. Two corrections to the issue text (found while implementing)

1. **`offered_se_id` and `acceptance_deadline` could not stay `NOT NULL`.** Q-B's escalation ("no
   capacity-eligible SE exists") can now fire on a ticket that was **never offered to anyone** — there
   is no SE to name and no acceptance window to bound. The issue's Data Model section said only "gains
   `ASSIGNED_DIRECT`" and did not anticipate this. Both columns were made nullable in the same migration
   (a small, additive, safe change — no data loss, no behavior change for existing rows) rather than
   inventing a sentinel value, which would be a fabricated fact in an audit-adjacent table. Documented
   in the migration's own comment and in the schema.

2. **`manual_assignments` would have silently absorbed every automatic direct-assign.** Before #268,
   every `CRITICAL_ASSIGN` audit row was a human action (an SE's Accept, or a ZM's manual assign), so
   `system-efficiency-aggregation.service.ts` counting the whole `CRITICAL_ASSIGN` set as "manual" was
   correct by construction. #268 adds a third writer with a SYSTEM actor — the issue's own instruction
   to reuse the `CRITICAL_ASSIGN` audit vocabulary, not a mistake — and left uncorrected this would
   silently relabel every automatic assignment as manual, the same class of metric corruption the
   issue's own `auto_escalations` continuity AC exists to prevent for the sibling figure. Fixed with a
   one-line `actor_role != 'SYSTEM'` exclusion; regression-pinned in `system-efficiency-report.e2e-spec.ts`.

## 5. What was found and NOT changed (flagged, not silently expanded)

- **`SE_ACCEPTANCE` as a `NotificationDeliveryModel`** is now unreferenced by any caller (confirmed by
  grep) but left in `notification.service.ts` — it is generic notification-spine machinery, and
  removing it touches the spine's own tests and type for a cleanliness gain outside this issue's scope.
  Recorded as a candidate follow-up in #279.
- **The admin Intraday Queue page never actually read `intraday_insertions`** before this issue — a
  pre-existing gap the #197 audit had already flagged and left unfollowed-up ("FE-13 deferred it and
  filed no follow-up"). #268 closes it (not deferred a second time — per CLAUDE.md's parity gate, a
  previously-dropped internal wiring gap is not an external-integration blocker) by adding
  `apiIntradayInsertions()` and merging both row kinds into one table, newest-first.
- **#201 (open)** — the future mobile push signal for "new CRITICAL work landed" — is explicitly not
  built here. The assigned ticket surfaces through the existing #66 `addedIds` diff mechanism; the
  mobile `TicketsScreen` badge now derives "CRITICAL INSERTION" vs "Newly Added" from the ticket's own
  `slaBucket` (matching backend's `TRIGGER_BUCKETS`) instead of from a flag `SeTabShell` no longer has
  a source for.

## 6. Tests

| File | What it pins |
|---|---|
| `test/tier-score-chooser.spec.ts` (8, new) | The extracted chooser in isolation: tier precedence beats score, within-tier score selection, deterministic tie-break, pin crosses tiers, pin ignored if absent from the pool, `scoreFor` called only for the winning tier |
| `test/intraday-critical-insertion.e2e-spec.ts` (10, rewritten) | **AC-1** one-tick assignment, no acceptance state, stop 1 · **AC-2** tier precedence + skips unavailable/at-capacity · **AC-3 (Q-B)** escalation + ZM alert + queue visibility + manual override exceeds capacity freely · **AC-4** negative capacity assert · **AC-6** deferred ticket never system-assigned · **AC-7** N criticals spread by capacity · no re-escalation on the next tick · HIGH_CRITICAL parity · SYSTEM-actor audit stamp |
| `test/business-sweep-scheduler-intraday.e2e-spec.ts` (2, rewritten) | The renamed `criticalAssignTick` fires the sweep; DISABLED dormancy |
| `test/intraday-insertions-controller.e2e-spec.ts` (9, rewritten) | RBAC on the surviving routes; **retired endpoints 404** (`accept`, `decline`, `sweep-timeouts`, `/me/intraday-insertions`) |
| `test/system-efficiency-report.e2e-spec.ts` (+1) | SYSTEM-actor `CRITICAL_ASSIGN` excluded from `manual_assignments` |
| `test/scheduler-wiring.e2e-spec.ts`, `business-sweep-scheduler-wiring.e2e-spec.ts` | Job rename, still 19 jobs |
| `test/recommender-waiting-component.e2e-spec.ts`, `lost-race-hygiene.e2e-spec.ts`, `deferral-override-confirm.e2e-spec.ts` (adapted) | Regression on the callers that used the old API |
| Admin `test/intraday-queue.test.tsx` (+2) | Insertion rows render alongside ZM manual updates; ZM rows still say "no acceptance required" |
| Mobile `SeTabShell.test.tsx` (rewritten, 2), `TicketsScreen.test.tsx` (adapted) | No offer gate, no ghost toast; CRITICAL INSERTION badge derived from `slaBucket` |

Deleted: `test/intraday-accept-timeout-race.e2e-spec.ts`, `test/me-intraday-insertions-controller.e2e-spec.ts`,
mobile `IntradayOfferScreen.test.tsx`.

**Backend full suite:** chunk 1 103/575 green; chunk 2 (99+3 skipped)/103 files, 512+3+3=518/522 tests
green — the one worker crash on `test/global-guard-validation.e2e-spec.ts` is the documented,
pre-existing #184 Windows-native fault (confirmed unrelated: 8/8 green in isolation); chunk 3 103/500
green; chunk 4 100/462 green.

## 7. Files

**New:** `recommender/tier-score-chooser.ts`, `recommender/scoring-config.ts`,
`prisma/migrations/20260824120000_critical_direct_assign/`, `test/tier-score-chooser.spec.ts`,
`apps/admin/src/api/intradayInsertions.ts`, `.scratch/fsm-platform-v1/issues/279-*.md`.

**Rewritten:** `src/intraday/intraday-insertion.service.ts`, `.controller.ts`, `.module.ts`;
`test/intraday-critical-insertion.e2e-spec.ts`, `business-sweep-scheduler-intraday.e2e-spec.ts`,
`intraday-insertions-controller.e2e-spec.ts`; `apps/admin/src/pages/schedules/IntradayQueuePage.tsx`;
mobile `SeTabShell.tsx`.

**Modified:** `recommender.service.ts`, `canonical-sort.ts`, `business-sweep-scheduler.service.ts`,
`system-efficiency-aggregation.service.ts`, `prisma/schema.prisma`, several dependent test files,
mobile `TicketsScreen.tsx`, `client.ts`, `packages/shared/src/index.ts` (rebuilt).

**Deleted:** `me-intraday-insertions.controller.ts`, mobile `intraday/` directory,
`test/intraday-accept-timeout-race.e2e-spec.ts`, `test/me-intraday-insertions-controller.e2e-spec.ts`.

**Docs:** `CONTEXT.md` — Decision §16 marked superseded (kept verbatim as historical record), new
Decision §21, and ten glossary/prose corrections (SE Acceptance, Acceptance Timeout, WhatsApp
Confirmation, Notification Delivery, Intra-day Re-plan, SE Activity Ping ×2, Formal Assignment, "SE
cannot reject", the worked-example dialogue, Decision §7's prose) so the domain doc does not
contradict live behavior. `docs/SYSTEM-STATE-2026-07.md` §3h/§3g/§2.4 updated. `#169` gained a dated
comment recording the four route removals per its own process.

**Rollback:** revert the intraday service/controller/module and the scheduler rename; the migration's
two changes are additive (new enum value, relaxed NOT NULL) and need not be reverted — old code paths
that assumed `offered_se_id` non-null would need the columns back to NOT NULL, which is the one
non-trivial part of a rollback.
