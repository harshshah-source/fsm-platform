# Progress — Issue 45: Plants Admin UI

> Build date: 2026-06-25 · Strict TDD (RED→GREEN→REFACTOR), AFK.
> Status: **DONE** — Plants tab on `/settings` (create under a zone picker + list) + SE-Coverage plant
> picker. Closes Issue 02 AC#2. **Admin-only** — backend (`/api/org/plants`) pre-existed. Admin
> **+1 PlantView/2 api fns / +1 section / Plants tab / coverage picker / +2 tests**; **79/79** + `tsc`
> clean. No backend/schema change.

## Acceptance criteria status

| # | Criterion | State | Evidence |
|---|-----------|-------|----------|
| 1 | `/settings` has a Plants tab; Ops Head creates a plant under a chosen zone and sees it listed | 🟢 | `PlantsSection` (create form: name + **zone picker** from `listZones`) + list; Plants tab in `SettingsPage` between Zones and Users. `settings.test` (Issue 45 create case). |
| 2 | Plant create errors (unknown zone → 404) surface in the UI, not an unhandled rejection | 🟢 | `try/catch` around `createPlant` → `role="alert"` message. `settings.test` (Issue 45 error case). |
| 3 | SE Coverage plant selection uses a picker backed by `listPlants` (no raw id entry) | 🟢 | `SeCoverageSection` "Plant ID" text input replaced with a `<select>` of `listPlants` (name + zone). |
| 4 | Admin test covers plant create + list rendering | 🟢 | The two `settings.test` Issue-45 cases (create→list + error). |

## Slice-by-slice RED→GREEN report

- **Slice 1 — api + Plants tab.** `PlantView` + `listPlants(zoneId?)` + `createPlant({name, zoneId})`
  in `org.ts`; `PlantsSection` (zone-picker create form, list, inline error) + Plants tab. RED = no
  Plants tab (2 fail). GREEN.
- **Slice 2 — SE-Coverage picker.** Replaced the raw `Plant ID` input with a `listPlants`-backed
  `<select>`; no existing test referenced the old input, so no regression. tsc + full suite green.

## Deviations / decisions

1. **Folded in the #46 write-error pattern.** Per the spec note, `PlantsSection`'s create handler uses
   `try/catch` + a `role="alert"` message (the older sections `await` with no guard); applied here for
   the new section. Retro-fitting the other sections is out of scope for this issue.
2. **Zone/Plant pickers, not raw ids.** Plant create uses a zone `<select>`; SE-Coverage uses a plant
   `<select>` — coverage mapping no longer requires knowing internal ids (the AC#3 intent).

## Parity-gate disposition

- **Admin surface built in-issue** (the only surface; backend pre-existed). **Mobile: n/a.** No
  deferrals — Issue 45 fully closed.

## How to run / verify

```
cd apps/admin && node node_modules/vitest/vitest.mjs run test/settings.test.tsx
```
