# 290 — The Assign Work Console's approved visual grammar, actually built

Status: **done** (2026-08-25) — report [`docs/progress/290-assign-console-visual-grammar.md`](../../../docs/progress/290-assign-console-visual-grammar.md)
Type: AFK · Admin
Decision: [#272](./272-decision-assign-work-console.md) — the grammar table it calls
**non-negotiable**, and which was never implemented.
Evidence: [`audit/scheduler-engine-forensics-2026-08-25.md`](../../../audit/scheduler-engine-forensics-2026-08-25.md) §F.

## Objective

Close the gap between #272's approved design and `/assign` as built — the same grammar the cockpit
uses, so the two boards read as one product (#272:64, #282 R2).

## Current behaviour (verified)

- Work chips are undifferentiated pills: no border, no leading dot, no critical treatment, no
  dashed tier-crossing treatment; critical work is never split out at chip level.
- **Two colour collisions the grammar forbids**: over-capacity renders `text-critical` (crimson —
  the reserved critical colour) and tier-crossing renders `warning` (amber — the reserved
  over-capacity colour). The code comment concedes the theme has **no violet token**; confirmed —
  `apps/admin/src/index.css` defines `--color-warning` and `--color-critical` and no violet.
- The over-capacity **lane** treatment (amber lane + header) is absent; the lane never changes.
- The three-swatch **legend** is not rendered anywhere.
- The ledger's fifth cell (over-capacity / tier-crossing / no-coverage rollup) is missing.

## Required change

~~Add the violet token to `index.css`~~ (it already exists — `--color-tier-cross`, added with #285's
provenance grammar; the gap was that `/assign` never used it); implement the chip grammar (solid+dot own coverage, heavy
crimson + flag critical, dashed violet human tier-crossing); the amber over-capacity lane; the
legend; and the ledger's summary-tag cell. **Grayscale-survivable**: never the same shape for two
meanings. Workflow, endpoints and role visibility are untouched — this is the approved visual layer
only.

## Acceptance criteria

- [x] AC1 — Violet token exists and is used **only** for human tier-crossing.
- [x] AC2 — Over-capacity is amber (lane + load), never crimson; critical is crimson, never amber.
- [x] AC3 — Chip grammar renders per the design, including critical chips split from non-critical.
- [x] AC4 — The legend renders its three swatches.
- [x] AC5 — The ledger's summary-tag cell renders live counts.
- [x] AC6 — Grayscale test: each meaning is distinguishable by shape/border alone.
- [x] AC7 — No workflow or endpoint change; admin suite green.