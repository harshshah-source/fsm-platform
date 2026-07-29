# 179 — OH bulk unassign (zone / Pan-India) — mid-day rebalance

Status: ready-for-agent
Type: AFK · Backend + Admin

Filed 2026-07-29 (operator ask; design investigation ran 2026-07-29, all decisions settled below —
**do not reopen them**). The control: an Operations Head unassigns every in-scope assignment for a
zone (or Pan-India), then re-runs dispatch so tickets land freshly on engineers. **Mid-day
rebalance, not evacuation**: nobody is pulled off work permanently — they get a new plan. Pressed
rarely; correctness and legibility over throughput.

**Semantics (settled, do not widen): unassign only.** Tickets stay OPEN, leave SEs' day plans,
return to UNASSIGNED, and the next dispatch run re-places them. Nothing cancelled, closed, or
deleted. An SE landing at a completely different plant than this morning is the expected outcome —
no continuity-of-location logic, no warnings about it.

**Not** `scripts/reset-reseed-ses.cjs` exposed over HTTP — that is a dev-fixture rebuild that
deletes history (`deleteMany` on traces/recs/schedules, `:167-173`) and the SE workforce
(`:180-182`). The canonical precedent is `OverrideService.removeTicket`
(`override.service.ts:125-159`) fanned out over a scope: stamp, don't delete.

## Proven before filing (demonstration e2e, 2026-07-29, isolated `fsm_test`, spec deleted after run)

Morning dispatch of 6 tickets → the exact proposed unassign (stamp `removed_at`/`removed_by`, flip
tickets UNASSIGNED, stamp `lastOverriddenBy/At`, schedule status untouched) → mid-day re-dispatch
through the real `RecommenderService.runForZone` + `BatchAssignmentService.dispatchForZone`:

- **APPEND-onto-empty works**: the re-run reused the same schedule via `liveScheduleFilter()`
  (`batch-assignment.service.ts:126-130`) — no P2002, no second (se, zone, day) plan, schedule
  stayed ACTIVE throughout.
- **Capacity fully freed**: capacity 10 / 6 tickets — a stale `committedDayLoad` would cap the
  re-run at 4; it recommended **6**, because the load read counts `removedAt: null` only
  (`recommender.service.ts:600-607`).
- **Every ticket re-assigned exactly once** (6/6 FORMALLY_ASSIGNED, one live batch row each).
- **Stop numbering continues** after the emptied stops (fresh work landed at stop 2 above a hollow
  stop 1) — `lastStop._max.stopSequence` aggregates all batches (`batch-assignment.service.ts:152-156`).

## Scope predicate — every clause is load-bearing

