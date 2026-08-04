# 205 — Make contract drift a compile error: shared enums, exhaustive maps, parity test

Status: ready-for-agent
Type: AFK · Shared + Backend + Admin + Mobile
Parent: [#197](./197-mobile-pilot-readiness-remediation-epic.md) · Filed 2026-08-04
Coordinates with: [#169](./169-se-api-contract-freeze.md) item 2 (which owns moving SE response
types + the error-code union into `@fsm/shared`; this issue owns the *enum* half and the
exhaustiveness mechanism)

## Root cause

`@fsm/shared` is the intended single source of contract truth, but the enums that matter most were
never moved into it, and the maps that consume them are typed `Record<string, …>` — so a missing
member is invisible to the compiler and only shows up as a wrong label or a silent fallback at
runtime. There is no parity test anywhere. Every value set happens to agree today; nothing makes that
survive the next change.

**This slice is a class-of-defect fix.** The point is not to correct today's six divergences but to
make the seventh impossible to introduce silently.

## Findings closed

Audit 2: **B2** (`FAILED_ACTIVATION` missing from mobile's badge map), **B3** (notification types),
**B4** (`@Roles(...string[])`), **B6** (convention-only sync, no parity test), **B9**
(`TicketStatus`/`WorkType` absent from shared), **D8** (`NonOpState` admin type lies).

## Evidence — verified 2026-08-04

- **Absent from `@fsm/shared` entirely:** `TicketStatus` (17 values, `generated/prisma/enums.ts:431-449`)
  and `WorkType` (3 values) — `MeTicketRow.status`/`.workType` are bare `string`
  (`packages/shared/src/index.ts:85-86`). `WorkType` is hand-copied in **six** places with no drift
  *yet*; `TicketStatus` in four.
- **Notification `type` is a free string on producer, contract and consumer.** 15 distinct strings
  are produced (`intraday-insertion.service.ts:212,326,418,505,521`;
  `cross-zone-escalation.service.ts:214,303,324`; `day-plan-notifier.ts:63,73`;
  `bulk-unassign.service.ts:360`; `install-notifier.ts:54,66`; `recovery-notifier.ts:78,95`); exactly
  **one** is matched anywhere (`SeTabShell.tsx:50`). Renaming a producer compiles clean and silently
  kills the mobile ghost-assignment toast. Highest-risk stringly-typed seam in the repo.
- **Exhaustiveness holes that a typed map would have caught:**
  `VerificationScreen.tsx:25-30` is `Record<string, …>` and omits `FAILED_ACTIVATION` (a real
  `VerifyOutcome`, `shared:274`) → falls back to "Verification pending" with an info-blue pill.
  *Latent today* — `TicketDetailScreen.tsx:188` gates the screen on `verification-pending`, which
  install tickets never enter — but it is the exact shape of bug this slice prevents.
  `apps/admin/src/api/nonOp.ts:10` types `NonOpState` as 3 of the schema's 7 values
  (`schema.prisma:1758-1766`), so `ACTIVE`/`EXPIRED`/`UNMARKED` rows are a type-level lie.
- **Authorization is unchecked strings:** `roles.decorator.ts:6` — `Roles = (...roles: string[])`;
  `role.guard.ts:21` — `string[] | undefined`. A typo silently 403s everyone. Six backend files
  re-hand-copy the same manager-role array untyped.
- **Copy-instead-of-derive, nine lines apart:** `media.controller.ts:18` imports
  `MEDIA_SLOTS_BY_KIND` from shared, then `:27` hand-copies its key set as `VALID_KINDS`.
- **No parity test exists** — zero test files reference `ROLES`, `SLA_BANDS`, or
  `MEDIA_SLOTS_BY_KIND`.
- One good precedent to copy: `engineer-admin.service.ts:15` derives its set with
  `new Set(Object.values($Enums.CoverageType))` — the only site in the repo that derives rather than
  copies.

## Scope

**In:** move `TicketStatus`, `WorkType` and a `NotificationType` union into `@fsm/shared`; type the
label/tone maps in both clients as exhaustive `Record<Enum, …>` so a missing member fails the build;
type `@Roles` as `Role[]`; fix `NonOpState`; derive `VALID_KINDS` instead of copying; add a parity
test that fails when a Prisma enum and its `@fsm/shared` counterpart diverge.

**Out:** the SE response types and the 54-code error union — **#169 item 2 owns those**; coordinate,
do not duplicate. `actionTakenCategory`'s vocabulary — **#169 item 7 + #174**. Re-labelling anything
(that is #208; this slice changes *types*, not user-visible strings). De-duplicating admin's 13+
hand-copied contract types is desirable but is a large mechanical sweep — record it as follow-on
unless it falls out cheaply.

## Acceptance criteria

- [ ] `TicketStatus`, `WorkType` and `NotificationType` are exported from `@fsm/shared` and imported
      at their producer and consumer sites
- [ ] Deleting a member from any of those unions produces a **compile error** in both apps — proven
      by trying it once during development and recording the result
- [ ] `VerificationScreen`'s badge map and admin's `STATUS_TONE` are exhaustive over their enums
- [ ] `@Roles` accepts only `Role` values; the six duplicated manager-role arrays reference one
      shared constant
- [ ] `NonOpState` in admin matches the schema's 7 values
- [ ] A parity test asserts every relevant Prisma enum equals its `@fsm/shared` counterpart, and
      fails loudly on divergence. **Cheap and the highest-leverage item here**
- [ ] Every value set that agrees today still agrees after the change (no behaviour change intended)

## Verification

```bash
cd apps/backend && node scripts/run-tests.mjs test/<new parity spec>
pnpm -w exec tsc --noEmit          # both apps must stay clean
cd apps/mobile && npx jest
cd apps/admin && npx vitest run
```

## Risk if deferred

Nothing breaks today; that is precisely the problem. The next rename of a notification type, the next
`TicketStatus` addition, or the next `VerifyOutcome` member lands green in CI and fails silently in
the field — exactly how `FAILED_ACTIVATION` already went missing from a badge map nobody noticed.
With 15 notification types flowing to one matcher, that seam is one refactor away from breaking a
user-visible feature with no test to catch it.

## Size estimate

M. Mechanical but wide; the parity test is small and should land first so the rest is verified by it.
