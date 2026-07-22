# 150 — SE Management Directory: inline editing (`EditableCell` primitives)
Status: accepted
Type: AFK

> Filed 2026-07-22 by [#144](./144-commit-dispatch-correctness-layer.md) Slice 2 to own found
> working-tree code, per the INDEX WIP convention (INDEX:53-55 precedent: *"commit it under its own
> issue/stub before starting item 2"*). The work was **already built** when this stub was filed; the
> stub exists so the commit has an owner, not to schedule new work.

## What to build

*(Already built — recorded here for traceability.)*

Three reusable inline-edit data primitives plus their adoption on the SE Management Directory:

- **`EditableCell`** — inline text edit with a client-side `validate` hook, `Enter`/blur to commit,
  `Escape` to cancel.
- **`EditableSelectCell`** — the same contract over a fixed option set.
- **`ToggleCell`** — boolean toggle with an accessible label.

Adopted on `SeManagementDirectoryPage` so an Operations Head can edit an SE's fields in the row
rather than through a modal. Row selection moved off the SE name (now an `EditableCell`) onto an
explicit **"Manage coverage →"** button, which opens the coverage edit panel.

`UpdateSeBody` gains `zoneId` so an SE's zone is editable through the same path.

## Design contract (audited clean 2026-07-22)

The adversarial review v3 audited `EditableCell` in Gate 3 and recorded **no finding**. The
properties it verified are the contract — preserve them in any future change:

- **Pessimistic, not optimistic** (`:66-92`): the displayed value changes only after a *confirmed
  successful* save. The docblock at `:29-33` states this and the code honours it.
- **No swallowed errors** in any of the three cells: save failures surface inline via `role="alert"`
  and `aria-invalid` (`:135`, `:142-146`) rather than reverting silently.
- Client-side `validate` runs **before** the network (`:77-81`).

## Acceptance criteria

- [x] `EditableCell` / `EditableSelectCell` / `ToggleCell` exist and are exported from `components/data`.
- [x] The SE Management Directory edits fields inline; `UpdateSeBody.zoneId` is wired.
- [x] Row selection is an explicit "Manage coverage →" affordance, not a click on an editable field.
- [x] Saves are pessimistic; failures surface inline and are never swallowed.
- [ ] The guarding test follows the new selection contract → owned by [#142](./142-se-directory-row-selection-contract.md).

## Known follow-up

Committing this rework left `apps/admin/test/se-management-directory.test.tsx` **red**: it still
clicks the SE name to open the edit panel. That is a known, tracked consequence of this commit and is
owned by **[#142](./142-se-directory-row-selection-contract.md)**, which lands immediately after.
This stub is **not** "done" in the parity sense until #142 is green.

## UI surfaces

Admin: **SE Management Directory** (`/engineers/manage`) — inline row editing + "Manage coverage →"
panel affordance. No new page or route.

## Reference

`docs/ui/desktop/v2-reference/15-se-activity.png` (SE surfaces composition). The directory is an
admin-management surface added after the v2 reference set; the inline-edit pattern follows
`DESIGN-SYSTEM.md` data-primitive conventions rather than a dedicated reference image.

## Blocked by
None (already built).
