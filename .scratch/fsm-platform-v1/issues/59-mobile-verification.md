# 59 — M5: Verification view + PARTIAL_RECOVERY badge + CTA (mobile)

Status: ready-for-agent
Type: AFK

## What to build

The mobile verification view (Issue 18 `/api/tickets/:id/verification`): three-phase GPS verification
status, PARTIAL_RECOVERY badge, and the verification CTA. Read-only outcome surfacing of the
already-built backend.

## Acceptance criteria

- [ ] Verification status (three-phase outcome) rendered from `/api/tickets/:id/verification`
- [ ] PARTIAL_RECOVERY badge shown when applicable
- [ ] Verification CTA wired

## UI surfaces

- **Mobile:** Verification view. Owned by this issue.
- **Admin:** n/a (admin verification review is Issue 19, done).

## Reference

- `docs/ui/mobile/verification.png.png`
- `docs/ui/mobile/ticket-detail-verification-pending.png.png`

## Blocked by

- #54, #18
