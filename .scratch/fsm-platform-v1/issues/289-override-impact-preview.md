# 289 — Override: preview the impact before it is committed

Status: **backend done** (2026-08-25) · **UI half open** — see
[`HANDOFF-P11-289-ui.md`](../HANDOFF-P11-289-ui.md) and
[`docs/progress/289-override-impact-preview.md`](../../../docs/progress/289-override-impact-preview.md)
Type: AFK · Backend + Admin
Decision: [#282](./282-decision-todays-dispatch-crew-deck.md) R1 — the design's step 3.

## Objective

Complete the approved flow **inspect -> understand -> override -> preview impact -> confirm**. The
system today has inspect, understand and a commit; the preview step between them does not exist.

## Current behaviour (verified)

Every override action commits immediately (`override.service.ts` REMOVE/DEFER/REORDER/SWAP_SE/
REASSIGN/SPLIT_BATCH), reason-gated but with no projection. The pattern to copy already exists and is
proven non-mutating: `distribute-projection.service.ts` (#276) writes nothing — there is no
`create`/`update` in it — and #250's dry-run seam suppresses all six mutations.

## Required change

A projection endpoint that answers, for one proposed move, what the design shows: **both lanes'
capacity before -> after**, where the ticket ranked in the run that placed it, the effect on stop
order (appended, not reordered), and conflicts (on-site work, return-date hold). Then the existing
audited write is the confirm. The preview must take no lock, no in-flight slot and no ledger row, and
must write nothing — pinned by test, exactly as #250's dry run is.

Lost races re-present as the existing clean 409 conflict shape (#265), never an error page.

## Acceptance criteria

- [x] AC1 — The projection returns capacity before/after for both engineers, rank context, stop-order
      effect and conflicts.
- [x] AC2 — **The preview writes nothing** — a spec asserts zero rows change across every table it
      touches.
- [x] AC3 — Confirm remains the audited write with its mandatory reason; the audit row is unchanged.
- [x] AC4 — A lost race returns the existing 409 conflict, itemised, not a 500.
- [ ] AC5 — ~~The cockpit renders~~ **Schedule Detail renders** the preview between the override
      choice and the commit. **Operator ruling, 2026-08-25**, put to them explicitly: the cockpit has
      no override controls — it links out to `/schedules/:engineerId`, which is where an operator
      actually chooses an override — so building move controls into `/dispatch/today` would duplicate
      an existing surface, which #282 R5 forbids. The option was offered and not taken. **Open.**
- [ ] AC6 — Both suites green. *(Backend green: 8 service specs + 3 HTTP specs. Admin pending the
      UI half.)*