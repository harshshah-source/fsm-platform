# 142 — Admin suite red: SE-directory row-selection contract changed by the `EditableCell` rework
Status: ready-for-agent
Type: AFK

> Source: `docs/audits/2026-07-22-adversarial-review-admin-backend.md` §3.4 (N1b, `needs-changes`).
> Re-verified 2026-07-22 by running the spec directly: 2 failed / 14 tests, exit code 1.

## Background

An uncommitted admin rework introduced `apps/admin/src/components/data/EditableCell.tsx` (untracked)
and converted the SE Management Directory's name column into an inline-editable cell. The audit
reviewed `EditableCell` itself and found **no defect** — it is pessimistic (the displayed value
changes only after a confirmed save, `:66-92`), surfaces failures inline with `role="alert"` +
`aria-invalid` (`:135`, `:142-146`) rather than reverting silently, and swallows no errors.

## Problem

The rework moved row selection off the SE name and onto a new **"Manage coverage →"** button. The
coverage-removal test still clicks the name to open the edit panel, so the panel never opens and the
(present and correct) `Remove Pune Depot` button is never rendered.

## Root Cause

An interaction contract changed without its guarding test being updated — the same class as
[#141](./141-backend-suite-red-stale-reconciliation-expectation.md), caught here only because the
work is still in the working tree.

## Evidence

| | Row selection |
|---|---|
| **HEAD** | SE name rendered as a button: `onClick={() => setSelectedId(r.seId)}` (`git show HEAD:…SeManagementDirectoryPage.tsx:200`) |
| **Working tree** | Name is now an `EditableCell` (`:200`); selection moved to a **"Manage coverage →"** button (`:298-301`) |

Re-run 2026-07-22 (`npx vitest run test/se-management-directory.test.tsx`):

```
FAIL test/se-management-directory.test.tsx:141
  > removes a mapped plant via its coverage id from the edit panel
  TestingLibraryElementError: Unable to find role="button" and name `/remove pune depot/i`
```

Test source at `:140-141`:

```
await userEvent.click(await screen.findByText('Asha Rao')); // select the row → open the edit panel
await userEvent.click(await screen.findByRole('button', { name: /remove pune depot/i }));
```

The `Remove Pune Depot` button is present and correct at `SeManagementDirectoryPage.tsx:451-455`;
it is simply never rendered because the panel never opens.

## Current Behaviour

The test clicks the SE name, which now commits/cancels an inline edit instead of selecting the row.
The edit panel never opens; the assertion fails; the admin suite is red.

## Expected Behaviour

The test opens the panel via **"Manage coverage →"**, and the coverage delete fires
`DELETE /engineers/se-1/coverage/77` as before. Component behaviour is unchanged — this is a test
retarget, not a product change.

## What to build

Retarget the row-selection step in the SE-directory spec. **Test-only.**

`EditableCell.tsx` and `SeManagementDirectoryPage.tsx` must be **unchanged** by this issue. The new
interaction (inline edit on the name, explicit "Manage coverage →" for the panel) is the intended
design and was reviewed clean.

## Acceptance criteria

- [ ] The coverage-removal test opens the edit panel via the **"Manage coverage →"** button and passes.
- [ ] The click target is **row-scoped** (queried within the target row), not a global `findByRole`, so a second SE row cannot match it.
- [ ] Every other spec that opens the SE-directory edit panel is located, updated if needed, and green.
- [ ] `EditableCell.tsx` and `SeManagementDirectoryPage.tsx` are unchanged — verified by `git diff --stat` showing only `test/` paths.
- [ ] Full admin suite green (expected 318/318), reading **vitest's own exit code**.

## TDD Strategy

**RED already exists — do not author a new failing test.** The existing assertion at
`se-management-directory.test.tsx:141` is the RED.

- **What fails today:** `findByRole('button', { name: /remove pune depot/i })` times out.
- **Why it fails:** the preceding line clicks the SE name, which is now an `EditableCell` and no
  longer calls `setSelectedId`, so `selectedId` stays `null` and the edit panel is not mounted.
- **What makes it pass:** clicking the row's "Manage coverage →" button, which is what
  `SeManagementDirectoryPage.tsx:298-301` now wires to `setSelectedId(r.seId)`.

RED → GREEN. No REFACTOR (test-only, single interaction step).

## Implementation Slices

### Slice 1 — Retarget row selection in the SE-directory spec

- **Objective:** admin suite green.
- **Files:** `apps/admin/test/se-management-directory.test.tsx`
- **Services:** none.
- **Database:** none.
- **Frontend:** none — no source change.
- **Tests:** the modified spec; then the full admin suite as the gate.
- **Acceptance criteria:** all five above.
- **Definition of Done:** `npx vitest run` in `apps/admin` exits **0**; `git diff --stat` shows only
  `apps/admin/test/`.

Single slice — independently mergeable.

## Rollback Plan

`git revert`. Test-only, zero runtime surface.

## Dependencies

**Blocked by [#144](./144-commit-dispatch-correctness-layer.md) Slice 2** — the `EditableCell` rework
must be committed before its guarding test is retargeted. Retargeting a test at an untracked
component would leave the repo in a state where the test passes only on one disk, which is the exact
failure mode #144 exists to close.

## Estimated Effort

20 minutes. **Priority: P0** — one of two suites blocking [#107](./107-ci-concurrency-guard-migration-tests.md).

## UI surfaces
n/a (test-only — no surface is created or modified; the SE Management Directory's new interaction is
delivered by #144 Slice 2, which commits the already-built rework)

## Reference
n/a

## Blocked by
- [#144](./144-commit-dispatch-correctness-layer.md) Slice 2 (commits the `EditableCell` / SE-directory rework)
