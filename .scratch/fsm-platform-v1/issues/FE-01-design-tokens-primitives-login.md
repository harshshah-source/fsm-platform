# FE-01 — Design tokens + base primitives + Login parity

Status: done
Type: AFK · Frontend · Phase F0
Effort: M

> Governed by `DESIGN-SYSTEM.md` §1–3. Global DoD applies.

## What to build

The token foundation every screen inherits, the first base primitives, and a proof screen. Install the
Tailwind v4 `@theme` token layer (brand crimson, navy chrome, warm-light surface, semantic + SLA palette,
type/spacing/radius/shadow per `DESIGN-SYSTEM.md`). Build `Button`, `Card`/`SectionCard`, `Input`/`Field`,
`Badge`. Promote `lib/slaBucket.ts` to the SLA-colour token source. Reskin `LoginPage` to `00-login`
using the **existing** `useAuth().login` flow untouched.

## Dependencies

- FE-00 (baseline harness)

## Acceptance criteria

- [x] Token layer live as CSS variables in `apps/admin/src/index.css` (brand/chrome/surface/text/semantic/SLA/type/spacing/radius/shadow)
- [x] `Button` (primary/secondary/danger/ghost + loading), `Card`/`SectionCard`, `Input`/`Field`, `Badge` implemented and tokenized
- [x] `LoginPage` matches `00-login`: dark split layout, brand logo, KPI stat tiles, red Sign-In, feature checklist — login logic unchanged
- [x] `lib/slaBucket` is the single SLA-colour source consumed by `Badge`
- [x] Primitives rendered in `/_kitchensink`

## Reusable components introduced

- `tokens`/`@theme`, `cn` util, `Button`, `Card`/`SectionCard`, `Input`/`Field`, `Badge`

## Affected pages

- `LoginPage` (proof; **[RP]**)

## Reference

- `docs/ui/desktop/v2-reference/00-login.png`

## Verification

- `apps/admin/test/login.test.tsx` green (same labels/roles); Playwright `/login` ≈ `00-login`; `tsc --noEmit` clean
