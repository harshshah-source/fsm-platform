# Handoff — Business-rule correction: activity-ping staleness is NOT a Hard Filter (2026-06-22)

> **ARCHIVED 2026-07-12 — consumed session handoff.** Current state lives in `docs/SYSTEM-STATE-2026-07.md`; work tracking in `.scratch/fsm-platform-v1/INDEX.md`. Historical record only.
## What changed and why

The Recommender Hard Filter carried an intra-day **15-min `last_activity_at` staleness drop**
(`HEARTBEAT_STALE`). That **violates current CONTEXT.md authority**:

- **§3:** "SE activity-ping staleness is *not* a Hard Filter — `last_activity_at` is visibility/audit
  only and never removes a candidate."
- **§16:** "the prior 15-min freshness filter is removed — unreachability is handled by the
  Acceptance Timeout + reroute."
- **Flagged ambiguity (revised 2026-06-09):** explicitly removes the filter.

The filter originated in **ADR-0016 / ADR-0024**, which are *historical-only* per the authority order
(`CONTEXT.md → PRD → workflow → backend design → ADRs`). CONTEXT's 2026-06-09 revision supersedes the
Hard Filter portion of both ADRs. ADR-0024's *action-triggered ping* mechanism and the *1h `OFFLINE`
display label* remain valid — only the candidate-gating consumer was wrong.

**Field consequence of the bug:** on the intra-day CRITICAL/HIGH_CRITICAL insertion path, an SE
working offline / in a no-network field area (or any SE with a null `last_activity_at`, which resolved
to `NEGATIVE_INFINITY` → always dropped) was silently removed from candidate scoring — routing urgent
work away from the nearest SE. "OFFLINE ≠ not working" (CONTEXT §SE Activity Status).

## Code changes (strict TDD: RED → GREEN → REFACTOR)

- `apps/backend/test/hard-filters.spec.ts` — inverted the staleness test to prove stale/no-ping SEs
  **stay candidates**; removed the `intraday` param and `HEARTBEAT_STALE` assertion (RED).
- `apps/backend/src/recommender/hard-filters.ts` — removed `HEARTBEAT_STALE` reason,
  `intraday`/`activityStalenessMs` options, `ACTIVITY_STALENESS_MS`, `lastActivityAt` from the
  readiness shape, and the drop branch. `applyHardFilters(candidates)` is now a pure boolean/enum
  filter (GREEN).
- `apps/backend/src/recommender/recommender.service.ts` — `runForZone` opts narrowed to `{ now? }`;
  `intraday` plumbing removed; `lastActivityAt` dropped from the readiness build and the
  `engineerCapacity` select.

## Docs corrected (REFACTOR)

- `docs/adr/0016-…md`, `docs/adr/0024-…md` — Status annotated "Hard Filter portion superseded by
  CONTEXT §3/§16 (2026-06-09)"; offline-handling rewritten to timeout-reroute.
- `docs/adr/0003-…md` — removed "SE heartbeat stale" from the Hard Filter set.
- `.scratch/fsm-platform-v1/issues/10-…md` — prose corrected.
- `.scratch/fsm-platform-v1/issues/30-…md` — **ACs rewritten**: the old AC#2 ("15-min `last_activity_at`
  Hard Filter excludes stale SEs") and AC#5 ("activity within 15 min") mandated the removed filter.
  Now: staleness is never a candidate filter; manual-assignment modal lists `SE_AVAILABILITY = AVAILABLE`.
- `docs/progress/10-…md` — AC#2 + slice-3 report annotated.

## Backlog-owner note (needs awareness, not blocking)

Issue 30 was authored from the old ADRs. Its ACs were rewritten to match CONTEXT §16. If anyone still
wants an activity-based pre-filter, that is a **CONTEXT change** and must be raised against CONTEXT.md
first — do not re-introduce it in code.

## Verify

```
cd apps/backend && node node_modules/vitest/vitest.mjs run    # full suite
node node_modules/typescript/bin/tsc --noEmit                  # clean
```
