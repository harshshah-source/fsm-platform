# 248 — Return-date priority (Option C): one new canonical-sort key below CRITICAL+

Status: done (2026-08-19, `4a54a3f`)
Type: AFK · Backend

Filed 2026-08-19. Approved Decision 15: Critical/Severe → Return-Date Priority → normal backlog.
SLA buckets untouched; no second priority system; fits the existing comparator.

## What to build

### Current behaviour (verified)

`recommender/canonical-sort.ts:52-67` — Company Tier ↓ → Device Bucket ↓ → Company Priority Rank ↑ →
Oldest Inactive ↑ → Device ID ↑; ADR-0017 spec-pinned. **The ordering is TypeScript-only on the
dispatch path**: the recommender's live query has no `orderBy` (`recommender.service.ts:133-179`;
sort applied once at `:216`). The docstring's claim that "the live query mirrors it as a stable SQL
ORDER BY" is stale — no such mirror exists (the SQL rank expressions in `device.service.ts` /
`ticket-query.service.ts` are unrelated display sorts). `CRITICAL_PLUS` exists twice
(`cross-zone-escalation.service.ts:18`, `dashboard.service.ts:348-353`).

### Required change

1. **Comparator:** insert one key after Device Bucket, evaluated **only when both tickets' buckets
   are below CRITICAL_PLUS**: `returnDueToday` (true first). Keys 3–5 unchanged after it —
   tie-breaking stays deterministic (a boolean introduces no ties the existing keys don't already
   break). Because the bucket compares first, CRITICAL+ work always outranks the flag; a returning
   ticket that itself aged into CRITICAL+ sorts by bucket alone and never consults the key — both
   are exactly Option C.
2. **`CRITICAL_PLUS`:** consolidate into one exported constant (in `sla-bands`/`canonical-sort`
   territory); cross-zone and dashboard import it; do not create a third copy.
3. **`returnDueToday` input:** computed per run, never stored — true when the ticket has an OPEN
   vehicle-unavailability report whose authoritative `expected_from` falls on **today's IST day or
   earlier** (i.e. it re-entered on/after its return date and has not yet been dispatched; dispatch
   clears the state naturally because assignment removes it from the selectable set, and the report
   resolves per #245/#246 rules). Fetched as one batched join/aggregate in the recommender's
   selection read — no N+1, no per-ticket query.
4. **Docstring:** fix the stale SQL-mirror claim in `canonical-sort.ts` so nobody "restores" a
   divergent SQL copy.
5. **Untouched, pinned:** `sla_bucket` derivation and every consumer; planner bias (SE-selection
   stage, unrelated); capacity accounting; `compareInstallCandidates`.

### Existing code to reuse

`canonical-sort.ts` + its ADR-0017 spec-pin tests (`canonical-sort.spec.ts`,
`tiers-spec-pin.spec.ts` — extended, not replaced); `CRITICAL_PLUS` (consolidated); #245/#246's
authoritative date + `@@index([status, expectedFrom])`.

### Tests

- Comparator unit matrix: CRITICAL+ vs return-due (bucket wins); sub-CRITICAL return-due vs
  sub-CRITICAL normal (flag wins); two return-due tickets (rank/age/deviceId break the tie);
  returning ticket aged into CRITICAL+ (key never consulted); Special has no ordering effect
  (cross-pin with #244 AC6).
- e2e: a zone with mixed backlog — the produced `processingRank` order matches Option C; the
  batched flag fetch adds no per-ticket queries (query-count pin).
- ADR-0017 pins still green (existing key order unchanged around the insertion).

### Risks / rollback

Pure ordering change, one file + one fetch; revert restores prior order. The one semantic caution —
comparator/SQL divergence — is void (no SQL mirror exists) and the docstring fix keeps it void.

## Acceptance criteria

- [x] AC1 — Among sub-CRITICAL work, return-due-today tickets sort ahead of normal backlog; they
      never outrank CRITICAL_PLUS buckets (pinned both ways).
      > **Reading clarified in build (2026-08-19).** "Among sub-CRITICAL work" means *within a shared
      > sub-CRITICAL bucket*, which is what key 2b's placement — after Device Bucket — produces:
      > step 2 returns whenever the buckets differ, so a return-due WARNING still sorts behind a
      > normal RISK. That is the authoritative design
      > (`docs/audits/four-decisions-readiness-2026-08-18.md` §9: "Because step 2 already ran, a
      > CRITICAL+ ticket has been ordered ahead before 2b is consulted"). Reading AC1 as a
      > cross-bucket tier would require evaluating the key *before* Device Bucket and would change
      > dispatch order materially; it is deliberately not built that way, and both directions are
      > pinned in `return-date-priority.spec.ts`.
- [x] AC2 — `returnDueToday` derives from the authoritative report date at run time; no stored
      flag, no schema change, no N+1.
- [x] AC3 — One `CRITICAL_PLUS` export; cross-zone and dashboard consume it; grep proves no other
      copy.
- [x] AC4 — `sla_bucket` values, Fleet Uptime, Soft Inactive, and SLA reports are bit-identical
      before/after (no bucket was modified to achieve priority).
- [x] AC5 — Deterministic: same inputs → same order across runs (existing determinism test extended
      over the new key).
- [x] AC6 — The stale SQL-mirror docstring is corrected.

## UI surfaces

n/a (ordering surfaces through existing dispatch transparency traces unchanged)

## Reference

n/a

## Blocked by

#246 (authoritative date + re-entry exist).
