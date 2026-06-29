# 59 — M5: Verification view + PARTIAL_RECOVERY badge + CTA (mobile)

Status: ready-for-agent
Type: AFK · Mobile

## What to build

The mobile verification view (Issue 18 `/api/tickets/:id/verification`): three-phase GPS verification
status, PARTIAL_RECOVERY badge, and the verification CTA. Read-only outcome surfacing of the
already-built backend.

## Business rules (authority)

- PRD §531 Flow 2 step 7 + §490 (Verification Result screen). CONTEXT §Partial Recovery — PARTIAL_RECOVERY
  is **derived** (1–2 pings while still in flight), never a stored lifecycle state.

## Acceptance criteria

- [ ] Verification status (three-phase outcome) rendered from `/api/tickets/:id/verification`
- [ ] PARTIAL_RECOVERY badge shown when applicable (derived, per backend rule)
- [ ] Verification CTA wired

## API contract (authority: backend on `main`)

- `GET /api/tickets/:id/verification` → `{ outcome: VerifyOutcome|null, phase: VerifyPhase, pings,
  partialDeadline }` (`verification/verification-query.service.ts`). Outcomes: `CLOSED`,
  `CLOSED_AUTO_RECOVERY`, `FAILED_VERIFICATION`, or null-in-flight. PARTIAL_RECOVERY is derived when
  `outcome` is null and `pings` ∈ 1..2; `partialDeadline` = startedAt + 24 h.

## Permissions

- SE may read their own ticket's verification. (Admin verification review is Issue 19 — manager roles.)

## Navigation

- CTA returns to Ticket Detail / Day Plan per the mockup; no state mutation here (read-only).

## Offline behaviour

- Renders the last cached verification read with an offline indicator; outcome refreshes on reconnect.

## Edge cases & failures

- In-flight (no outcome, 0 pings) → pending treatment, no badge.
- PARTIAL_RECOVERY → badge + the 24 h `partialDeadline` countdown anchor.
- FAILED_VERIFICATION → failed treatment + CTA.

## UI surfaces

- **Mobile:** Verification view. Owned by this issue.
- **Admin:** n/a (admin verification review is Issue 19, done).

## Reference

- `docs/ui/mobile/verification.png.png`
- `docs/ui/mobile/ticket-detail-verification-pending.png.png`

## Tests (TDD targets — red first)

- `pings` 1–2 + null outcome → PARTIAL_RECOVERY badge + deadline rendered.
- `CLOSED` / `CLOSED_AUTO_RECOVERY` / `FAILED_VERIFICATION` each render their state.
- In-flight read renders pending with no badge.

## Blocked by

- #54, #18
