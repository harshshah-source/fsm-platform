# 68 — SE mobile Recovery screens (on-site / Collection Form / Unable to Collect)

Status: ready-for-agent
Type: AFK
Origin: Issue 36 parity follow-up (2026-06-25).

## What to build

The SE-facing mobile surfaces for the Recovery Ticket field workflow (Issue 36). The backend lifecycle
+ endpoints are built and green (`/api/recovery/:id/{on-site,collected,unable-to-collect}`); these are
the mobile screens that drive them. RECOVERY appears in the Day Plan as a first-class work type.

- **Recovery in the Day Plan / Ticket Detail** — RECOVERY work-type card with the lifecycle status.
- **Mark On-Site** action (SCHEDULED → ON_SITE).
- **Collection Form** — mandatory device-serial confirmation (validated against the ticket) +
  mandatory condition notes → COLLECTED.
- **Unable to Collect** — reason picker (COMPANY_REFUSED / VEHICLE_UNREACHABLE / DEVICE_MISSING /
  OTHER) → routes to the ZM decision queue.

## Acceptance criteria

- [ ] RECOVERY tickets render in the SE Day Plan / Ticket Detail with lifecycle status
- [ ] Mark On-Site, Collection Form (serial + condition), and Unable to Collect drive the #36 endpoints
- [ ] Collection Form enforces serial validation + mandatory condition notes client-side

## Blocked by

- #54 (Mobile Foundation — RN/Expo shell)
- #36 (done — backend + endpoints)
