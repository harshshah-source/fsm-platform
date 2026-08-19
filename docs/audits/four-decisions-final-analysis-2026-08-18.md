# Approved Decisions — Final Fresh Analysis (pre-slicing)

**Analysis only. No code, migration, schema, issue, slice, cleanup execution, or AutoPlant change was made.**
       
| | |
|---|---|
| **Date** | 2026-08-18 (third pass, same day) |
| **Input** | Nine approved business decisions (non-blocking preview; no vehicle location; Special = 3 configurable unsuccessful *reached* attempts; return-date priority Option C; dev-data cleanup first; recycling; Special ≠ status; Special = identification first; clean state before new lifecycle) |
| **Method** | Direct re-read this pass: `override.service.ts` (full), `batch-assignment.service.ts` (full), `schedule-closure-scheduler.service.ts` (full), `bulk-unassign.service.ts` (execute path), plus fresh DB queries. Same-day verified evidence from the fresh-verification pass (`four-decisions-fresh-verification-2026-08-18.md`) reused only where re-confirmed. |
| **DB snapshot** | `fsm` @ localhost:5433, 2026-08-18. Ingestion off; counts are the dev-state baseline the cleanup targets. |

---

## 1. Verdict

All nine approved decisions are technically coherent against the current source. **Five business questions remain open** (§10) — the sub-day return-date mapping (which the decisions explicitly route back on), the SLA/report lifecycle on auto-return, the return-date authority rule, deferral bounds, and the override-bypass policy — plus approval of the cleanup scope (§9). **STOP at the question gate.**

One interpretation is recorded rather than asked: "the supported pre-run changes identified by the design" is read as **holds only** (the only pre-run change the data model can express); anything richer was and remains unbuilt.

---

## 2. Assignment writers — classified from source behaviour

Every writer of `batch_assignment_tickets` / `assignmentState`, traced this pass. "Active workload" = the ticket appears in the SE's live day plan (`/me/tickets` reads live schedules → batches → non-removed rows).

