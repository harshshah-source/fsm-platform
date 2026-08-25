# #290 — The Assign Work Console's approved visual grammar, actually built · completion report

**Landed 2026-08-25.** Owning decision: [#272](../../.scratch/fsm-platform-v1/issues/272-decision-assign-work-console.md),
whose grammar table it calls **non-negotiable** and which was never implemented.
Evidence: [`audit/scheduler-engine-forensics-2026-08-25.md`](../../audit/scheduler-engine-forensics-2026-08-25.md) §F.
Design (authoritative): [`docs/ui/desktop/approved-designs/assign-work-console.html`](../ui/desktop/approved-designs/assign-work-console.html).

## What was wrong

Not "the console was undecorated" — **the console said the wrong things**.

Two colours were swapped against their own approved meanings. Over capacity rendered
`text-critical` (crimson, the reserved colour for critical work) and a tier crossing rendered
`warning` (amber, the reserved colour for over capacity). An operator scanning six lanes could not
tell *this engineer is past their cap* from *this work is on a clock* — and those two prompt opposite
actions. Worse, crimson on an over-capacity lane said the opposite of #258 Q2, which rules manual
overload an administrative **right**: the board was drawing a permitted decision as a failure.

Beside that: work chips were undifferentiated pills with no border, no dot, no critical treatment and
no split between critical and ordinary work; the over-capacity **lane** treatment the design draws did
not exist (only the number changed); the three-swatch legend was rendered nowhere; and the ledger's
fifth cell — the one that answers "is anything about this draft a problem?" — was missing.

## What landed

| Meaning | Form | Where |
|---|---|---|
| Inside the engineer's own coverage | solid border + dot | `CHIP_FORM.OWN_COVERAGE` |
| A human crossed a coverage tier | dashed border, **violet** | `CHIP_FORM.TIER_CROSSING` |
| Critical work | **heavy crimson** border + flag | `CHIP_FORM.CRITICAL` |
| Over capacity | **amber** lane + load | lane container, `LaneHeader`, `LoadBadge` |

- **`src/pages/assign/grammar.tsx`** — the grammar as a table (`CHIP_FORM`, `CHIP_MEANING_LABEL`,
  `chipMeaning`) plus `GrammarLegend`, which renders **from that same table**. A legend describing a
  border the chips no longer use is worse than no legend, so it cannot be written twice.
- **Both collisions fixed**, and in every place they lived: `LaneCoverage` (lane badges and load),
  `ReviewCommitScreen` (the last screen before a write), and `LoadBadge` — which is the console's own
  lane load *and* the badge six other surfaces share.
- **A `tierCross` tone on `Badge`**, so the violet is a named tone rather than a class sprinkled by
  hand.
- **Critical work is its own chip** (`Sirohi Works ⚑ ×4 crit` beside `Sirohi Works ×8`), matching the
  design's own split.
- **The over-capacity lane** carries `data-over-capacity` and an amber border + wash. Still not a
  barrier: Review & commit stays enabled, pinned by its own test.
- **The ledger's fifth cell** — over-capacity lanes, tier crossings, no-coverage plants.

## Four decisions worth recording

**`LoadBadge` changed for all seven surfaces, not just this one.** It was crimson everywhere. Fixing
it only on `/assign` would mean an operator has to know which screen they are on before they can read
a colour, which is the same defect in a smaller box. #282 R2's "the two boards read as one product"
does not stop at the two boards.

**The critical/ordinary split is suppressed for a partial placement.** A plant's `criticalCount` is a
fact about the *plant*. When #276's Distribute hands a lane only part of a plant's work
(`ticketOverrides`), asserting the plant's critical count of that arbitrary subset would be a
fabricated number — exactly what #282 R6 forbids — so the chip stays whole and says `×N of M`.

**One remove control per plant, not one per chip.** The suite caught this as two buttons with the same
accessible name; the deeper problem is that two controls doing the identical thing to the identical
object claim a granularity the draft does not have. A lane holds **plants**, and there is no way to
drop "the critical half" of one.

**`Toast` stopped borrowing `BadgeTone` wholesale.** Adding `tierCross` forced `Record<BadgeTone, …>`
there to invent a toast style for a chip meaning that is never announced as a toast. The type is now
`ToastTone`, an explicit subset — so a future chip meaning no longer drags a notification style behind
it.

## Grayscale

The three meanings are three **shapes** — solid 1px, dashed, solid 2px — plus a flag glyph on critical
and a dot on own-coverage. Colour is the second signal, never the only one. A test asserts the three
swatches cannot collapse into two, so a future edit that makes two of them share a border fails rather
than silently making the board colour-only.

## Tests

New: `test/assign-console-grammar.test.tsx` (13) — both collisions in all three places they lived, the
lane treatment, the critical split (present and correctly absent), the crossed-tier chip, the legend,
the grayscale property, the ledger summary cell (populated and silent), and AC7's "still fully
committable".

Admin suite **111 files / 633 tests, 0 failed**. No endpoint, no workflow, no role gate touched.

## Not done here

**The rail's chips are unchanged.** The no-eligible-engineer rail already labels itself in words and
carries `NO_COVERAGE` in `CHIP_FORM` for when it wants it; a four-swatch legend for a three-meaning
grammar reads as four things to learn, so the legend stays at three.

**Nothing was added to `index.css`.** The violet the issue asks for already existed
(`--color-tier-cross`, added with #285's provenance grammar) — the gap was that `/assign` never used
it.
