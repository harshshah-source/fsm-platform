# 148 — Business sweeps expire on wall-clock, not telemetry freshness
Status: done 2026-09-03 — slices 1, 2, 4 landed 2026-07-22; slice 3 landed with #358, report docs/progress/358-verification-review-page-completion.md
Type: AFK

> Source: `docs/audits/2026-07-22-full-project-audit.md` §5 B4, re-verified still-open by
> `docs/audits/2026-07-22-adversarial-review-admin-backend.md` §2. Follow-up to
> [#108](./108-business-sweep-scheduler.md).

## Background

`BUSINESS_SWEEPS_ENABLED="true"` (`apps/backend/.env:38`) runs the verification sweep and the
install-activation sweep every 5 minutes. Both resolve a 24-hour window against
`raw_device_snapshots`.

`INGESTION_SCHEDULER_ENABLED="false"` (`apps/backend/.env:18`) means **nothing automatically writes
new pings** — telemetry freshness depends entirely on a human triggering the pipeline.

## Problem

A verification window expires on **wall-clock elapsed time alone**. If ingestion is paused, no new
pings arrive, and every submission ages out into an **irreversible** `FAILED_VERIFICATION` —
regardless of whether the SE actually fixed the device. `PRE_VERIFICATION` inventory is rolled back
with it.

## Root Cause

The sweeps depend on a freshness guarantee owned by a **different, independently-switchable**
subsystem, and the dependency is enforced nowhere.

The repository already documents this exact coupling class for ingestion↔partition-maintenance
(INDEX activation checklist §2, *"treat the two as one switch"*) — and enforces neither. The sweeps
are armed; their data source is not.

## Evidence

`apps/backend/src/verification/verification.service.ts:182` (re-read 2026-07-22):

```ts
const expired = now.getTime() - run.startedAt.getTime() >= TWENTY_FOUR_HOURS_MS;
```

Wall-clock only. **No `dataAsOf` / `data_as_of` reader exists anywhere under `verification/` or
`install-lifecycle/`** — the audit's sweep found all 7 readers of that watermark live in `exports/`
and `ingestion/`.

- Phase-1 ping search: `verification.service.ts:158-162` (`gt: submittedAt`).
- Failure write: `:186-187` → `FAILED_VERIFICATION`.
- Same 24-hour window on the install side: `install-lifecycle.service.ts:30,181,211-216` →
  `FAILED_ACTIVATION`.
- Sweep cadence + master switches: `business-sweep-scheduler.service.ts:25-36` (code defaults OFF —
  the `.env` override is what makes this live).

Live `.env` state, verified 2026-07-22:

```
INGESTION_SCHEDULER_ENABLED="false"     ← nothing writes pings automatically
PARTITION_MAINTENANCE_ENABLED="false"
BUSINESS_SWEEPS_ENABLED="true"          ← sweeps fire every 5 minutes
```

**Current exposure is 0** — the prior audit measured 0 troubleshooting submissions and 0 verification
runs on this DB, so nothing can currently mis-fail (*not re-probed this session*). That makes this
**armed, not safe**: the first real SE submission during an ingestion pause is the failure.

## Current Behaviour

The sweeps expire windows on wall-clock against a telemetry table that may be frozen. A device the SE
genuinely repaired can be marked `FAILED_VERIFICATION` — an irreversible terminal state — purely
because nobody triggered the ingestion pipeline that day, and its `PRE_VERIFICATION` inventory is
rolled back with it.

## Expected Behaviour

A verification window may **not** expire while the telemetry watermark
(`snapshot_runs.data_as_of`) has not advanced past the submission time. Same precondition on
install-activation expiry.

This is strictly more conservative than today's behaviour — the change can only ever *delay* a failure
verdict, never cause one — and it requires **no ops discipline** to be correct.

## What to build

A staleness precondition on both sweeps, plus observability for the tail risk the precondition
introduces (a window that never expires because the watermark never advances), plus the documented
switch-pair coupling.

> **Explicitly rejected design:** auto-expiring after a grace period when the watermark is stale. That
> re-creates the exact bug this issue closes, with a longer fuse. A stalled window must be **surfaced**,
> not silently resolved.

## Acceptance criteria

- [x] A verification window does not expire while `snapshot_runs.data_as_of` has not advanced past the run's `submittedAt`.
- [x] The same precondition guards install-activation expiry (`FAILED_ACTIVATION`).
- [x] With **fresh** telemetry, expiry behaviour is **unchanged** — pinned by regression assertions that pass before any source change.
- [x] No code path can write `FAILED_VERIFICATION` or `FAILED_ACTIVATION` on stale telemetry.
- [x] A stalled window is **observable** — rather than failing silently. **Surface changed by #358,
      deliberately:** the indicator landed on the **Verification Review page** (a per-row
      "stalled — telemetry as of …" chip in place of "overdue", plus a page banner counting them),
      not on `/build-health`. `docs/module-gaps/IMPLEMENTATION-PLAN.md` §4 re-homed it there because
      the reader who would otherwise draw the wrong conclusion — "overdue" reads as *the engineer
      missed a deadline* when the truth is *the pipeline stalled* — is standing on that page. A
      platform-wide count on `/build-health` remains worth adding for an ops reader and is listed as
      a follow-up in `docs/progress/358-verification-review-page-completion.md`.
- [x] The ingestion↔sweeps coupling is documented as a **switch pair** in the INDEX activation checklist, matching the existing ingestion↔partition-maintenance precedent.
- [x] Full backend suite green — **287 files passed / 3 skipped (290); 1176 passed / 5 skipped (1181); exit 0; 494s** — re-run after slices 1+2, +4 tests vs the 1172 baseline.

## TDD Strategy

**Strict TDD**, and this issue has an unusual property worth honouring: **two of the three Slice-1
assertions pin *existing* behaviour and must pass immediately.** They are written first so that the
one genuinely new assertion is provably the only change.

**Slice 1 RED — `verification-staleness.e2e-spec.ts`, three cases:**

| Case | Setup | Expected | Today |
|---|---|---|---|
| (a) | `data_as_of` **behind** `submittedAt`, 25 h elapsed | status **unchanged** | **FAILS** (new) |
| (b) | `data_as_of` **ahead**, 25 h elapsed | `FAILED_VERIFICATION` | passes (pins current) |
| (c) | `data_as_of` ahead, 23 h elapsed | unchanged | passes (pins current) |

- **What fails today:** **(a) only.**
- **Why it fails:** `verification.service.ts:182` compares wall-clock elapsed time only; nothing under
  `verification/` reads `data_as_of`, so freshness is invisible to the expiry decision.
- **What makes it pass:** an additional guard — expire only when
  `snapshot_runs.data_as_of > submittedAt`. Because this **narrows** the expiry condition, cases (b)
  and (c) are structurally protected.
- **If (b) or (c) fails on first run, the harness is wrong** and must be fixed before touching any
  source file. That is the whole reason for writing them first.

**Slice 2** mirrors the same three-case shape on install-activation.

## Implementation Slices

### Slice 1 — Verification staleness precondition

- **Objective:** a verification window cannot expire on stale telemetry.
- **Files:** `apps/backend/src/verification/verification.service.ts`
- **Services:** `verification`; reads the `snapshot_runs.data_as_of` watermark.
- **Database:** none — the watermark already exists and has 7 readers elsewhere.
- **Frontend:** none.
- **Tests:** the three-case table above.
- **Acceptance criteria:** AC 1, 3, 4 (verification half).
- **Definition of Done:** verification suite green; two of three assertions demonstrably pinned
  existing behaviour.

### Slice 2 — Install-activation staleness precondition

- **Objective:** the same guarantee on the install side.
- **Files:** `apps/backend/src/install-lifecycle/install-lifecycle.service.ts`
- **Services:** `install-lifecycle`.
- **Database / Frontend:** none.
- **Tests:** the three-case shape mirrored for `FAILED_ACTIVATION`.
- **Acceptance criteria:** AC 2, 3, 4 (install half).
- **Definition of Done:** install-lifecycle suite green.

### Slice 3 — Stall observability — **landed 2026-09-03 in #358**

- **Objective:** the tail risk introduced by the precondition is visible, not silent.
- **Files (as built):** `apps/backend/src/verification/verification-query.service.ts` (`stalled` +
  `telemetryAsOf` on the review row, mirroring `windowExpired`'s own guard) and
  `apps/admin/src/pages/verification/VerificationReviewPage.tsx`. **Not** `BuildHealthPage.tsx` — see
  the AC note above for why the surface moved.
- **Tests:** `apps/backend/test/verification-staleness.e2e-spec.ts` (three `#358` cases beside the
  three original ones) and `apps/admin/test/verification-review.test.tsx` (a stalled row and an
  overdue row with the same past deadline, differing only in `stalled`).
- **Acceptance criteria:** AC 5.
- **Definition of Done:** parity gate satisfied in-slice; both suites green.

### Slice 4 — Document the switch pair

- **Objective:** the coupling is recorded where an operator will read it.
- **Files:** `.scratch/fsm-platform-v1/INDEX.md` (activation checklist).
- **Acceptance criteria:** AC 6.
- **Definition of Done:** coupling recorded beside the partition-maintenance precedent.

Slices 1 and 2 are independently mergeable and each strictly reduce risk.

## Rollback Plan

Each precondition is a single guard clause in one service; reverting restores current behaviour
exactly, with no data migration and no schema change. Slice 3 is additive UI over an existing page.
Slice 4 is documentation.

## Dependencies

None technically. **Coupled to [#149](./149-system-state-ops-switch-truth.md)** — `SYSTEM-STATE:67`
currently asserts *"Nothing runs unattended today"*, which conceals precisely this risk. #149 should
land first or alongside so that anyone reading current state sees why this issue matters.

## Estimated Effort

0.5–1 day. **Priority: P1** — the only carried-over finding that is **armed right now**. Exposure is 0
only because no SE has submitted a troubleshoot form yet; the failure mode is irreversible when it
does occur.

## UI surfaces

Admin: **Build Health / integration-health page** (`/build-health`, built by #131) — additive stalled-
window indicator. No new page, no new route, no role change.
Mobile: n/a.

## Reference

n/a — `/build-health` was added by #131 as a routed page with no v2-reference image; follow the
existing page's established composition rather than a reference image.

## Blocked by
None. (Sequence [#149](./149-system-state-ops-switch-truth.md) first for context.)
