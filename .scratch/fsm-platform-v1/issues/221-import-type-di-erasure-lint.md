# 221 — Lint the `import type` DI-erasure class, and review the 13 `@Optional()` parameters

Status: ready-for-agent
Type: AFK · Backend tooling
Filed: 2026-08-07
Origin: [#218](./218-lifecycle-drift-detection.md) root cause — the second occurrence of this defect
class after `f813b39` (#217)

## Problem

A constructor parameter whose type is imported with `import type` loses its runtime metadata:
TypeScript erases the import and emits `Object` for `design:paramtypes`, so Nest cannot resolve the
dependency. With `@Optional()` the failure is **silent** — the dependency is `undefined` and the
feature no-ops. Without `@Optional()` it throws at boot, which is loud and therefore far less
dangerous.

This has now bitten twice:

- `f813b39` — `OpsExplorerQueryDto` import-type erasure "broke every real query" (#217)
- **#218** — `DeviceDepartureService` + `PlantEligibleFloatingSeService`, dead for 27 consecutive syncs

## Audit already performed (2026-08-07)

747 `.ts` files across `apps/` scanned for constructor parameters typed by an `import type` symbol
with no `@Inject()` token.

**Exactly 2 silent instances**, both in `master-sync.service.ts`, both addressed by #218b.

Ten other hits verified as false positives: mobile error-class constructors (no Nest DI), test
doubles (never DI-resolved), and `SnapshotIngestionWorker` (factory-provided with an explicit
`inject:` array, so reflection metadata is never consulted).

**The class has not spread — but nothing prevents its return.**

## Proposed

1. **A lint rule.** Either `@typescript-eslint/consistent-type-imports` with
   `disallowTypeAnnotations`, or a targeted rule banning `import type` for any symbol used as a
   constructor parameter type. The narrower rule is preferable — `import type` is correct and
   desirable everywhere else in the codebase, and a blanket ban would be a large, noisy change.
2. **Review the 13 `@Optional()` parameters across 10 backend files.** Each is a place where a wiring
   mistake degrades silently rather than failing at boot. None is a defect today, but `@Optional()`
   is the amplifier that turned a resolution failure into a fortnight of silence. Each should carry
   either an `@Inject()` token or a one-line justification for why silent absence is acceptable.

Files with `@Optional()`: `auth.service.ts`, `master-sync.service.ts`, `notification.service.ts`,
`prisma.service.ts`, `soft-inactive-count.service.ts`, `batch-assignment.service.ts`,
`override.service.ts`, `install-lifecycle.service.ts`, `non-operational.service.ts`,
`recovery.service.ts`.

## Acceptance

- The rule fails CI on a deliberate reintroduction (verified, not assumed).
- Every surviving `@Optional()` carries an `@Inject()` token or a justification comment.
