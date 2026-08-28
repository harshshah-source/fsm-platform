# 285 — Today's Dispatch: the cockpit (Plan / Live / Replay)

Status: **done-with-follow-up** — built 2026-08-25; header corrected 2026-08-27.
> **Correction, 2026-08-27.** This header still read `ready-for-agent` two days after the cockpit
> shipped, while `INDEX.md` row 4 claimed the issue DONE *including* "Run-dispatch relocated".
> Both were wrong in opposite directions. The cockpit **is** built (Plan/Live/Replay, deck, rails,
> interception strip); **Run-dispatch was never relocated** — `PlanMode` links to `/bulk-unassign`,
> an `OPERATIONS_HEAD`-only route that redirects a ZM or CSM to the dashboard. That remainder is
> owned by Scheduler Console Phase 1.2, not by this issue.
Type: AFK · Admin
Decision: [#282](./282-decision-todays-dispatch-crew-deck.md) R1. Design (authoritative):
[`docs/ui/desktop/approved-designs/todays-dispatch-crew-deck.html`](../../../docs/ui/desktop/approved-designs/todays-dispatch-crew-deck.html)
**Read the design before writing code** (workflow.md UI-discovery). Do not redesign it; build it.

## Objective

One zone-scoped operator surface at `/dispatch/today` with three modes over one layout, replacing
four separate destinations as the primary mental model — and reusing every one of them underneath.

## Required change

- **Route + shell** `/dispatch/today`, `MANAGER_ROLES`, acting-zone aware. Header per the design:
  zone · operating date · run-status pill · **Plan | Live | Replay** · **Run dispatch** · find ticket/SE.
- **Situation chips** from `GET /dispatch/today`'s `situation` block — placed · unassignable ·
  held · critical-needs-you · over capacity · changes today. **No hard-coded values** (#282 R6).
- **Live**: the engineer deck — one card per SE with tier badge, `committed/dailyCapacity` as a
  shape not a column, availability state, numbered plant groups holding **ordered** stop chips from
  the persisted `stop_sequence`/`sort_order`. Ordinal only: **no clock, no ETA** (#258 Q6).
  Exception card states from real data: over-capacity, headroom, unavailable.
- **Critical interception strip** — `ESCALATION_REQUIRED` rows surfaced first-class above the deck,
  reusing the existing `IntradayManualAssignModal` and `manual-assign` path unchanged.
- **Work rail** — unassignable (itemised, with `NO_COVERAGE`/`ALL_DROPPED`), held (return date +
  approver), policy-withheld (**count, labelled as a count** — #284 returns `itemised: false`),
  changes today (adds · removes · swaps).
- **Plan** — the existing `SchedulerPreviewPage` projection composed in, not rebuilt: holds
  place/release, bucket watermark, and the per-decision layer it already fetches and discards
  (score, candidates, capacity-at-decision, `errors[]` — a failed zone must stop vanishing).
- **Replay** — a past run in the same deck layout over the run ledger + `/decisions` stream, with
  the existing `DecisionTrace` as the embedded per-ticket inspector (Concept C's role).
- **Provenance grammar** (#282 R2) rendered from `add_source`/`added_by`/`coverage_type_at_assign`:
  solid+dot = system · dashed + role·initials = human · heavy crimson = critical direct-assigned ·
  `RET` = return-date · ghost = not on a route. **Null provenance renders as unknown, never as
  system.** Add the violet token to `index.css` (see #290 — the theme has none today).
- **Nav** — `Today's Dispatch` becomes the primary Dispatch entry; Preview/Schedules/Intra-day/
  Dispatch Runs remain as supporting + historical rows. **Nothing is deleted.**

## Existing code to reuse

`SchedulerPreviewPage`, `DecisionTrace`, `ConfigInEffectPanel`, `IntradayManualAssignModal`,
`LoadBadge`, `MetricStrip`, `DispatchTimelineNote`, `SLABadge`/`TierBadge`, the
`dispatch-runs` API client, and #281's cross-links.

## Acceptance criteria

- [ ] AC1 — `/dispatch/today` renders the three modes; mode is URL-reflected (`?mode=`) so a link
      carries it, following the Preview page's `?date=`/`?se=` precedent.
- [ ] AC2 — The deck renders one card per zone engineer including engineers with **no** stops today.
- [ ] AC3 — Stops render in persisted order; no time or ETA appears anywhere on the surface.
- [ ] AC4 — Every counter traces to a payload field; a test asserts no literal counter in the JSX.
- [ ] AC5 — Provenance chips render system vs human vs unknown from `add_source`; a ticket with null
      provenance renders as unknown and **not** as a system decision.
- [ ] AC6 — Critical escalations are actionable from the cockpit via the existing modal.
- [ ] AC7 — Plan mode renders `errors[]` — a zone whose projection failed is visible, not absent.
- [ ] AC8 — Replay renders a past run's decisions in `processing_rank` order with the trace inspector.
- [ ] AC9 — Loading / empty / error / stale-run states are explicit, not blank.
- [ ] AC10 — ZM sees only their zone; role visibility unchanged from the existing pages (#282: the
      cockpit must not widen any role's reach).
- [ ] AC11 — Admin suite green; no existing page is deleted or regressed.