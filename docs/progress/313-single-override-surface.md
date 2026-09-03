# #313 — One override implementation, and the silent failures it was hiding

**Findings:** AR-4 + CB-7 (`audit/2026-09-01-scheduler-engine-forensics.md` §6/§7) · **Wave 3** · P2
**Landed:** 2026-09-03 · branch `feat/autoplant-integration`
**Issue:** [`.scratch/fsm-platform-v1/issues/313-single-override-surface.md`](../../.scratch/fsm-platform-v1/issues/313-single-override-surface.md)

---

## What was wrong

`ActionsBand.tsx`'s docblock has claimed since the Console landed that Schedule Detail's override
controls were *"moved here … not copied: one implementation, so #282 R5 holds."* They were copied.
`ScheduleDetailPage.tsx` carried a full second implementation of Remove / Defer / Reassign / Swap /
Split / Reorder plus its own `useOverridePreview`, and the two forks had diverged exactly as forks do:

- **Failures were silent on the page (CB-7).** `onOverride` re-threw anything that was not a populated
  409, and both commit helpers were `try/finally` with **no catch**. A 500, a 403 or a dropped
  connection produced an unhandled promise rejection, a Confirm that stopped being busy, and **no
  message anywhere** — the operator could not tell a refused write from a successful one.
- **Move to another day did not exist there**, months after the Console gained it.
- The deferral-vs-ON_SITE conflict wording existed in two copies; the page's had to be taught the
  distinction separately.

## The fix: full absorption, not the fallback

The issue offered a reduced landing if absorption "proves larger than one slice". It was not taken.
The parity gate in `CLAUDE.md` permits deferring an in-scope UI criterion only for an
external-integration blocker, and "the test rewrite is big" is not one — so the whole absorption
landed and all three ACs are met rather than two-and-a-follow-up.

`ScheduleDetailPage` now renders `StopActions` and `TicketActions` directly. It keeps everything that
is genuinely its own — stop ordering, the batch link, the state badges, the "Why suggested?" chip — and
deletes ~300 lines: the six forms, `useOverridePreview`, `onOverride`, `confirmOverride`, the conflict
banner, `SePicker`, `ReasonInput`. **CB-7 closes by construction**: the shared `OverrideForm` has
caught and rendered failures since it was written, so there is no second error surface that could drift
again.

`placement` is `{ kind: 'PLACED' }` unconditionally here — every ticket on this page is on this
engineer's plan by definition, so it is a fact of the route rather than something to derive.

### The divergence the absorption exposed

Unifying the two forms surfaced a third difference neither audit named: the Console's `OverrideForm`
gated the **preview** on `ready`, which includes a non-empty reason — so no projection appeared until
the operator had already typed their justification. Schedule Detail's fork fired on the target alone.

The fork was right, and #289's own contract says why: the impact is a function of *which engineer* and
*which work*, and the projection exists to **inform** the decision. Withholding it until the move has
been justified shows it last. `ready` is now split into `moveSpecified` (what the preview needs) and
`ready` (that plus the mandatory reason, for the write). No console suite asserted on the preview at
all, so this is a strict improvement to both surfaces, not a trade.

## What changed in the tests, and what did not

The two ScheduleDetailPage suites are **retargeted, not rewritten**: every AC is unchanged and still
checked — the mandatory reason gates Confirm, each action POSTs the same body to the same path, the
page refetches, the two-gate conflict needs an explicit second click. What moved is which DOM says so:
`Swap SE`→`Swap engineer`, `Split batch`→`Split stop`, `Target SE`→`Target engineer`,
`Move to position`→`New position`, `Select ticket X`→`Move ticket X`, six `Confirm <verb>` buttons→one
`action-confirm`, `onsite-conflict-banner`→`action-conflict`. The renames are listed once in each
suite's docblock so the diff reads as a retarget.

One genuine improvement rides along: the split's device checkboxes moved from the ticket rows into the
split form, which is where they belong — the selection is part of the move being composed, not of the
plan being looked at.

Two new cases:

- **CB-7's pin** — a 500 on commit renders an alert in the form, leaves the ticket on the plan, and
  leaves Confirm enabled to retry. This is the defect the fork actually cost operators.
- **AC3's dividend** — Move to another day works on Schedule Detail, committing `MOVE_TICKET` through
  the same endpoint. Nothing was written for it in this slice; the page renders the shared band, so it
  is simply there. That is the argument for absorption, stated as a test.

## Verification

- `schedule-override` 9/9 (was 7, +CB-7 +AC3), `override-impact-preview` 20/20,
  `schedule-detail` and `deferral-override-confirm` unchanged and green.
- **Full admin suite: 119 files, 832 tests, all passing.** The six console suites are green unchanged —
  the absorption changed no console behaviour except the preview gate above.
- `npx tsc --noEmit` clean.
- **One pre-existing unhandled error remains and is not this slice's**: `TicketDetailDrawer.tsx:440`
  reads `attempts.attempts.length` unguarded and throws during render, which makes `vitest` exit 1 with
  every test passing. Verified by re-running `ticket-drawer-tabs` with this slice's two source files
  stashed — identical error. Filed as
  [**#335**](../../.scratch/fsm-platform-v1/issues/335-ticket-drawer-attempts-render-crash.md), because
  an exit code of 1 on a fully green suite is precisely what #107's CI cannot interpret.

## Acceptance criteria

- [x] **AC1** — exactly one implementation of the override forms and one `useOverridePreview`.
- [x] **AC2** — no override failure on any surface is silent (pinned by a spec, not by inspection).
- [x] **AC3** — ScheduleDetailPage gains MOVE_TICKET for free.

`UI surfaces: Schedule Detail (same controls, shared implementation); Scheduler Console (unchanged)` —
both built, so the parity gate is satisfied in-slice.
