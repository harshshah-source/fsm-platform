# #311 — The override preview reads the conflict source the commit gates on

**Finding:** CB-4 (`audit/2026-09-01-scheduler-engine-forensics.md` §6) · **Wave 3** · P2
**Landed:** 2026-09-03 · branch `feat/autoplant-integration`
**Issue:** [`.scratch/fsm-platform-v1/issues/311-override-preview-real-onsite-conflicts.md`](../../.scratch/fsm-platform-v1/issues/311-override-preview-real-onsite-conflicts.md)

---

## What was wrong

`OverrideProjectionService.conflictsFor` returned `onSite: []` unconditionally, under a comment saying
`soft_states` "does not exist yet". It did — `PrismaSoftStateConflictPort` was implemented, bound in the
same module, and `OverrideService.override` was already gating on it.

So `POST /batches/:id/override/preview` reported a clean move for a batch whose engineer was standing
at the plant, and the identical confirm body came back `CONFLICT_ON_SITE`. That is the exact drift this
file's own header calls *"worse than no preview, because the operator would have trusted it"* — arriving
through a comment that had simply outlived its premise.

## The fix

The projection injects `SOFT_STATE_CONFLICT` — `@Optional()` with the same `NoConflictSoftStatePort`
fallback as `OverrideService`, deliberately — and `conflictsFor` asks
`activeOnSiteTicketIds(ticketIds)`.

Two things are load-bearing:

- **The same object, not the same table.** Reading `soft_states` here with its own predicate would be a
  second copy of the rule that VIEWED and resolved states do not count — a second thing to drift. The
  port is the rule.
- **The same fallback on both classes.** If one falls back to `NoConflict` and the other does not, the
  drift reopens in the shape of a hand-constructed instance. That cuts both ways and is the forensic's
  A6 note: a fixture that omits the port asserts the seam's silence, not this behaviour, so the spec
  binds the real adapter to *both* services.

The stale docblock is corrected in place.

## Verification

- `test/override-preview-onsite-parity.e2e-spec.ts` — 3 cases. Red first: preview `[]` against a
  commit answering `CONFLICT_ON_SITE` with `[onSiteTicket]`.
- **The parity is asserted by driving both paths over one fixture**, not by comparing each to a list
  written in the spec: a spec that spells the expected set twice goes on agreeing with itself while the
  two code paths diverge, which is the failure mode under repair.
- A second case resolves the soft state and asserts both paths go quiet — the port's own rule reaching
  the preview intact, which reading the table directly would not have guaranteed.
- **AC2 (#289's write-free contract) is re-asserted after the change**, counting rows across
  `work_schedules`, `plant_batch_assignments`, `batch_assignment_tickets`, `soft_states`, `audit_logs`
  and the outbox before and after a projection. Reading a second table must not have cost the preview
  its posture.
- Targeted regression: `override-impact-preview`, `batch-override-onsite`, `override-schedule-live`,
  `batch-override-swap-split` — 21/21.
- `npx tsc --noEmit` clean. No DB, no API shape change (`conflicts.onSite` always existed and
  `OverrideImpactPanel` already renders it), no migration.

## Acceptance criteria

- [x] **AC1** — preview and commit can never disagree on the ON_SITE conflict set (same object, same
      question, one fallback rule).
- [x] **AC2** — the preview still writes nothing.

`UI surfaces: Admin OverrideImpactPanel` — existing surface, data correctness only, so no new UI work
and the parity gate has nothing outstanding.
