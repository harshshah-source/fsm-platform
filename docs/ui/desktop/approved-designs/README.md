# Approved designs (desktop)

Operator-approved UI directions for screens that have **no image** in
`docs/ui/desktop/v2-reference/`.

These carry the same authority as a v2 reference image for the screens they cover, and slot into the
same position in the hierarchy (`docs/agents/domain.md` § UI authority):

```
CONTEXT.md → PRD → workflow → v2-reference images / approved designs → existing UI code → ADRs
```

An approved design exists so that "no v2 image exists for this screen" is never a reason to stall or
to invent a layout. Where a v2 reference image **does** cover a screen, that image wins and nothing
here may contradict it — an approved design may only add screens the reference set never drew.

| Design | Covers | Approved | Owning record |
|---|---|---|---|
| [`assign-work-console.html`](./assign-work-console.html) | Manual assignment / reassignment console (`/assign`), its work pool, draft lanes, candidate column and commit review | 2026-08-20 | [`#272`](../../../../.scratch/fsm-platform-v1/issues/272-decision-assign-work-console.md) |

## Reading one

Open the `.html` file in a browser — each is self-contained (no build step, no external assets beyond
Google Fonts) and renders in both light and dark. The analysis sections explain *why* the layout is
what it is; the two wireframes are the authoritative part.

## Adding one

An approved design is added only by an operator decision, recorded as a `DECISION RECORD` issue in
`.scratch/fsm-platform-v1/issues/` and linked in the table above. Do not add a design here because it
looks finished — approval is the entry condition, not authorship.
