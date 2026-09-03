# 324 — Master-sync per-row degradation + dead resume-cursor machinery removal
Status: done (2026-09-03) - see `docs/progress/324-master-sync-row-degradation-dead-machinery.md`
Type: AFK
Wave: 4 · Severity: P3 · Findings: F13 + F4 (forensic report §3 ingestion segment),
`audit/2026-09-01-scheduler-engine-forensics.md`

## Problem
1. **F13:** the masters path is all-or-nothing on dirty identity fields —
   `master-sync.service.ts:249` (`BigInt(String(c.company_id).trim())`) and the `.trim()` calls
   on name/PK columns in `master-mapping.ts` (:206-208, :233-235, :279-281, :314-321) throw on a
   null/dirty value and fail the **entire** sync run, unlike the snapshot path's per-row
   skip-and-count. "Authoritative PKs can't be dirty" is an assumption, not a guard.
2. **F4:** cross-run resume-cursor machinery is dead in production —
   `SnapshotRunService.lastResumeCursor` (`snapshot-run.service.ts:90`) has zero production
   callers, the worker persists a PARTIAL resume floor nothing reads
   (`snapshot-ingestion.worker.ts:125-139`), the production reader is deliberately
   no-cross-run-resume (`autoplant-source-reader.ts:23-27`), and `SnapshotRun.chunkStats`
   (`schema.prisma:1650`) is never written. Misleading to operators and future readers.

## Root cause
The masters path predates the snapshot path's rejection accounting; the resume machinery outlived
the design that needed it.

## Affected files / symbols
`master-sync.service.ts`, `master-mapping.ts` (per-row degrade + reject counters);
`snapshot-run.service.ts`, `snapshot-ingestion.worker.ts`, `schema.prisma` comment /
`test/snapshot-partial-cursor.e2e-spec.ts` (removal or an explicit "test-harness-only" marking).

## Intended behavior after fix
- A master row with an unparseable identity field is skipped and counted with a reason; the run
  completes over the rest (mirror of #299's posture on the telemetry side).
- The resume-cursor path is either removed (cursor write, `lastResumeCursor`, the test-only
  reader support, `chunkStats` field comment corrected) or explicitly labeled test-harness-only
  in every location — no half-alive machinery. Removal is the default; keep only what a recorded
  consumer needs.

## Implementation boundaries
No scan-shape change, no new resume feature, no masters schema change.

## DB / API / frontend impact
Run counters additive; possibly one dropped dead column usage (comment-level; no migration
required if the column merely stops being written — record the decision).

## Dependencies
After #299/#323 (same module — sequence).

## Regression risks
Skipping a dirty master row leaves its mirror row stale rather than failing loudly — the counter
plus #300's surfacing is the visibility; state this trade in the code comment.

## Tests required
Masters e2e: one dirty company/plant/vehicle row → run SUCCESS with named rejects, siblings
synced. Removal: grep-level absence assertions; `snapshot-partial-cursor` spec updated or
deleted with its rationale.

## Acceptance criteria
- [x] AC1 — one dirty source row cannot fail a masters run.
- [x] AC2 — no persisted value exists that nothing consumes (or it is labeled at every site).

## UI surfaces
n/a.

## Reference
n/a.

## Blocked by
299, 323 (module sequence)