`workType = 'TROUBLESHOOT' AND status = 'OPEN' AND assignment_state = 'FORMALLY_ASSIGNED'`,
reached from live batch rows (`removed_at IS NULL`) on live schedules
(`liveScheduleFilter()`, never a hand-spelled `status: 'ACTIVE'` — the #153 lesson),
**with no date predicate** (**D1 REVERSED 2026-07-29 — all live schedules, see below**).

> **D1 REVERSED 2026-07-29 (operator).** Originally scoped `date_from = today`, deferring the
> stale-plan backlog to #147. Reversed after live testing: a Pan-India run cleared today's 853 rows
> correctly, but **6,297 rows on older ACTIVE schedules** (2026-07-21/22/23/28) still read as
> "assigned" on the batch-detail and SE surfaces with a named engineer against them — which is what
> the control exists to clear. The sweep now covers **every live schedule regardless of date**.
> `liveScheduleFilter()` is still the boundary: `COMPLETED`/`PARTIAL` stay out, so widening cannot
> resurrect finished work.
>
> **Measured consequence, accepted:** the in-scope set is **5,946 tickets** against a fleet daily
> capacity of **1,875** (75 active SEs × 25). One re-dispatch therefore cannot re-place them all —
> roughly **4,000 tickets land in the unassigned pool** rather than back on an engineer. That is the
> honest state (they were never being worked on a week-old plan), but the unassignable count jumps
> by ~4,000 and that is expected, not a regression.
>
> Audit rows written from this point carry `metadata.dateScope = 'ALL_LIVE'`; rows written before
> the reversal have **no** `dateScope` key and were implicitly today-only. This keeps the trail
> interpretable across the behaviour change (§Audit's six-months-later requirement).

- `workType` excludes INSTALL/RECOVERY (**D-9 — installs stay out**): RECOVERY has no recommender
  path at all (`recommender.service.ts:113-115`, `:477-479`) — unassigning one strands it
  permanently; INSTALL re-dispatches only in PREVENTIVE mode (`:168-171`) — unassigning in DEFICIT
  strands it. Dispatched installs (`REQUESTED + FORMALLY_ASSIGNED`) keep their stops through a
  rebalance; that is coherent (scheduled visits, target dates).
- `status = 'OPEN'` excludes the 351 CLOSED-but-FORMALLY_ASSIGNED tickets (measured 2026-07-29;
  that standing defect is [#178](./178-closure-never-clears-assignment.md)), all SUBMITTED /
  VERIFICATION_PENDING work, and all physical install state (FITTED etc. — INSTALL never carries
  OPEN, `install.service.ts:241-242`).
- Deferred tickets are excluded by construction (a ZM-deferred ticket is already UNASSIGNED,
  `override.service.ts:201-204`). Pending intraday offers likewise — the offered ticket is still
  UNASSIGNED (`intraday-insertion.service.ts:103-104`); the accept race is contained end-to-end
  (CAS `:161-165` → `ALREADY_ASSIGNED` short-circuit → claim released `:191-199`), identical to
  what the 05:00 cron already does.

**In scope regardless of field stage (operator decisions, settled):**
- **ON_SITE / TROUBLESHOOT_STARTED — unassign, no gate, no confirm-token escalation.** That is the
  case the control exists for. The conflict port (`soft-state-conflict.adapter.ts:15-27`) is still
  called, **for reporting only**: preview and audit carry `onSiteCount` + ticket ids. Do NOT reuse
  the `OVERRIDE_AFTER_ON_SITE` verb — this is not a ZM override.
- **Component-blocked (cycle WAITING_COMPONENT, ticket OPEN) — unassign, no skip.** Overruled
  2026-07-29 with consequences accepted — see "Known accepted costs" below. Surfaced as its own
  class in preview + audit ("N were waiting on parts").

## What to build

### Slice 1 — backend: preview + execute

`POST /api/schedules/bulk-unassign`, `@Roles('OPERATIONS_HEAD')` only (**D6**, #119 precedent).
Body: `{ scope: 'ZONE' | 'PAN_INDIA', zoneId?, reasonCode, previewToken?, mode: 'PREVIEW' | 'EXECUTE' }`.

- **Preview** returns counts by class — eligible / on-site (proceeds anyway) / component-blocked
  (proceeds anyway) / closed-excluded / install-recovery-excluded / deferred-excluded — per zone,
  and mints a server-issued token embedding the counts. **Pan-India EXECUTE requires the token**;
  if counts drifted (a dispatch ran, an SE went on-site) the token is refused and the OH
  re-previews. Zone EXECUTE: token optional, typed zone name + reasonCode required.
- **Execute** iterates zones — **one transaction per zone, never one Pan-India transaction**
  (largest zone today: 3,606 live rows; today-only scope: 853 rows / 38 schedules Pan-India).
  Each zone tx:
  1. takes the same non-blocking `pg_try_advisory_xact_lock(hashtext('dispatch_zone_' || zoneId))`
     as dispatch (`batch-assignment.service.ts:68-73`) and **skips the contended zone** with a
     `LOCK_CONTENDED`-style reported reason (`:229` precedent) — never blocks;
  2. stamps `removed_at = now, removed_by = <OH userId>` on in-scope live batch rows;
  3. flips the tickets `assignment_state = 'UNASSIGNED'`;
  4. writes one `ticket_events` row per ticket — `fromState = OPEN, toState = OPEN,
     reasonCode = 'BULK_UNASSIGNED'` (**D4**; same-state precedent
     `troubleshoot-submission.service.ts:179-189`);
  5. stamps touched schedules `lastOverriddenBy/lastOverriddenAt` — **status untouched (D3,
     signed off)**: a deliberate divergence from `removeTicket`'s `flagOverridden`. Flipping to
     OVERRIDDEN would drop every live schedule out of the partial unique
     `work_schedules_one_active_per_se_zone_day` (predicated `status='ACTIVE'`, migration
     `20260708120000:19-20`) **simultaneously — #155's hole opened fleet-wide in one click**. This
     is a system rebalance, not ZM provenance; the provenance columns already exist
     (`schema.prisma:612-613`) and are the #154 direction anyway;
  6. runs under `AuditService.withAudit` (`audit.service.ts:39-42`) — one `audit_logs` row per
     zone: `action = 'BULK_UNASSIGN_ZONE'` (new verb — never `BATCH_OVERRIDE_*`, the ZM scorecard
     reads those), `entityType = 'zones'`, `entityId = zoneId`, `actingZone` set, metadata
     `{ operationId (shared across every zone of one Pan-India click), scope, targetDate,
     reasonCode, previewToken, counts-by-class incl. onSite + componentBlocked, skippedTicketIds
     (capped + spill count), scheduleIds, buildFingerprint (#130 posture, buildStampFields) }`.
- After commit, one `NotificationService.notify` row per affected SE
  (`type: 'DAY_PLAN_REBALANCED'`; `notification.service.ts:133` infra, intraday usage precedent
  `intraday-insertion.service.ts:210-225`). Durable rows for the first client that ever polls.

**Never touches (hard ACs):** `recommendations` (0 SUGGESTED exist in steady state — dispatch
consumes them at `batch-assignment.service.ts:194-199`; writing one would recreate the #126
wedge), `dispatch_runs` / `dispatch_run_zones` / `dispatch_decision_traces`, `se_planner`,
`deferred_until` (neither set nor cleared), batch/schedule lifecycle status, `assigned_se_id`.
Empty batches and empty-but-ACTIVE schedules are left behind deliberately (**D8** — schedule
closure is #147's territory).

### Slice 2 — `POST /api/schedules/dispatch-run` gains optional `zoneId` (D-10)

The second button is the existing endpoint (`schedules.controller.ts:52-62`,
`runForActiveZones`) — already OH/CSM-gated, MANUAL-stamped, audit-bracketed
(`dispatch-run.service.ts:88-95`), build-stamped (`:85`), `dateFrom = today` (`:75`, `:113`), and
proven to APPEND onto empty shells. Add an **optional additive `zoneId` body param** narrowing the
zone loop (`:106`), so a zone rebalance's second click doesn't also append backlog to the four
untouched zones. Omitted → existing all-zones behaviour, byte-identical.

### Slice 3 — hollow-stop read filter (D-11)

Filter zero-live-ticket batches out of the SE day-plan read (`day-plan-query.service.ts:49-60`)
and the ZM schedule views that render stops; sweep those readers. This removes the "five dead
stops above the real work" render after a rebalance. Coordinate with #147 (same file; #147 owns
date-filter/closure — this slice must not absorb that).

### Slice 4 — admin UI (OH-only page, Plant Deactivations pattern)

One page, **two buttons — deliberately not one** (operator decision: if one succeeds and the other
fails, the OH must know exactly where they stand; each action has its own ledger/audit identity):
1. **Unassign** — zone dropdown + Pan-India option → preview modal (counts by class, incl.
   "N on-site" and "N waiting on parts") → typed confirmation (zone name / Pan-India token) →
   result by zone incl. any lock-skipped zones.
2. **Run dispatch** — calls Slice 2 (zone-scoped when a zone was just unassigned).
Plus a history list read from `audit_logs` (`action = 'BULK_UNASSIGN_ZONE'`).

Display near the button (and verbatim in this issue): *"With roster, coverage, zones, availability
and device states unchanged since the morning run, unassign-then-redispatch reproduces materially
the same plan; the net effect is hollowed stops and renumbered plans for every SE in scope. This
control pays only when dispatch inputs have changed — fix the data first, then press it."*

## Known accepted costs (operator-accepted 2026-07-29 — recorded so nobody rediscovers them)

1. **Component-blocked tickets (D2 overruled — the part-with-A / ticket-with-B mismatch).** A
   WAITING_COMPONENT ticket is OPEN and the recommender has **no cycle-state filter**
   (`recommender.service.ts:113-127`; see [#177](./177-recommender-dispatches-waiting-component.md)),
   so once unassigned it is immediately re-dispatchable. Three consequences, stated plainly:
   (a) SE B is handed a ticket that cannot be fixed until the part arrives — a slot of the new
   plan spent on unworkable work plus a wasted site visit; (b) B submits `componentUnavailable`
   again (submit gate is `status==='OPEN'`, `troubleshoot-submission.service.ts:116`) → a **second
   live `component_request`** — the only unique is `submission_id` (migration
   `20260624120000:31`), there is no one-active-per-ticket guard; (c) the part flow breaks
   silently: `component_request.seId` stays A, `confirmReceipt` has no owner check
   (`component-request.service.ts:177-179`), and `confirmResubmit`'s SOFT_OWN_ORIGINAL performs no
   ticket write because it assumes the ticket is still A's (`:234-235`, `:267-278`) — after a
   rebalance it is B's. #177 narrows (a); (b) and (c) remain accepted costs of any-stage unassign.
2. **No undo.** The operation is not reversible after the next dispatch run re-places the tickets
   (re-activating a removed row would violate `batch_assignment_tickets_one_active_per_ticket`
   once the ticket lives elsewhere). No undo is built; no reversibility window is promised.
3. **Stop numbering continues** (#127 artifact, stays #127's): a rebalanced SE's fresh work is
   numbered after the morning's emptied stops (demonstrated: fresh stop 2 above hollow stop 1;
   at scale, stops 6–10 above 1–5). Renumbering would mutate other runs' batches, which #127
   deliberately never does (`batch-assignment.service.ts:160-162`). Slice 3 hides the hollow
   stops; the numbering itself stands.
4. **SE communication is procedural until push exists.** No device identity, no push, no mobile
   client (`DAY_PLAN_NOTIFIER` → `LoggingDayPlanNotifier`, `scheduling.module.ts:40` — log line
   only). Until #76/#89 land, an SE's plan changing mid-day is communicated by the ZM phoning or
   WhatsApping them. The notification rows are written so the record exists; nothing delivers them
   to a handset today. Practical mitigation: press both buttons back-to-back so the shell-plan
   window stays minutes wide.

## Acceptance criteria

- [ ] Preview returns per-zone counts by class (eligible / on-site / component-blocked /
      closed-excluded / install-recovery-excluded / deferred-excluded) and mints a token;
      Pan-India EXECUTE with a stale or absent token is refused with the fresh counts
- [ ] Execute: in-scope tickets (predicate above, today-only) leave the day plan
      (`removed_at` stamped — never deleted), return to UNASSIGNED, and the next dispatch run
      re-places them (e2e: unassign → dispatch → all re-assigned exactly once, same-schedule
      APPEND, no P2002 — the demonstration spec's shape, kept this time)
- [ ] Capacity is freed: post-unassign `committedDayLoad` for a touched SE reflects only surviving
      work (e2e discriminator: capacity N, k tickets, re-run recommends k not N−k)
- [ ] ON_SITE and component-blocked tickets are unassigned AND both classes are reported with
      counts + ids in preview and audit metadata
- [ ] Schedules touched stay `ACTIVE` with `lastOverriddenBy/At` stamped; no write to
      batch/schedule `status`, `recommendations`, `dispatch_*`, `se_planner`, `deferred_until`,
      `assigned_se_id` (asserted, not just unwritten)
- [ ] Per-zone tx + advisory lock: a zone under a concurrent dispatch is skipped and reported,
      never blocked on; remaining zones complete (Pan-India partial success is legible per zone)
- [ ] One `BULK_UNASSIGN_ZONE` audit row per zone under a shared `operationId`, with
      buildFingerprint and the full metadata contract above; one `ticket_events` row per ticket
      (`BULK_UNASSIGNED`); one `DAY_PLAN_REBALANCED` notification row per affected SE
- [ ] `POST /schedules/dispatch-run` accepts optional `zoneId`; omitted → behaviour byte-identical
      (existing dispatch-run suites stay green untouched)
- [ ] Day-plan and ZM schedule reads no longer render zero-ticket stops (Slice 3); sweep test
- [ ] Admin page: two buttons, preview modal with classes, typed confirm, history from audit_logs;
      the "only helps when data changed" copy present
- [ ] New reads use `liveScheduleFilter()` — no hand-spelled `status: 'ACTIVE'` anywhere in the
      feature (#153 lesson, greppable)

## UI surfaces

New OH-only admin page (Plant Deactivations pattern — `/plant-deactivations` precedent). No
authoritative reference image exists (imageless, #119 precedent); match the existing admin design
system, do not invent new chrome.

## Reference

n/a (imageless — see UI surfaces).

## Blocked by

- None. Coordinate: #147 (Slice 3 shares `day-plan-query.service.ts`; do not absorb its
  date-filter/closure scope), #165 (bulk unassign added to its planVersion mutator list — comment
  appended there 2026-07-29), #177 (companion, independent — narrows accepted cost 1a).
- **Mobile freeze: independent.** Changes what `GET /api/schedules/me` says, not its shape
  (freeze plan §3's parallel-safe definition). The one shape-adjacent artifact (hollow stops) is
  removed by Slice 3.
