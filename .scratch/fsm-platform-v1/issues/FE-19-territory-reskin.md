# FE-19 — Territory page reskin

Status: done
Type: AFK · Frontend · Phase F5
Effort: S

> Governed by `DESIGN-SYSTEM.md`. Global DoD applies.

## What to build

Reskin `TerritoryPage` list/config to the design system (tokens, `DataTable`, `SectionCard`). The polygon
map-drawing editor remains a **separate deferred issue** (Issue 09 spatial-editor follow-up) — note the
placeholder in-page.

## Dependencies

- FE-03

## Acceptance criteria

- [x] Territory/coverage config reskinned to tokens + `DataTable`
- [x] Polygon editor left as a clearly-labelled deferred placeholder (no behaviour change)
- [x] Existing coverage API + selectors preserved

## Reusable components introduced

- (consumes FE-03)

## Affected pages

- `TerritoryPage` (**[RP]**)

## Reference

- (org config — no dedicated v2 screen; follows DataTable conventions)

## Verification

- `territory-page.test.tsx` green

## Outcome

Presentation-only reskin of `TerritoryPage` (`apps/admin/src/pages/coverage/TerritoryPage.tsx`):

- `PageHeader` (title + subtitle) replaces the bare `<h1>`.
- The three hierarchical pickers + the engineer picker now use `Field` (label + `htmlFor`) wrapping
  the styled-native `FilterSelect`. **Native `<select>` retained deliberately** — the test contract
  drives them via `userEvent.selectOptions` + `getByLabelText`, which the hand-rolled overlay `Select`
  (a button/listbox combobox) cannot satisfy. Labels kept verbatim: Engineer / State / Region / District.
- The two panels are now `SectionCard`s ("Current territory", "Add coverage").
- The membership list moved from a bespoke `<ul role="list">` to the canonical `DataTable` per AC#1
  (Coverage column + right-aligned Remove `Button`). This changes the element role `list → table`; the
  accessible name **"Current territory" is preserved**, so the single test assertion was updated
  `findByRole('list', …)` → `findByRole('table', …)` (asserted "Mumbai City" text unchanged).
- Add / Remove CTAs use the `Button` primitive; the deferred polygon affordance kept as a disabled
  `Button` (name still matches `/polygon/i`, same title tooltip) — Issue 09 spatial-editor follow-up.
- All `org/geo/*` reads, `se-territory` list/add/remove writes, the FLOATING-only engineer filter, and
  the district>region>state add precedence are byte-for-byte unchanged.

Verified: `pnpm --filter @fsm/admin run typecheck` clean · `territory-page.test.tsx` 2/2 · full suite
**100/100** · `vite build` OK.
