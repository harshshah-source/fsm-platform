# Approved Scheduler Design — Architecture Fit & Tracer-Bullet Slice Plan

**Planning only. No source, test, migration, database, or cleanup change was made. No issue files
are created yet — the plan below is complete and will be filed verbatim once the two §6 questions
are answered (the operator's Decision-12 STOP condition triggered).**

| | |
|---|---|
| **Date** | 2026-08-19 |
| **Tree** | `0b72976` — unchanged since the 2026-08-18 line-exact verification passes |
| **Inputs** | The approved decision set (2026-08-19 brief) · `four-decisions-final-analysis-2026-08-18.md` · `four-decisions-fresh-verification-2026-08-18.md` — all evidence re-confirmed against this tree, not reused blindly |
| **Conventions** | `docs/agents/issue-tracker.md` skeleton (`# NN — title / Status / Type / What to build / Acceptance criteria / UI surfaces / Reference / Blocked by`), numbered from the next free `NN` = **240**, indexed in `.scratch/fsm-platform-v1/INDEX.md` |

---

## A. Architecture fit

Every approved decision lands on an existing seam. Nothing requires a second scheduling system.

| Decision | Fits into | Fit quality |
|---|---|---|
| Non-blocking preview | `RecommenderService.runForZone` (dry-run flag + `targetDate`), `BulkUnassignService`'s HMAC-token/`TOKEN_STALE` pattern (helpers need extraction — currently module-private), `tickets.deferred_until` + `notDeferredOn()` for holds | Clean; the six in-run mutations to suppress are enumerated (§C #250) |
| No vehicle location | Nothing — the scheduler already has zero location inputs; two dead filters get documented, not removed | Zero-work by construction |
| Special (3 configurable, reached) | `batch_assignment_tickets` as the attempt window; `soft_states.VIEWED` as reached; `troubleshooting_submissions` as the single success writer; `settings/assignment-threshold.ts` (#238) as the configuration template; **derived** representation (per the 5-ground determination in the final analysis) | Clean once recycling (+ removal reasons) exists |
| Recycling | `ScheduleClosureScheduler.closeZone` — already computes the unresolved set under the right per-zone lock; two set-based `updateMany` extend it | Clean; two prerequisites (timezone fix, `removal_reason`) |
| Return date (proposal → approval → deferral → priority) | `vehicle_unavailability_reports` (+ approval columns), `OverrideService.deferTicket`'s three-write pattern, `notDeferredOn` (inclusive, IST-day), `canonicalSort` (TS-only — verified, no SQL mirror exists), `CRITICAL_PLUS` (consolidated) | Clean, **except** the two §6 questions |
| SLA lifecycle | `failure_cycles` dual clocks; `resumeSla` gains a reason check; `TierOverrideExpiryService` is the in-repo template for the date-driven resume sweep; the unused `@@index([status, expectedFrom])` finally gets its query | Clean |
| Dev cleanup | Pure data operation, marked via the new `removal_reason = 'DEV_CLEANUP'`; V1–V5 verification queries already written | Clean; sequenced after #241, before #242 enablement |
| Override-with-confirm | The existing `CONFLICT_ON_SITE` → `confirm + reasonCode` pattern on every override command | Clean; note the real entry point is `assignTicket` (deferred tickets cannot appear in live batches, so the move paths need only defense-in-depth) |

### Hidden-conflict check (delta beyond the 2026-08-18 analyses)

- **Return-date decision vs admin hold**: kept separate by construction — the scheduling trigger for return dates derives from the report's *authoritative date*, `deferred_until` carries the mechanical deferral, and a preview hold on a return-date ticket is refused/warned rather than silently overwriting (final shape depends on §6 answers).
- **Special vs REPEAT/ESCALATED**: no shared fields — Special reads the assignment ledger + submissions; REPEAT/ESCALATED read `failure_cycles.repeat_failure`. Never cross.
- **VIEWED vs recycling**: `soft_states` rows persist (resolved, never deleted), so reached-evidence survives the window ending; the window bound is `row.created_at .. row.removed_at`.
- **IST/UTC**: three same-family defects — closure cron (no `timeZone`; its own docstring self-contradicts: 04:00 UTC = 09:30 IST, *after* dispatch), `plannerForDate` (UTC day), `assignTicket` (`Date.UTC` schedule day) — all owned by #240 per the brief's §21 instruction.
- **SE Planner**: untouched — soft bias at SE selection; ordering changes never reach it.
- **Manual dispatch / 05:00 / preview**: preview takes no lock, no in-flight slot, writes no `dispatch_runs` row — verified non-interference.
- **Auto-recovery vs recycling**: disjoint by the resolved-status filter *and* by `removed_at` already being stamped; the removal-reason backfill keeps them distinguishable forever.

## B. Existing components reused (exact)

`ScheduleClosureScheduler` · `BatchAssignmentService` (`:182` deferral-clear stays sole) ·
`RecommenderService` + `canonical-sort.ts` + `candidate-selection.service.ts` ·
`OverrideService` (`deferTicket` pattern, `CONFLICT_ON_SITE` confirm pattern, `assignTicket`) ·
`BulkUnassignService` (token + set-based execute + ticket-event pattern) ·
`VehicleUnavailabilityService` + `vehicle_unavailability_reports` (+ `@@index([status, expectedFrom])`) ·
`ticketing/deferral.ts` (`notDeferredOn` — one definition; the hand-rolled copy in
`se-ticket-access.ts:34` gets folded back in when touched) · `soft_states` / `TroubleshootSubmissionService` ·
`settings/*` (#238 governance stack: registry, authority, `setting_changes`, controller-order pin) ·
`TierOverrideExpiryService` (date-sweep template) · `AuditService.withAudit` · `dispatch_runs` ledger ·
`batch_assignment_tickets` partial unique (the one-live-row invariant every safety argument leans on).

**RBAC/authority as verified (Decision 12 input):** the codebase defines *scope* clearly and
uniformly — ZM zone-clamped (`isManagerForTicket`, `inScope`, `resolveManagerScope` collapses an
acting CSM/OH to a single zone), CSM and OH global. It defines *cross-role supersession* in exactly
one domain: system settings, where `SETTING_FINAL_AUTHORITY_ROLE = 'OPERATIONS_HEAD'` can lock and
revert (#238). Every per-ticket operational path (overrides, `resumeSla`, `confirmDate`) is **flat**:
any in-scope manager's action commits immediately, fully audited, latest write wins, no role rank.
Two conflicting precedents → §6 Q2 per the brief's explicit STOP.

## C. / D. Prepared slices, in dependency order (to be filed as `.scratch/fsm-platform-v1/issues/NN-*.md`)

> Filed only after §6 is answered. Every slice: `Status: ready-for-agent`, `Type: AFK` unless noted.
> Content below is the full "What to build" substance; the filed issues add the skeleton sections
> (UI surfaces / Reference / Blocked by) as stated per slice.

### #240 — IST day-boundary correctness: closure cron, planner date, manual-assign date
Backend-only. Three same-family defects, one theme, independently valuable.
**Current:** `schedule-closure-scheduler.service.ts:91` `@Cron` has no `timeZone` (fires 09:30 IST on
a UTC host — after 05:00 dispatch, inverting the closure→dispatch ordering the docstring asserts);
`recommender.service.ts:590-591` derives the planner day with UTC components; `override.service.ts:282`
derives the manual-assign schedule day with `Date.UTC`. Between 00:00–05:29 IST all three act on the
previous IST day.
**Change:** closure cron gains `timeZone: BUSINESS_TIMEZONE` (and, matching the dispatch precedent,
becomes settings-driven or at minimum documents `SCHEDULE_CLOSURE_CRON` as IST); both date
derivations switch to `istDate(now)`. Correct the closure docstring's "04:00 UTC … ahead of 05:00".
**AC:** a closure tick and a dispatch tick simulated on a UTC-clock host order closure-first;
planner rows and manual assigns land on the IST day across the 00:00–05:29 window (boundary tests).
**Tests:** unit on both date fns; e2e pinning closure-before-dispatch ordering semantics.
**Blocked by:** none. **Risks:** none beyond behaviour *correcting* in the night window.

### #241 — Assignment removal-cause: `removal_reason` + writer stamps + backfill + indexes
Backend + migration (described, not created now).
**Current:** `removed_by NULL` is overloaded (auto-recovery system-removals, 1,092 rows);
departure/plant-deactivation cancel tickets but leave batch rows live (3,310 incl. 20 on ACTIVE
plans); `ComponentRequestService:256` unassigns without stamping the row; attempt counting cannot
distinguish removal causes; historical per-ticket counts would seq-scan (only `(batch_id)` + the
live-rows partial unique exist).
**Change:** nullable `removal_reason` on `batch_assignment_tickets`; writers stamp it —
`deferTicket → ZM_DEFERRED`, `removeTicket → ZM_WITHDRAWN`, `moveTickets` source → `REASSIGNED`,
bulk-unassign → `BULK_UNASSIGNED`, auto-recovery → `AUTO_RECOVERY`; departure/plant-deactivation gain
the symmetric row-stamp (`TICKET_CANCELLED`) and `ComponentRequestService` stamps
(`COMPONENT_WAIT`); backfill existing removed rows from `removed_by` + ticket status; add plain
index `batch_assignment_tickets (ticket_id)` and `soft_states (ticket_id, set_at)`.
**AC:** every writer verified to stamp; backfill leaves zero removed-row with NULL reason; the
invariant "`FORMALLY_ASSIGNED` ⟺ one live row" holds for all *newly written* states.
**Blocked by:** none. **Rollback:** column is additive; backfill re-runnable.

### #242 — Unresolved-assignment recycling at schedule closure (`PLAN_EXPIRED`)
Backend. **The load-bearing lifecycle change (Decision 6/8).**
**Current:** closure flips `work_schedules.status` only; a dispatched-unworked ticket is stranded
forever (max assignments ever: 2, all human-driven).
**Change:** inside `closeZone`'s existing per-zone transaction/lock, two set-based statements over
the closing schedules: (1) live rows on unresolved tickets (`status NOT IN RESOLVED_TICKET_STATUSES`
— the predicate closure already uses) → `removed_at = now`, `removal_reason = 'PLAN_EXPIRED'`,
`removed_by NULL`; (2) those tickets → `assignmentState = 'UNASSIGNED'` (`deferredUntil` untouched).
Backstop stamp for resolved-ticket stragglers (`RESOLVED_AT_CLOSURE`). Count recycled per zone on
the closure outcome/log; count recommender-dropped bucket-less tickets on the run ledger.
**Protections (all verified):** withdrawn/deferred rows already removed (filter 1); auto-recovered
doubly excluded; other-active-assignment impossible (partial unique); overridden/moved rows recycle
when *their* plan closes; return-date deferrals untouched (sweep never writes `deferredUntil`).
Idempotent: re-run matches nothing.
**AC:** D-day simulation — assigned→unworked→closure→UNASSIGNED→next-run re-selects; each protected
class pinned by a test; lock-window stays set-based (no per-ticket fan-out).
**Blocked by:** #240, #241. **Enablement gate:** #243 executed first (Decision 9).

### #243 — Development-data cleanup (approved scope; described now, executed on later approval)
Data-only slice; `Type: HITL` (execution requires the separate implementation approval).
Scope exactly as approved: **C1** 3,310 live rows on resolved/cancelled tickets → `removed_at` +
`DEV_CLEANUP`; **C2** 4,684 stranded-OPEN rows on PARTIAL schedules → same stamp + ticket
`UNASSIGNED` + ticket event; **C3** 1,092 `FORMALLY_ASSIGNED` auto-recovered tickets → `UNASSIGNED`.
Untouched: 299 live rows on ACTIVE schedules, soft states, events, VU reports. `pg_dump` first; one
transaction; V1–V5 verification queries (final-analysis §9); rollback via the `DEV_CLEANUP` marker +
cleanup ticket-events; counts re-measured at execution time.
**Blocked by:** #241 (needs the reason column). Historical rows never count as attempts — doubly
guaranteed (marker + no reached-evidence exists for them).

### #244 — Special ticket: configurable threshold + derived identification + admin surfacing
Backend + Admin (vertical slice).
**Definition (approved, code-grounded):** attempt window = one `batch_assignment_tickets` row
(SWAP_SE continues it; REASSIGN/SPLIT_BATCH end old/open new); attempt candidates = the six approved
creators; *reached* = a `soft_states` row with `set_at` inside the window; *success* = a
`troubleshooting_submissions` row (single writer; component-blocked variant included); *countable
unsuccessful* = reached ∧ no submission ∧ window ended `PLAN_EXPIRED` or `VEHICLE_UNAVAILABLE`;
`SPECIAL := countable ≥ threshold ∧ no submission ever ∧ status OPEN`. **Derived, not stored** (per
the evidence determination); one batched aggregate per surface, never per-ticket loops.
**Threshold:** `special_ticket_attempt_threshold`, default 3, validated integer ladder (2–10 — 0/1
are destructive: ≈ whole backlog Special on day one), full #238 pattern (named key, pure parser,
typed rejections, `coerceStored`, per-run read, default write roles; no invented co-ownership).
**Admin:** Special badge + filter on the tickets queue; per-ticket attempt history (windows, reached,
outcome) on the ticket/device detail; distinct from REPEAT/ESCALATED chips.
**UI surfaces:** Admin tickets queue + ticket detail. **Reference:** the existing tickets-page
reference image; badge styling per `ticketBadges.tsx` precedent (#238's `HELD` badge).
**AC:** thresholds reclassify retroactively; a late submission un-Specials a ticket with no writer
involved; REPEAT/ESCALATED fixtures unaffected; excluded removal causes provably never count.
**Blocked by:** #241, #242.

### #245 — VU report lifecycle: one-open-per-ticket, supersession, audited proposal → approval/override
Backend + Admin. **Gated on §6 Q1+Q2.**
**Current:** `fileReport` always creates (N OPEN rows possible); `confirmDate` rewrites
`expectedFrom` with no audit; `resumeSla` is the only resolver; the schema/migration comments
falsely claim resurface behaviour exists (corrected here).
**Change:** one OPEN report per ticket (partial unique; a new report supersedes the prior —
`SUPERSEDED` status); the SE's `expectedFrom` becomes the **proposed** date, preserved immutably;
new audited approve/override actions for in-scope managers (ZM zone-clamped, CSM/OH global — the
verified scope model) writing authoritative date + decider + role + timestamp + override reason via
`AuditService.withAudit`; report also resolves on troubleshooting submission (Decision 16);
`confirmDate` endpoint retired/absorbed. Admin `VehicleUnavailabilityPage` grows the review queue
(proposed vs authoritative, decide actions). Mobile unchanged (plus surfacing "returns {date}" to
the SE — the read the service docstring says is missing).
**UI surfaces:** Admin readiness/VU page (extended). **Reference:** existing page (built without a
v2 image — same posture); mobile: n/a this slice.
**Blocked by:** §6 answers. Precedence/pending-effect semantics filled from those answers.

### #246 — Return-date deferral wiring (attempt end + wait + re-entry)
Backend.
**Change:** `fileReport` ends the attempt window (`removed_at` + `removal_reason =
'VEHICLE_UNAVAILABLE'`, ticket → `UNASSIGNED` — the `deferTicket` write-shape); deferral written
from the **authoritative** date under IST-day semantics (Decision 14: same-day/sub-day → no
deferral; future IST day → `deferredUntil` that day; **no horizon validation** — Decision 10; mobile
presets extended to a real date picker since the current ladder caps at ~tomorrow 2 PM);
authoritative-date changes re-write the deferral; re-entry is the existing inclusive `notDeferredOn`
(no new job). Admin holds stay a separate concept per Decision 13 (mechanics per §6 Q1 answer).
**Mobile:** date entry widened; post-submit confirmation text.
**AC:** the approved flow end-to-end incl. return-today (eligible same day), return-tomorrow,
far-future date accepted; VU visit counts as one unsuccessful reached attempt (feeds #244); repeat
absence = new report + new attempt.
**Blocked by:** #241, #245.

### #247 — SLA resume correctness + auto-resume on re-entry
Backend.
**Change:** `resumeSla` checks `slaPauseReason === 'VEHICLE_UNAVAILABLE'` (stop clearing component
pauses — the verified hole); primary SLA auto-resumes when the ticket re-enters eligibility on the
authoritative date (date-driven sweep in the `TierOverrideExpiryService` shape over the existing
`(status, expectedFrom)`-indexed reports, or resume-at-selection — decided by what keeps a single
writer); pause seconds accumulate exactly once; secondary clock untouched (structurally unpausable).
**AC:** paused→date-arrives→resumed with correct accumulated pause; component-paused cycles immune
to VU resume; a ticket is never dispatchable with a frozen primary clock.
**Blocked by:** #246.

### #248 — Return-date priority (Option C) in the canonical sort
Backend.
**Change:** one new comparator key in `canonical-sort.ts`, evaluated **after** Device Bucket, active
only when both tickets are below `CRITICAL_PLUS` (consolidated into one exported constant — two
copies exist today; don't add a third): `returnDueToday` desc, then existing keys 3–5 unchanged
(deterministic tie-breaking preserved). `returnDueToday` computed per run from the authoritative
return date (batched into the selection read — no N+1). SLA buckets untouched; planner bias
untouched (different stage); capacity untouched. Fix the stale "mirrored as a SQL ORDER BY"
docstring — **verified: ordering is TS-only on the dispatch path**.
**AC:** ADR-0017 spec-pin tests extended: CRITICAL+ always outranks the flag; among sub-CRITICAL,
return-due beats normal backlog; a returned ticket that aged into CRITICAL+ sorts by bucket alone.
**Blocked by:** #246.

### #249 — Explicit override of return-date deferral (confirm + reason, no silent bypass)
Backend + Admin touchpoint.
**Current (verified):** `assignTicket` ignores deferral entirely — the only real entry point, since
deferred tickets have no live rows and thus cannot appear in `REASSIGN`/`SPLIT_BATCH`/`SWAP_SE`
selections; those paths get defense-in-depth for the assignTicket-created edge (a confirmed manual
assign leaves `deferredUntil` set today).
**Change:** `assignTicket` on a deferred ticket returns `CONFLICT_DEFERRED` unless `confirm: true` +
`reasonCode` (the exact `CONFLICT_ON_SITE` pattern), audits the override, and clears `deferredUntil`
on confirmed assign (consistent with dispatch `:182`); move paths refuse/warn identically when a
moved ticket carries a future `deferredUntil`. Admin surfaces the confirm dialog where assign
actions exist (Critical Queue, Device Detail).
**Blocked by:** #246.

### #250 — Recommender dry-run seam + future-date parameters
Backend.
**Change:** `runForZone` gains `{ dryRun, targetDate }`; dry-run suppresses **all six** verified
mutations (SUGGESTED recs, UNASSIGNABLE recs, decision traces, the **zone-wide**
`clearFinalizedOrphans` delete, `recordComponentBlock`, `resolveComponentBlock`) and returns the
projection in memory; `targetDate` (distinct from wall-clock `now`) parameterises deferral day,
planner day, `committedDayLoad`, `currentStatusMany`, `modeForZone`, `resolveActiveOverrides`;
preview orchestration never touches the in-flight guard, the advisory lock, or `dispatch_runs`.
Bucket/inactivity remain as-of-last-recompute — carried as an explicit field in the projection so
the UI can state it.
**AC:** a dry run against a live zone provably writes zero rows in all six tables/queues and never
blocks or is blocked by a concurrent real dispatch; a future `now` can no longer create real
future-dated schedules through the preview path.
**Blocked by:** none (#240's planner-date fix lands first in order, not as a hard dep).

### #251 — Admin preview page + stale-token safety + pre-run holds
Backend + Admin (vertical).
**Change:** `GET /api/schedules/preview?date=D` over #250, returning the projected
SE → plant → tickets plan + an HMAC snapshot token (sign/verify + TTL **extracted from
`bulk-unassign.service.ts` into a shared module** — currently private) with `TOKEN_STALE` → fresh
preview; a pre-run hold endpoint for **unassigned** tickets (a bare audited `deferred_until` write —
`DEFER_TICKET` requires a live batch row, so this is the one genuinely new write path), refusing or
explicitly warning on tickets whose deferral derives from a return date (Decision 13 separation);
admin preview page (`BulkUnassignPage`/dispatch-transparency as UI precedent) with the
as-of-recompute caveat displayed; holds visible and revocable. Admin inaction changes nothing —
the 05:00 and manual runs are untouched (verified disjoint writes).
**UI surfaces:** Admin: Scheduler Preview (new). **Reference:** no v2 image exists (new surface —
`BulkUnassignPage` precedent); layout follows the dispatch transparency page.
**Blocked by:** #250 (+#246 only for the return-date-hold refusal branch).

## E. Dependency graph

```text
#240 ─┐
#241 ─┼→ #242 → #244
#241 ──→ #243 (execution gates #242's enablement)
§6 answers → #245 → #246 ─→ #247
                         ├→ #248
                         └→ #249
#250 → #251        (independent branch; #240 sequenced first)
```

Two independent tracks (recycling/Special · preview) plus the VU/return-date track gated on §6.

## F. Development cleanup slice
#243 above — exact approved scope (C1 3,310 · C2 4,684 · C3 1,092), V1–V5 verification, `pg_dump`,
`DEV_CLEANUP` marker, rollback path. **Not executed in this session or the next without the
separate execution approval.**

## G. Known technical risks

1. **Timezone**: until #240 lands, closure-after-dispatch on UTC hosts makes recycling fire a day
   late and after the run it feeds — hence #240 first.
2. **Stale preview**: inherently a projection; token + `TOKEN_STALE` bounds it; bucket-as-of-
   recompute is displayed, not hidden.
3. **Lifecycle**: recycling releases work nightly — after #243's cleanup the steady-state release is
   bounded (~1,357 currently dispatchable at the snapshot); the run ledger counts recycled and
   bucket-less-dropped tickets so nothing moves silently.
4. **Concurrency**: all recycling writes sit inside the existing per-zone advisory lock, set-based
   (the closure file's own lock-window warning); the partial unique remains the cross-connection
   backstop; preview takes no locks at all.
5. **Attempt-count integrity**: derived — no writer, no drift, no double-count; the offline-submit
   loss (write queue has no callers; retries mint new idempotency keys) self-corrects on re-sync and
   is additionally flagged as a mobile defect to file separately if wanted.
6. **Unbounded return dates** (Decision 10, accepted): a never-returning vehicle defers indefinitely
   by design; management approval is the control, and each cycle still increments Special attempts,
   so the ticket surfaces rather than disappears.

## H. Explicit statement

**No application implementation or development was performed.** No source, test, migration,
schema, database row, scheduler behaviour, API, or UI was created or modified. This document and an
INDEX session-log line are the only writes.

---

# Questions Requiring Approval (Decision-12 gate — issue filing paused on these two)

**Q1 — What governs scheduling between the SE's proposal and the managerial decision?**
Decision 9's flow places *Management review* before *Ticket waits*, but Decision 13 makes the latest
VU report "authoritative for the operational return-date proposal". If an unapproved proposal has
**no** scheduling effect, the next 05:00 run re-dispatches a ticket whose vehicle is known absent
(the attempt window already ended at filing). Options:
**(a)** the SE's proposed date takes effect immediately as a *provisional* deferral; approval
confirms it, override rewrites it — review changes the date, never un-waits the ticket;
**(b)** no deferral until a manager decides — undecided tickets re-enter the next run;
**(c)** (b) plus an "undecided VU" hard exclusion from dispatch until decided — a new blocking state.
*Recommendation: (a) — matches the original approved flow ("SE enters date → ticket waits"), wastes
no visit, and managerial control is preserved because the decision can rewrite the date at any time.*
**Blocks:** #245/#246 wiring (where the deferral is written) and their dependents #247–#249.

**Q2 — Cross-role supersession for the return-date decision.**
Verified: the codebase defines **scope** (ZM = own zone; CSM/OH = global) but has **no** cross-role
precedence for per-ticket decisions — every operational path is flat (any in-scope manager, latest
action wins, audited). The one precedence construct that exists is domain-specific: settings, where
the OH can lock/revert (#238). Which model applies when multiple managers act on the same proposed
return date? Options:
**(a)** latest valid in-scope managerial action supersedes, regardless of role — the uniform
per-ticket pattern; full audit preserves who decided what, when;
**(b)** role rank: OH > CSM > ZM — a lower rank cannot supersede a higher rank's decision (new
rank machinery, stored decider rank, refusal paths);
**(c)** latest-wins plus an OH/CSM lock on a decided date (per-ticket import of the settings-lock
pattern; the most new machinery).
*Recommendation: (a) — it is the codebase's uniform per-ticket model, needs no invented machinery,
and the audit trail (decider, role, timestamp, reason, full history) provides the accountability;
(b)/(c) are buildable if the business wants rank, but they are inventions relative to current code.*
**Blocks:** #245's approve/override semantics and its dependents.

**Everything else is fully determined.** On these two answers, the twelve issues above are filed
verbatim (`240`–`251`), INDEX updated, and the session stops again at the implementation-approval
gate.