| Assignment source | Places ticket in active SE workload? | Counts as attempt (candidate)? | Why |
|---|---|---|---|
| **05:00 scheduler** (`batch-assignment.service.ts:172`) | **Yes** — creates the row on a live schedule; ticket → `FORMALLY_ASSIGNED`, `deferredUntil` cleared | **Yes** | The canonical dispatch. Idempotency: `alreadyAssigned` guard + partial unique; duplicate recs consumed without a second row — no double-attempt possible. |
| **Intraday accept** (`intraday-insertion.service.ts:190` → `assignTicket(..., 'CRITICAL_ASSIGN', true)`) | **Yes** — same primitive, batch moved to stop 1 | **Yes** | The SE explicitly accepted; strongest possible "entered workload" evidence. |
| **Critical Queue one-click / ZM same-day ADD** (`assignTicket`, audit `CRITICAL_ASSIGN` / `MANUAL_ZM_UPDATE`) | **Yes** — creates row + `ensureSchedule` on today's plan | **Yes** | Identical row shape and mobile visibility to system dispatch. |
| **Device-Detail multi-plant assign** (`assignPlants` → loops `assignTicket`, audit `MANUAL_PLANT_ASSIGN`) | **Yes** | **Yes** | Same primitive; honours deferral on selection (`:350`). ~2,400 historical rows carry this origin. |
| **`REASSIGN` / `SPLIT_BATCH`** (`moveTickets`, `:414-443`) | **Yes** for the *new* row (created on target SE's batch); the *old* row is stamped `removed_at` + human `removed_by` | New row: **Yes** (new attempt window under the new SE). Old row: **No** — human withdrawal per the approved exclusion | Update-before-insert preserves the one-live-row invariant. |
| **`SWAP_SE`** (`:366-399`) | **Yes** — but it **moves the batch itself** (`plant_batch_assignments.seId` + `scheduleId` re-pointed); **`batch_assignment_tickets` rows are untouched** | **Continues the same attempt** — no new row, no removal | Attempt identity is the row, and the row survives the swap. Reached-evidence (`VIEWED`) may have come from the pre-swap SE; acceptable, since the threshold is per-ticket, not per-SE. |
| **`REORDER`** | No row/state change (stop sequence only) | No | Ordering only. |
| **`REMOVE_TICKET`** (`:147-152`) | Ends it — row removed (human), ticket → `UNASSIGNED` *immediately re-selectable* (no defer) | **No** — human withdrawal (approved exclusion) | Note: withdrawal returns the ticket to the very next run's pool. |
| **`DEFER_TICKET`** (`:190-204`) | Ends it — row removed (human) + `deferredToDate`; ticket → `UNASSIGNED` + `deferredUntil` | **No** — human defer (approved exclusion) | The three-write pattern Decision 4 reuses. |
| **Bulk unassign** (`bulk-unassign.service.ts:270-277`) | Ends it en masse — rows stamped (human `removed_by`), tickets → `UNASSIGNED`, ticket events written | **No** — human withdrawal | Clean: no orphan live rows. |
| **Auto-recovery** (`auto-recovery.service.ts:303-306`) | Ends it — row stamped with **`removed_by = NULL`**; ticket terminal (`CLOSED_AUTO_RECOVERY`); `assignmentState` **left `FORMALLY_ASSIGNED`** (1,092 such tickets) | **No** — system recovery (approved exclusion) | The `removed_by NULL` signature is *owned* by this path today — the reason a removal-cause column is mandatory (§4.5). |
| **Departure / plant-deactivation cancellation** | Ends the *ticket* (`CLOSED`, cycle `FAILED`) but **leaves the batch row live** — no row stamp, no `assignmentState` change | **No** — ticket not OPEN | The asymmetry vs auto-recovery is a defect: 3,310 live rows on resolved tickets exist (§9 C1), including 20 rendering as work-to-do on **today's ACTIVE schedules**. |
| **`ComponentRequestService` resume** (`:256`) | Ends the assignment (ticket → `UNASSIGNED` when the part arrives) — does **not** stamp the batch row | n/a (its ticket already has a submission → never Special) | Row-hygiene gap of the same family; harmless for counting because the submission gate excludes these tickets. |

**Consequence for counting:** with the approved exclusions, the *only* removal classes that can terminate a countable unsuccessful attempt are (a) the future recycle removal (plan expired, unworked) and (b) — pending Q2 confirmation — the future VU-driven removal. Everything human- or recovery-removed is excluded, and current-live rows are in-progress, not judged.

---

## 3. Special attempt state machine

```text
batch_assignment_tickets row created                     ── attempt window OPENS
  by: 05:00 dispatch | assignTicket (intraday/critical/manual) | moveTickets(new row)
        │
        ▼
  In SE active workload while the row is live AND its schedule is live
  (SWAP_SE re-points the SE; the window continues)
        │
        ├── no soft_states row with set_at inside the window ──────────► NOT an attempt candidate
        │     (never opened — indistinguishable from never delivered;      (does not count, per approved rule)
        │      also covers a silently-failed VIEWED post)
        │
        └── soft_states row exists (earliest: VIEWED, auto-posted) ───► REACHED — attempt candidate
              │
              ├── troubleshooting_submissions row for the ticket ─────► SUCCESSFUL
              │     (single writer: TroubleshootSubmissionService.submit(),
              │      idempotent on (se_id, client_submission_id);
              │      the component-blocked variant ALSO writes one — the SE
              │      diagnosed the fault; ticket enters WAITING_COMPONENT.
              │      This is the system's one authoritative success event —
              │      no new definition invented.)
              │
              └── window ends with no submission and ticket still OPEN ─► UNSUCCESSFUL REACHED ATTEMPT
                    window-ending causes and how each is classified:
                      PLAN_EXPIRED (new recycle)        → counts
                      VEHICLE_UNAVAILABLE (new, D4)     → counts, pending Q2
                      human withdraw / defer / bulk     → excluded (approved)
                      auto-recovery / ticket closure    → excluded (ticket not OPEN)

SPECIAL := countable unsuccessful reached attempts ≥ special_ticket_attempt_threshold
           AND no troubleshooting_submissions row ever
           AND ticket.status = 'OPEN'
```

### 3.1 How the reached-evidence survives each event

| Event | Attempt row | `soft_states` evidence | Net effect |
|---|---|---|---|
| Schedule closure (with recycle) | Stamped `PLAN_EXPIRED` | Rows persist (resolved, never deleted) | Attempt judged: reached ∧ no submission → counts |
| REASSIGN / SPLIT_BATCH | Old row human-removed (excluded); new row opens a new window | Old-window evidence stays attached to the old window | No double-count; new SE starts a fresh candidate |
| DEFER / REMOVE / bulk-unassign | Human-removed | Persist | Excluded by rule |
| SWAP_SE | Row continues | May span two SEs | One attempt, per-ticket threshold — coherent |
| Override REORDER | Untouched | — | No effect |
| Auto-recovery | System-removed (`AUTO_RECOVERY` after migration) | Persist; also resolved with `AUTO_RECOVERY` | Excluded; ticket terminal |
| Rescheduling (next-day re-dispatch) | New row | New window | New candidate; `deferredUntil` cleared at dispatch (existing `:182`) |
| Ticket closure (departure/cancel) | Today: row left live (defect); after cleanup + the symmetric stamp (§4.9) it ends | Persist | Excluded — status not OPEN |
| Late/lost submission | — | — | Derived evaluation self-corrects: a submission row appearing later flips the ticket out of Special retroactively |

### 3.2 Derived vs materialised — determined by evidence, not preference

**Derived**, with two supporting indexes. Grounds:

1. **Decision 8 says identification first** — nothing needs to sort on it, so the one capability only materialisation buys (a sortable column) is not required.
2. **Retroactivity**: the configurable threshold (Decision 3) reclassifies instantly under a derived view; a stored flag needs backfills on every change.
3. **Self-correction**: the lost-submission hazard (no offline queue exists; failed submits are lost and retried under new idempotency keys) cannot create a *permanent* false Special under a derived view — a re-sent submission flips the predicate.
4. **Dev-history hygiene for free**: virtually no historical row has reached-evidence (17 `soft_states` rows total), so the approved reached-requirement already excludes the dev-era ledger from counting without any data surgery.
5. **Single-writer integrity**: nothing increments, so nothing can double-count; the ledger (`batch_assignment_tickets` + removal causes + `soft_states` + `troubleshooting_submissions`) is the source of truth.

Required for acceptable cost: a plain index on `batch_assignment_tickets (ticket_id)` (today only `(batch_id)` plus the live-rows-only partial unique exist — a historical per-ticket count would seq-scan 16k rows), and a supporting index on `soft_states (ticket_id, set_at)`. Evaluation must be one batched aggregate per surface, never per-ticket in a loop. Materialise later *only if* Special ever gains a scheduling effect — which Decision 8 explicitly defers.

---

## 4. Recycling — verified point by point

1. **When a schedule closes:** `ScheduleClosureScheduler.closeTick` — `dateTo < istDate(now)`, status `ACTIVE|OVERRIDDEN`, per-zone, gated `BUSINESS_SWEEPS_ENABLED`, single-in-flight, per-zone `pg_try_advisory_xact_lock` (try — skips, never waits), re-read inside the lock.
2. **Eligible batch rows:** `removed_at IS NULL` on the closing schedules — the same set `closeZone` already walks to decide PARTIAL vs COMPLETED, narrowed from schedule-distinct to row-level.
3. **Unresolved tickets:** `ticket.status NOT IN RESOLVED_TICKET_STATUSES` (the seven terminal statuses, `:40-48`) — the exact predicate closure already applies.
4. **`removed_at`:** stamped at closure for eligible rows. Idempotent by construction — the second pass's `WHERE removed_at IS NULL` matches nothing; the partial unique remains the cross-connection backstop.
5. **Why a removal reason is required:** `removed_by NULL` is already auto-recovery's signature (1,092 rows), and the attempt-counting rule needs to distinguish `PLAN_EXPIRED` (counts) from withdraw/defer/recovery (excluded) and from `DEV_CLEANUP` (§9). A nullable `removal_reason` on `batch_assignment_tickets` (backfillable for existing rows from `removed_by` + ticket status) is the minimal shape. It is load-bearing for Decision 3, not decoration.
6. **Manual withdrawals protected:** already `removed_at IS NOT NULL` → outside the sweep's filter; their human `removed_by` (and backfilled reason) keeps them excluded from counting.
7. **Auto-recovery protected:** doubly — ticket resolved (filter 3) *and* row already stamped.
8. **Deferral preserved:** `DEFER_TICKET` already removed the row and set `deferredUntil`; the sweep never writes `deferredUntil`, and dispatch clearing it on re-assignment (`:182`) is untouched. Return-date deferrals (Decision 4) ride the same column or the VU report per Q3 — either way the sweep is blind to them.
9. **Overrides handled:** closure already processes `OVERRIDDEN` schedules; moved tickets live on the destination batch and recycle when *that* plan closes; swapped batches carry their rows to the new SE and recycle normally. **Companion fix:** departure/plant-deactivation cancellation should stamp its rows at cancellation time (symmetric with auto-recovery) — otherwise resolved-ticket rows keep accruing outside the sweep's unresolved filter; a closure-side backstop stamping resolved-ticket rows (`RESOLVED_AT_CLOSURE`) covers stragglers.
10. **Idempotency:** two set-based `updateMany` statements per zone inside the existing short transaction (rows; then tickets → `UNASSIGNED`). The partial unique guarantees the stamped row was the ticket's *only* live assignment, so flipping to `UNASSIGNED` can never orphan a second valid assignment. Verified drift check: `UNASSIGNED`-with-live-row = 0 in the current DB.

**Prerequisite (confirmed from the file itself):** the closure `@Cron` has **no `timeZone`** and its own docstring contradicts itself — "04:00 UTC … ahead of the 05:00 dispatch tick" is false: dispatch is 05:00 **IST**; 04:00 UTC is 09:30 IST, 4.5 h *after* dispatch on a UTC host. The "crons are an hour apart" contention argument also collapses. Fix (add `timeZone: BUSINESS_TIMEZONE`; ideally settings-driven like `dispatch_cron`) is a hard prerequisite of the recycle slice. Related same-family defects to fix or at least not replicate: `plannerForDate` (UTC day) and `assignTicket`'s `Date.UTC` schedule day — a ZM assign between 00:00–05:29 IST lands on the previous IST day's schedule.

**Attempt-boundary bonus:** the recycle stamp *is* the missing `attempt_ended_at` — no separate attempt entity is needed.

**Mobile side-effect:** once `UNASSIGNED`, a covered ticket reappears in the SE's shared-pool view — the "double limbo" (invisible to scheduler *and* SE) resolves without extra work.

**Ledger note:** tickets whose device lacks an `slaBucket` are silently dropped by the recommender (neither recommended nor counted). Recycling grows this population's exposure; the run ledger should count them.

---

## 5. Return date — verified flow and required wiring

Current behaviour re-confirmed: `fileReport()` = report row + primary-SLA pause (guarded, won't re-pause) + `lastStateChangedAt`; **no** scheduling effect; `expectedFrom` has zero scheduling readers; resume (`resumeSla`) is manual, also resolves the report, and **does not check the pause reason** (can clear a `WAITING_COMPONENT` pause); `confirmDate` (ZM/CSM/OH) rewrites `expectedFrom` only, unaudited; nothing prevents multiple OPEN reports per ticket; mobile presets cap at ~tomorrow 2 PM while the API accepts any date; the schema/migration comments falsely claim the resurface behaviour already exists.

Required wiring (the `deferTicket` three-write pattern, from the VU path):

```text
on fileReport(expectedFrom):
  batch_assignment_tickets.removed_at = now, removal_reason = VEHICLE_UNAVAILABLE   (attempt-window end)
  ticket.assignmentState = UNASSIGNED
  ticket "waits" until the return date        ← mechanism depends on Q1 (sub-day) + Q3 (authority)
  re-entry: notDeferredOn is inclusive (deferredUntil <= day) — no new job needed
            (if the trigger derives from the report instead, a TierOverrideExpiryService-shaped
             sweep over the existing (status, expectedFrom) index is the fallback pattern)
```

**The sub-day mapping is unresolved and routes back to the operator (Q1).** `expectedFrom` is a timestamp; `deferredUntil` is a DATE compared inclusively against the IST day-start — mapping "In 2 hours" to `deferredUntil = today` is a same-day no-op defer. The decisions instruct not to invent the rule.

Open alongside it: SLA auto-resume + report auto-resolution + whether VU-terminated attempts count (Q2 — note that under the *approved* attempt rules as written, a VU visit is reached-with-no-submission and therefore counts by default; the exclusion list names only withdraw/defer/auto-recovery); date authority + hold collision (Q3); bounds (Q4).

---

## 6. Return-date priority (Option C) — implementation determination

- **Where:** one new key in `canonicalSort`, evaluated **after** Device Bucket and **only when both tickets are below CRITICAL_PLUS** — bucket compares first, so Critical/Severe always outranks the flag; among the rest, return-due sorts above normal backlog. Exactly Option C, `sla_bucket` untouched, no second SLA model.
- **TS-only, re-confirmed:** the recommender's selection query has no `orderBy`; ordering happens once in TS (`recommender.service.ts:216`). No SQL mirror exists — the stale `canonical-sort.ts` docstring claiming one must be corrected in the same change so nobody "fixes" a divergence into existence. The unrelated SQL list sorts (`device.service.ts`, `ticket-query.service.ts`) are display orderings, not dispatch.
- **`CRITICAL_PLUS`:** reuse — export from one module; two copies already exist (`cross-zone-escalation.service.ts:18`, `dashboard.service.ts:348`), don't add a third.
- **Tie-breaking:** deterministic by construction — keys 3–5 (priority rank, oldest-inactive, deviceId) still follow the new boolean; a boolean adds no ties the existing keys don't already break.
- **`returnDueToday` must be computed, not stored** — from `deferred_until = today` or from the OPEN VU report (`expectedFrom` ≤ today, IST) per Q3; the selection query must fetch whichever input in the same batched read (no N+1).
- **Planner bias:** unchanged — it acts at SE *selection* (`chosen = plannerBias ?? passed[0]`), a different stage from ticket *ordering*.
- **Capacity:** unchanged — the comparator only changes which tickets consume capacity first, which is the decision's intent; `committedDayLoad` and the in-run counters are untouched.
- **Special:** no interaction — identification only (Decision 8); one new sort term, not two.
- Natural aging is coherent: a long-deferred ticket's bucket keeps escalating while it waits, so it may re-enter already CRITICAL+ — then the bucket key decides and the flag is never consulted, which is correct under Option C.

---

## 7. Admin preview — final shape

**Every mutation `runForZone()` performs today, all of which the dry-run must suppress** (verified): ① `clearFinalizedOrphans` — a **zone-wide** `deleteMany` of finalized/null-run SUGGESTED recs; ② `recommendation.create` (SUGGESTED); ③ UNASSIGNABLE recommendation rows; ④ `dispatchDecisionTrace.createMany`; ⑤ `inventory.recordComponentBlock`; ⑥ `inventory.resolveComponentBlock`. The preview must additionally **not** reserve the in-process in-flight guard, **not** take the per-zone advisory lock, and **not** create a `dispatch_runs` row (no PREVIEW trigger exists).

- **One implementation, projected:** thread a `dryRun` flag through `runForZone` returning the decision list in memory — never a parallel reimplementation (#153's lesson).
- **Future-date aware:** a `targetDate` parameter distinct from wall-clock `now`, applied to: deferral day, planner day (fixing the UTC bug in passing, not copying it), `committedDayLoad`, `currentStatusMany`, `modeForZone`, `resolveActiveOverrides`. The honest limit stands: `slaBucket`/`inactivityHours` are materialised as-of the last recompute — a D+1 preview ranks on today's buckets and **must say so on the page**. The `now` parameter itself is a footgun (a future `now` creates *real* future schedules); the controller's hardcoded `new Date()` is the only guard today.
- **Stale-safety:** reuse the bulk-unassign pattern — HMAC token over a counts snapshot, 10-min TTL, `TOKEN_STALE` → fresh preview; the sign/verify helpers are module-private and need extraction to a shared module.
- **Holds:** write `tickets.deferred_until`. One gap: `DEFER_TICKET` requires a live batch row, so holding an **unassigned** ticket pre-run needs a small new endpoint (a bare `deferred_until` write with audit). Coexistence with the 05:00 run re-confirmed safe: disjoint writes, shared predicate, admin inaction = normal dispatch; manual runs unchanged.
- **Pre-run changes:** holds only (recorded interpretation, §1).

---

## 8. Decision 2 — no vehicle location

Re-confirmed unchanged: no presence input anywhere in scheduling; `VEHICLE_ON_TRIP` and `COMPONENT_UNAVAILABLE` hard filters both unreachable; `plants.location` NULL ×933; the floating-SE MV's geometry branch inert (0 floating SEs). Nothing in this design adds any location dependency: recycling keys on schedule dates and ticket status; return-date keys on a human-entered date; Special keys on the ledger. Vehicle location remains fully outside scheduling.

---

## 9. Proposed Development Cleanup (NOT executed)

Precondition: the `removal_reason` column ships first (recycle prerequisite), so cleanup rows are permanently distinguishable (`DEV_CLEANUP`) and — with the reached-evidence rule — structurally excluded from attempt counting anyway. Execute as one transaction, after a `pg_dump` of `batch_assignment_tickets`, `tickets`, `work_schedules`. Counts are from today's snapshot; re-measure at execution time.

| Class | What | Where | Expected count | Action | Why safe |
|---|---|---|---|---|---|
| **C1** | Live batch rows on **resolved** tickets (departure/plant-deactivation left them live; incl. 20 on today's ACTIVE schedules rendering cancelled tickets as work-to-do) | rows where `removed_at IS NULL` ∧ ticket status ∈ RESOLVED set | **3,310** (2,906 PARTIAL + 384 COMPLETED + 20 ACTIVE) | `removed_at = now`, `removal_reason = 'DEV_CLEANUP'` | Tickets are terminal; nothing reads these rows as valid work except the SE day plan, where they are actively wrong |
| **C2** | Stranded **OPEN** tickets on **PARTIAL** schedules (the recycle backlog) | live rows on PARTIAL ∧ ticket OPEN | **4,684** rows / tickets (of which **1,357** pass the 48-h gate today and would re-enter dispatch; the rest re-enter as their devices age) | stamp row as C1 + `ticket.assignmentState = 'UNASSIGNED'`; `deferredUntil` untouched (0 rows exist); write a `ticket_events` row per ticket (the bulk-unassign precedent) | Known-good start for the new lifecycle (Decision 5/9); marked `DEV_CLEANUP` so none counts as a field attempt |
| **C3** | `FORMALLY_ASSIGNED` on terminal tickets with **no** live row (auto-recovery never resets the state) | tickets `CLOSED_AUTO_RECOVERY` ∧ `FORMALLY_ASSIGNED` ∧ no live row | **1,092** | `assignmentState = 'UNASSIGNED'` | Cosmetic today (recommender filters OPEN) but establishes the checkable invariant `FORMALLY_ASSIGNED ⟺ one live row` |
| **Do not touch** | 299 live rows on ACTIVE schedules with UNRESOLVED tickets (current live work); all `soft_states` (17), all `ticket_events`, `recommendations` (0 SUGGESTED orphans), schedules (0 past-dated live), `deferred_until` (0), VU reports (0) | | | | |

**Verification queries (all must return 0 after execution):**

```sql
-- V1 no live row on a non-live schedule
SELECT count(*) FROM batch_assignment_tickets b
JOIN plant_batch_assignments p ON p.batch_id=b.batch_id
JOIN work_schedules w ON w.schedule_id=p.schedule_id
WHERE b.removed_at IS NULL AND w.status NOT IN ('ACTIVE','OVERRIDDEN');
-- V2 no live row on a resolved ticket
SELECT count(*) FROM batch_assignment_tickets b JOIN tickets t ON t.ticket_id=b.ticket_id
WHERE b.removed_at IS NULL AND t.status IN ('CLOSED','CLOSED_AUTO_RECOVERY','CLOSED_NON_OPERATIONAL',
  'FAILED_VERIFICATION','FAILED_ACTIVATION','FAILED_RECOVERY','RECEIVED_AT_WAREHOUSE');
-- V3/V4 assignment-state invariant, both directions
SELECT count(*) FROM tickets t WHERE t.assignment_state='FORMALLY_ASSIGNED'
  AND NOT EXISTS (SELECT 1 FROM batch_assignment_tickets b WHERE b.ticket_id=t.ticket_id AND b.removed_at IS NULL);
SELECT count(*) FROM tickets t WHERE t.assignment_state='UNASSIGNED'
  AND EXISTS (SELECT 1 FROM batch_assignment_tickets b WHERE b.ticket_id=t.ticket_id AND b.removed_at IS NULL);
-- V5 expected deltas: rows stamped DEV_CLEANUP = 7,994; OPEN+UNASSIGNED grew by 4,684
SELECT count(*) FROM batch_assignment_tickets WHERE removal_reason='DEV_CLEANUP';
```

**Rollback:** pre-commit — the transaction. Post-commit — every touched row is identifiable (`removal_reason = 'DEV_CLEANUP'`; C2 tickets via their cleanup `ticket_events`; C3 by status): clear `removed_at`/`removal_reason` on the marked rows and restore `FORMALLY_ASSIGNED` on the evented tickets; the dump is the last resort.

---

## 10. Questions Requiring Approval

**STOP. Nothing will be created until these are answered.** Q1–Q5 plus the cleanup sign-off.

**Q1 — Sub-day / same-day return dates.** `expectedFrom` is a timestamp; the deferral engine is day-granular (IST) and inclusive. What should "In 2 hours" / "In 4 hours" / "today" do? Options: (a) same-day return = no deferral at all — the ticket simply stays/returns eligible, and only dates ≥ tomorrow defer; (b) round every sub-day value up to tomorrow; (c) build hour-granular deferral (new machinery, largest change). *Recommendation: (a) — honest to the SE's statement, zero new machinery; the two sub-day presets become "don't hold this ticket."* Blocks: the `fileReport` wiring and the mobile preset semantics.

**Q2 — SLA + report lifecycle on the return date.** (i) Does the primary SLA auto-resume when the ticket re-enters scheduling? (ii) Does the VU report auto-resolve, resolve on supersession/submission, or stay manual? (iii) Confirm the derived default that a VU-terminated visit **counts** as an unsuccessful reached attempt (the approved exclusions name only withdraw/defer/auto-recovery, and a VU visit is reached-with-no-submission — this is what eventually surfaces a never-returning vehicle as Special). (iv) Is a repeat absence a new report + new attempt? *Recommendation: resume on re-entry; resolve on supersession or submission only (a date nobody observed shouldn't assert a return — consistent with Decision 2); yes; yes. Fix the `resumeSla` reason-check hole in the same slice either way.* Blocks: Decision 4's lifecycle slice and the counting rule's VU branch.

**Q3 — Return-date authority and the hold collision.** SE re-files vs unaudited ZM `confirmDate` vs an admin hold sharing `deferred_until` (a hold silently overwrites a return date; multiple OPEN reports can coexist). Options: (a) latest report wins; (b) ZM edit outranks; (c) earliest wins; (d) derive `returnDueToday` from the **report** and keep `deferred_until` purely for holds, so the two never collide. *Recommendation: (a) + (d), with `confirmDate` gaining an audit row and one-open-report-per-ticket enforcement.* Blocks: the `returnDueToday` predicate and the hold design.

**Q4 — Bounds.** The API accepts any `expectedFrom` (mobile presets cap it only by accident) and nothing caps consecutive VU deferrals — a never-returning vehicle loops with its primary SLA paused each cycle. Options: (a) server-side horizon cap; (b) max consecutive VU deferrals → escalation; (c) both; (d) rely on Special alone. *Recommendation: (c), with Special as the surfacing mechanism rather than the only guard.* Blocks: `fileReport`/`confirmDate` validation.

**Q5 — Manual-override deferral bypass.** `assignTicket`, `SPLIT_BATCH`, `REASSIGN`, `SWAP_SE` ignore `notDeferredOn`; `assignPlants` deliberately honours it. A ZM can therefore assign a ticket before its return date, bypassing hold and priority. Options: (a) keep as unrestricted ZM authority; (b) block; (c) allow with explicit `confirm` + reason (the `CONFLICT_ON_SITE` pattern already on every override command). *Recommendation: (c), applied consistently across all four paths.* Blocks: the override-slice acceptance criteria.

**Cleanup sign-off:** approve the §9 scope (C1 3,310 · C2 4,684 · C3 1,092, verification V1–V5, rollback as stated), sequenced after the `removal_reason` migration and before recycling is enabled.

---

*Analysis only. Nothing was created, modified, executed, or migrated. Verified against commit `0b72976` and the live dev database, 2026-08-18.*
