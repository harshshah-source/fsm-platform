# 45 — Plants Admin UI

Status: ready-for-agent
Type: AFK
Origin: Issue 02 deep review (2026-06-18) — closes the AC#2 partial gap.

## What to build

Surface **plants** in the Operations-Head `/settings` page, matching the existing reference-config
sections. The backend already exists and persists (`PlantsAdminController` — `GET/POST
/api/org/plants`, audited via `withAudit`, `PLANT_CREATED`); this is the missing admin client + UI.

- Add `listPlants` / `createPlant` to `apps/admin/src/api/org.ts` (mirror the other typed calls;
  `createPlant({ name, zoneId })`, `listPlants(zoneId?)`).
- Add a **Plants** tab to `apps/admin/src/pages/settings/SettingsPage.tsx` and a `PlantsSection` in
  `sections.tsx` (create form + list, same shape as `ZonesSection`).
- Plant creation needs a **zone picker** (load zones via the existing `listZones`), not a raw
  `zoneId` text field.
- Improve **SE Coverage**: replace the hand-typed raw `plantId` input with a plant picker sourced
  from `listPlants`, so coverage mapping no longer requires knowing internal ids.

## Acceptance criteria

- [ ] `/settings` has a Plants tab; Operations Head can create a plant under a chosen zone and see it listed
- [ ] Plant create errors (e.g. unknown zone → 404) surface in the UI, not as an unhandled rejection
- [ ] SE Coverage plant selection uses a picker backed by `listPlants` (no raw id entry)
- [ ] Admin test covers plant create + list rendering

## Notes

- Backend is complete — no schema/migration/endpoint work expected.
- Fold in the shared write-error handling from #46 if landed first (create/upsert handlers in
  `sections.tsx` currently `await` with no `try/catch`).

## Blocked by

- #02
