# 317 — Shared scheduling enums + cross-layer parity pins
Status: ready-for-agent
Type: AFK
Wave: 3 · Severity: P3 · Finding: AR-10, `audit/2026-09-01-scheduler-engine-forensics.md` §7

## Problem

~18 admin files re-spell backend status vocabularies as string literals — `TicketActionStatus`,
`DispatchRunStatus`, `IntradayInsertionStatus`, `HardFilterReason`, `CoverageType`, `ChangeKind`,
`AssignBatchSkipReason`, `PoolEmptyReason`, `TodayRecovery.state` — with no shared package
(`@fsm/shared` exports `ComponentRequestStatus`/`VoucherStatus` only). Drift is manual-sweep-only
(#268's `ASSIGNED_DIRECT` was hand-synced). Most consumers are defensive; one is not:
`RecoveryNotice` (`TodaysDispatchPage.tsx:730-739`) renders any **unknown** recovery state as the
EXPIRED sentence — a false claim the day a state is added.

## Root cause

The shared-types package predates the scheduling surface; each page hand-copied the literals.

## Affected files / symbols

- `packages/shared` — export the scheduling vocabularies (source of truth stays the backend
  definitions; the shared package re-exports or mirrors with a parity pin against the backend)
- Admin consumers: `IntradayQueuePage.tsx:75-110`, `SchedulesPage.tsx:34-39`,
  `Inspector.tsx:612`, `WorkCard.tsx:235`, `TodaysDispatchPage.tsx:730-739`, and the remaining
  re-spelling sites (sweep by grep)
- One parity spec on each side

## Intended behavior after fix

- One definition per vocabulary, imported by both apps; a backend member addition breaks a test,
  not a screen.
- Every UI map over these vocabularies has an explicit unknown-member fallback that renders
  *absent/neutral*, never a specific claim — `RecoveryNotice` fixed to that rule (the same rule
  an unrecorded `addSource` already follows).

## Implementation boundaries

- Types + maps only; zero behavior change for known members (RTL snapshots pin it). Prisma enums
  stay canonical where they exist; TEXT-column vocabularies stay in their backend files with the
  shared package deriving from them — do not move a backend source of truth into the frontend
  package.

## DB / API / frontend impact

None at runtime; build-time type surface only.

## Dependencies

None. Best landed after the Wave-2 backend slices settle any vocabulary they touch (#308).

## Regression risks

- A mirror that drifts is worse than no mirror — the parity pin (backend members ⊆ shared
  members, asserted in a backend spec) is the load-bearing part, not the re-export.

## Tests required

- Backend parity spec per vocabulary; admin spec that every map handles an unknown member with
  the neutral fallback; existing console/queue suites green.

## Acceptance criteria

- [ ] AC1 — no admin file spells a scheduling status literal that isn't imported.
- [ ] AC2 — an added backend member fails a test before it can mis-render.
- [ ] AC3 — unknown members render as absent/neutral everywhere (RecoveryNotice included).

## UI surfaces

Admin: existing pages, no visual change for known states.

## Reference

n/a.

## Blocked by

308 (soft — vocabulary stability)
