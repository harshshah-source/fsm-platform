# 369 — DECISION RECORD: Zone Warehouse pickup stop rendering

Status: `ready-for-agent` — decided 2026-09-03 by the operator. Unblocks [#366](./366-warehouse-pickup-stop.md).

**Design:** [`docs/ui/desktop/approved-designs/warehouse-pickup-stop.html`](../../../docs/ui/desktop/approved-designs/warehouse-pickup-stop.html)
**Covers:** the pickup stop as it renders on the admin schedule detail. Surrounding page chrome stays
governed by `docs/ui/desktop/v2-reference/12-batch-schedule-review.png`. **Mobile rendering is out of
scope for #366.**

## The question put to the operator

#366 gives an SE with a SHIPPED-not-yet-received part a Zone Warehouse pickup on their day plan. The
backend half was fully specified by the plan; what was not was **how the pickup reads on the admin
schedule detail** — a stop row of its own kind, a banner above the stop list, or a bare label row.

## The decision

**A stop row with its own kind**, at sequence 0, showing the parts to collect.

The reasoning that settled it: an engineer's day is one ordered sequence and the pickup is genuinely
the first thing in it — they cannot do the job at stop 1 without the part. A stop row keeps the
ordering literal. A banner says "also, collect something" and detaches the pickup from the sequence
it belongs to, reintroducing exactly the ambiguity stop numbering exists to remove.

It is **a different kind of stop, not a differently-coloured plant**: no ticket list, no device
count, no SLA, because a warehouse has none of those. It shows the one thing a dispatcher needs —
which parts, and how many. The label-only variant was rejected because a dispatcher checking a plan
should not have to open the component requests to learn what their engineer is carrying.

## Constraints that came with the decision

- **Colour encodes kind, not severity.** The existing grammar spends crimson on critical and amber on
  over-capacity; a pickup is neither urgent nor wrong. The kind tag carries the meaning on its own, so
  the row survives grayscale.
- **Stop 0 appears only when it is real** — one pickup when the plan has at least one ticket whose
  component request is SHIPPED and not RECEIVED, none otherwise, and never more than one however many
  parts are waiting. An engineer makes a single warehouse visit.
- **A discriminated `kind`, not a boolean.** `DayPlanStop.kind: 'PLANT' | 'WAREHOUSE_PICKUP'` in
  `packages/shared` — the two shapes genuinely differ, and a boolean invites a renderer to read plant
  fields off a row that has none.
- A plan with no pickup renders **byte-identically to today**.
