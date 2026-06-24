# 58 — M4: Troubleshoot form (mobile)

Status: ready-for-agent
Type: AFK

## What to build

The full mobile Troubleshooting form (Issue 16 `/api/tickets/:id/troubleshoot`): structured root-cause
selection, component-unavailable flag, photo capture, and location-captured-on-submit (Decision §9).
Idempotent submit via `client_submission_id`. Also hosts the resubmit form for the component loop
(Issue 22 mobile half).

## Acceptance criteria

- [ ] Structured root-cause form renders and submits to `/api/tickets/:id/troubleshoot`
- [ ] `component_unavailable` flag captured; photo capture + location-on-submit wired
- [ ] Idempotent submit with `client_submission_id`
- [ ] Resubmit path supports a new `client_submission_id` on the same ticket (Issue 22 mobile AC)

## UI surfaces

- **Mobile:** Troubleshoot form + resubmit. Owned by this issue (also closes Issue 22 mobile resubmit AC).
- **Admin:** n/a.

## Reference

- `docs/ui/mobile/troubleshooting.png.png`

## Blocked by

- #54, #16
