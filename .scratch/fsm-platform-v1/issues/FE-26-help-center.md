# FE-26 — Help Center

Status: ready-for-agent
Type: AFK · Frontend · Phase F5
Effort: S

> Governed by `DESIGN-SYSTEM.md` §8. Global DoD applies. (Deferred-tier; no backlog item previously owned it.)

## What to build

The Help Center page matching `27`: role-scoped grouped `SectionCard` topic grid (Your module / Components &
Warehouse / Analytics / Admin) with per-topic title + description + "View Docs" link, plus a "Model states &
terminology" glossary card section. Static/role-aware content — no backend dependency.

## Dependencies

- FE-02, FE-03

## Acceptance criteria

- [ ] Help Center matches `27` (grouped topic cards + glossary)
- [ ] Topic visibility role-scoped via existing role logic
- [ ] Reachable from sidebar Help link

## Reusable components introduced

- `HelpTopicGrid`, `GlossaryCard` (composition)

## Affected pages

- new `/help` (**[N]** page)

## Reference

- `docs/ui/desktop/v2-reference/27-help-center.png`

## Verification

- new help-center test; Playwright ≈ `27`
