# 69 — Admin Install-create UI (single form + CSV upload)

Status: ready-for-agent
Type: AFK · Frontend
Origin: Issue 33 parity follow-up (2026-06-26).

## What to build

The admin presentation surface for the Issue 33 Install-create backend (built and green:
`POST /api/install`, `POST /api/install/upload`, scoped to ZM own-zone / CSM / Operations Head). The
backend ACs are met identically across both channels at the service+controller layer; this issue gives
the manual-creation path its admin UI so a manager isn't restricted to raw API/CSV calls. This is a
presentation-only slice over endpoints already implemented in this repo (surfacing rule), **not** an
external-integration seam.

- **Single Install-create form.** Fields `vehicle_no, plant_id, company_id, device_type, device_id`
  (+ optional `sim_id, target_date, notes`), gated to creator roles (ZM/CSM/OH). Plant picker scoped to
  the creator's zone authority (reuse the SE-Coverage / #45 plant-picker pattern). Maps the controller's
  row-error codes to inline messages: existence → not-found, active-mapping → 409 conflict, zone →
  forbidden.
- **CSV bulk-upload page.** Textarea/file upload posting to `/api/install/upload`; on `CSV_VALIDATION_FAILED`
  render the per-row `{line, code, field}` errors (the backend is all-or-nothing — nothing is created on
  failure), and on success show the created batch (`batchId` + count). Header contract:
  `vehicle_no, plant_id, company_id, device_type, device_id` (+ optional `sim_id, target_date, notes`).
- Compose with the FE-series design system once it lands (FE-08/09 ticket surfaces); until then match the
  existing admin page chrome. Preserve the test selector-contract.

## Acceptance criteria

- [ ] Single Install-create form (creator-role-gated) creates a ticket and renders row-error codes inline
- [ ] CSV upload page posts to `/install/upload`, renders per-row line-numbered errors, shows the created batch on success
- [ ] Plant picker / scope reflects the creator's zone authority (ZM own-zone; CSM / OH all zones)
- [ ] No backend change — consumes the Issue 33 endpoints as-is

## Blocked by

- #33 (done)
