# FE-00 — Visual-regression + component-audit harness

Status: ready-for-agent
Type: AFK · Frontend · Phase F0
Effort: S

> Governed by `DESIGN-SYSTEM.md` (reference authority) and the Frontend Master Plan.
> Global DoD applies (preserve selector contract, behavior tests green, tokens-only, no logic moved).

## What to build

The parity-verification harness used by every later FE issue. A documented Playwright flow that logs in
(per role, against the live backend + Book8 data), navigates a route, screenshots at a fixed viewport,
and diffs against a stored baseline PNG. Plus a dev-only `/_kitchensink` route that renders every design
-system component + variant for visual audit.

## Dependencies

- none (enabling issue; do first)

## Acceptance criteria

- [ ] Playwright flow logs in per role, navigates a route, screenshots at 1440×900, diffs vs a stored baseline
- [ ] Baseline directory + "how to add a page baseline" doc committed under the admin app
- [ ] `/_kitchensink` dev-only route renders all components/variants (excluded from prod nav/build)
- [ ] Running the harness against `/login` produces an initial baseline without affecting `pnpm test`

## Reusable components introduced

- Playwright parity script; `/_kitchensink` route

## Affected pages

- none (infrastructure)

## Reference

- all of `docs/ui/desktop/v2-reference/` + `docs/ui/mobile/` (baseline targets)

## Verification

- `pnpm --filter @fsm/admin test` unaffected; harness emits a `/login` baseline image
