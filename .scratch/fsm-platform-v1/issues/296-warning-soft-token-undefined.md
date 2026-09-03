# 296 — `bg-warning-soft` names a token that does not exist, so the capacity channel has never painted

Status: **needs-info** (one operator decision inside it — see AC2)
Type: Bug · Frontend · XS
Found: 2026-09-01, while validating the #295b density correction in the running app. **Not fallout
from it** — the three call sites predate that slice and none of them was touched by it.

---

## What happens

Three components ask for a background that is never emitted:

| File | Line | Class | What it is supposed to say |
|---|---|---|---|
| `console/BoardGrid.tsx` | ~694 | `bg-warning-soft/40` | this engineer is **at or over capacity today** |
| `console/ActionsBand.tsx` | ~805 | `bg-warning-soft/40` | this move has a **conflict** |
| `console/WorkChip.tsx` | ~268 | `bg-warning-soft/60` | the grammar legend's **"amber cell"** swatch |

`--color-warning-soft` is defined in **neither** the light nor the dark `@theme` block of
`src/index.css`. Tailwind v4 emits no rule for a token it cannot resolve and reports nothing, so the
class lands on the element and does nothing. Confirmed against the running app rather than by
reading:

```js
// injected into the live page, zone 1, /dispatch/today
getComputedStyle(el /* class="bg-warning-soft/40" */).backgroundColor
// → "rgba(0, 0, 0, 0)"
```

## Why it matters

The amber cell **is** the capacity channel. #290 spent an entire slice establishing that amber means
at/over capacity and crimson means critical SLA — one position, one meaning — and the position amber
was given is the board cell. That position has been blank the whole time: on the zone this was found
in, the first engineer is `25/25` and their cell is white. The `LoadBadge` still says `25/25` in
amber, so the fact is not *lost*, but the channel the grammar documents and the legend advertises
does not exist, and the legend swatch advertising it is itself invisible.

## Why it was not fixed on sight

The obvious repair is `warning-bg` (`#fdf2d9` light), which is the token every other amber surface
uses. But #295b just gave the **aged** work card a fill of `#fbe9c6`, and those cards sit *inside*
the cell. Pale yellow work on a pale yellow ground is two meanings a reader cannot separate at a
glance, which is the exact failure mode #290 existed to remove — so the repair is a colour decision,
not a token typo, and it belongs to the operator.

## Acceptance criteria

- [ ] AC1 — no component references a token that does not resolve. Either `--color-warning-soft` is
      defined in both themes or the three call sites move to a token that exists.
- [ ] AC2 — **operator decision:** what an over-capacity cell should look like now that the card it
      contains may itself be yellow. Options to put to them: (a) a left/edge treatment on the cell
      rather than a fill, (b) a distinctly cooler or deeper amber for the cell, (c) leave capacity to
      the `LoadBadge` alone and delete the cell treatment and its legend swatch.
- [ ] AC3 — a test that fails when a `bg-*`/`text-*`/`border-*` class in the console components names
      a token absent from `index.css`. The defect class here is *silence*: a typo'd token is
      indistinguishable from a deliberate omission at review time, and this one survived a build, a
      full suite and a visual pass.
- [ ] AC4 — `WorkChip`'s grammar legend shows the treatment the board actually draws, whatever AC2
      settles on.

## Notes

- `bg-action-*-bg` (the #295b card fills) **do** resolve — verified the same way in the same session,
  so this is specific to `warning-soft` and not a Tailwind-v4 arbitrary-token problem.
- Sibling of [#292](./292-ticket-drawer-attempts-unguarded.md) in kind: a defect that fails no test
  and prints no error, found only by looking at the running product.
