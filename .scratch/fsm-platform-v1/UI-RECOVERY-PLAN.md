# FSM Platform — UI Recovery Plan

> Planning artifact. **No implementation.** Derived from the UI Parity Report and the platform Audit Report (2026-06-23).
> Targets: **≥80% parity** vs admin-v2 mockups (`docs/ui/desktop/v2-reference/`, 28 screens) and **≥80% parity** vs mobile-v2 mockups (`docs/ui/mobile/`, 10 screens).

## Constraints & prerequisites (read first)

- **No admin-v2 / mobile-v2 source code exists in this repo** — only static PNG mockups. "Copy/adapt" below means *replicate from the mockup and/or reuse greenfield's own components*, not fork a source tree.
- **Orphaned mobile issues:** the mobile screens' backend issues (11, 12, 15, 16, 18) are marked **done** but each deferred its "RN screen" to "a later mobile issue" that **was never filed**. Only Issues **17 (offline)** and **20 (QR)** exist for mobile. This plan proposes new **M-series mobile UI issues**; file them into `INDEX.md` Follow-ups before starting.
- **Baselines:** Admin ≈ **25%** (7.0 effective / 28). Mobile ≈ **3%** (0.3 / 10).
- **80% thresholds:** Admin = **22.4** effective screens. Mobile = **8 of 10** screens.

---

## 1. Missing screens grouped by business value

**Tier 1 — Field execution (without these the platform cannot run a repair)**
- Mobile: Home, Tickets/Day-Plan + Ticket Pool, Ticket Detail (ready), Ticket Detail (verification-pending), Troubleshooting form, Verification.
- Admin: Dashboard live Action-Required + KPI strip; Ticket Detail drawer real tabs.

**Tier 2 — Daily manager operations**
- Admin: SE Activity; Readiness; Vehicle Unavailability; Intra-day Queue.

**Tier 3 — Components & Warehouse persona**
- Admin: Component Blocked Queue; Component Requests; Shadow Use Queue; Warehouse Stock; Warehouse dashboard (role-scoped nav).
- Mobile: Stock/Inventory; Vouchers.

**Tier 4 — Config & secondary**
- Admin: Settings completeness; Plants Admin; Company Update; role-variant dashboards (CSM-acting, Central Service, Ops-Head, Ops-Head read-only ticket).
- Mobile: QR Scanner + Technical Hints; Offline queue (reliability, not a screen).

**Tier 5 — Analytics & support (the deferrable 20%)**
- Admin: Reports landing, Device Detail, Root Cause Analytics, System Efficiency, ZM Performance Scorecard, Help Center.
- Mobile: Daily-status, Profile.

---

## 2. Which backlog issues build each screen

| Reference screen | Backlog issue(s) | Notes |
|---|---|---|
| 01 Dashboard ZM (live cards + KPI) | 06 (built) + each card's owning issue (11/18/21/22/25/28/29/35) | Cards flip on as their issue lands |
| 02/03/04 Dashboard CSM-acting / Central / Ops-Head | 27 (acting scope) + **new** role-variant UI | Backend acting-context exists; UI variants new |
| 05 Dashboard Warehouse | 21 | New persona shell + scoped nav |
| 07 Tickets / 08·28 Ticket Detail tabs / 09 read-only | 16, 18, 21, 22, 11–13 (tab data) + small | Tabs already stubbed in `TicketDetailDrawer` |
| 10 Readiness · 11 Vehicle Unavailability | 28 | Backend + UI both in 28 |
| 12 Batch Schedule | done (13a/b) | Polish only (KPI strip, card badges) |
| 13 Intra-day Queue | 29, 30 (+31, 32) | SE Acceptance / timeout / escalation |
| 14 Verification Review | done (19) | — |
| 15 SE Activity | 25 | SE Management + Activity Status |
| 16 SE Planner | done (14b) | — |
| 17 Component Blocked Queue | 21 | — |
| 18 Component Requests | 22, 23 | — |
| 19 Shadow Use Queue | 24 | — |
| 20 Warehouse Stock | 21 | — |
| 21 Reports / 22 Device Detail / 23 Root Cause / 24 System Efficiency / 25 Scorecard | 39, 40 / 44 / 41 / 42 / 43 | Need charts |
| 26 Settings (complete) | 02 follow-ups 45, 46, 49 | Plants UI, Company Update, deal_type |
| 27 Help Center | **new issue** | No backlog item |
| **Mobile** Home | **M1** (parent 11/15) | new |
| **Mobile** Tickets / Day-Plan / Pool | **M2** (parent 11/12) | new |
| **Mobile** Ticket Detail (ready + verification-pending) | **M3** (parent 15/16/18) | new |
| **Mobile** Troubleshooting | **M4** (parent 16) | new |
| **Mobile** Verification | **M5** (parent 18) | new |
| **Mobile** Offline queue | 17 (exists) | reliability |
| **Mobile** QR + Technical Hints | 20 (exists) | capability |
| **Mobile** Stock/Inventory | **M6** (parent 21/22) | new |
| **Mobile** Vouchers | **M7** (parent 38) | new |
| **Mobile** Daily-status / Profile | **M8** (parent 25/26) | deferrable |

---

## 3. Recommended implementation order

Two parallel tracks (admin can proceed independently of mobile once shared primitives exist). **Phase 0 is shared and must come first.**

**Phase 0 — Shared foundations**
- P0a: Design-system install (shadcn) + admin primitives (`DataTable`, `MetricStrip`, `StatusPill`, `SlideOver`, `Modal`, `Toast`, chart).
- P0b: Mobile shell + RN component kit (`BottomTabBar`, `TicketCard`, `StatTile`, `IconSelectGrid`, `PhotoCaptureRow`, charts) + **file the M-series issues**.

**Admin track:** A1 Dashboard live + role-grouped nav → A2 Ticket Detail tabs + tickets/read-only → A3 SE Activity (25) → A4 Readiness + Vehicle Unavailability (28) → A5 Component Blocked Queue (21) → A6 Warehouse Stock + Warehouse dashboard (21) → A7 Component Requests (22/23) → A8 Shadow Use Queue (24) → A9 Intra-day Queue (29/30) → A10 Settings + Plants/Company (45/46/49) → A11 Reports + Fleet Uptime (39/40/42) → A12 Device Detail (44).

**Mobile track:** M1 Home → M2 Tickets/Day-Plan/Pool → M3 Ticket Detail → M4 Troubleshooting → M5 Verification → 17 Offline → M6 Stock → M7 Vouchers. (20 QR and M8 daily-status/Profile after 80%.)

---

## 4. Estimated UI completion after each issue

**Admin** (start 25%; 80% = 22.4 effective / 28):

| Step | Screens delivered/upgraded | Δ eff | Cumulative | % |
|---|---|---|---|---|
| A1 | 01 complete; 02/03/04 partial variants | +2.0 | 9.0 | 32% |
| A2 | 07, 08, 28 complete; 09 | +2.5 | 11.5 | 41% |
| A3 | 15 SE Activity | +1.0 | 12.5 | 45% |
| A4 | 10 Readiness, 11 Vehicle Unavail | +2.0 | 14.5 | 52% |
| A5 | 17 Component Blocked | +1.0 | 15.5 | 55% |
| A6 | 20 Warehouse Stock, 05 Warehouse dash | +2.0 | 17.5 | 63% |
| A7 | 18 Component Requests | +1.0 | 18.5 | 66% |
| A8 | 19 Shadow Use Queue | +1.0 | 19.5 | 70% |
| A9 | 13 Intra-day Queue | +1.0 | 20.5 | 73% |
| A10 | 26 Settings complete (+Plants/Company) | +0.5 | 21.0 | 75% |
| A11 | 21 Reports + Fleet Uptime | +1.0 | 22.0 | 79% |
| **A12** | 22 Device Detail | +1.0 | **23.0** | **82% ✅** |

→ **Admin crosses 80% at A12.** Deferred 20%: 23 Root-Cause, 24 System-Efficiency, 25 Scorecard, 27 Help, full CSM/Central dashboards.

**Mobile** (start 3%; 80% = 8 of 10):

| Step | Screen(s) | Cumulative | % |
|---|---|---|---|
| M1 | home-dashboard | 1 | 10% |
| M2 | tickets-priority-view (+Day-Plan/Pool) | 2 | 20% |
| M3 | ticket-detail-ready | 3 | 30% |
| M4 | troubleshooting | 4 | 40% |
| M5 | ticket-detail-verification-pending **+** verification | 6 | 60% |
| 17 | (offline — reliability, 0 screens) | 6 | 60% |
| M6 | inventory (Stock) | 7 | 70% |
| **M7** | vouchers | **8** | **80% ✅** |

→ **Mobile crosses 80% at M7.** Deferred 20%: daily-status, profile. (20 QR adds capability but isn't one of the 10 screens.)

---

## 5. Screens that can be copied / adapted (replicate from mockup + reuse greenfield components)

Unambiguous mockups consistent with the current authoritative domain — build by replicating layout and reusing existing greenfield components:

- **Table-driven admin screens:** Component Blocked Queue, Component Requests, Shadow Use Queue, Warehouse Stock, SE Activity — same pattern (MetricStrip + filterable DataTable + StatusPill). Reuse `lib/slaBucket`, shared `DataTable`/`MetricStrip`.
- **Readiness, Vehicle Unavailability** — table + colour-coded status, directly readable from mockups 10/11.
- **Device Detail / Reports landing** — chart + table; mockups 21/22 are clear.
- **Ticket Detail drawer tabs** — shell exists (`TicketDetailDrawer`); fill the 4 stub tabs from mockups 08/28. Pure reuse.
- **Mobile Home, Tickets, Ticket Detail (both states), Verification, Vouchers, Stock** — mockups detailed and match current Decisions (troubleshooting "Location captured on submit" = Decision §9; Home "Open Ticket Pool" = Shared Pool). Replicate directly.
- **Batch Schedule / Verification Review / SE Planner / Settings / Login** — already built; only **adapt** (add KPI strip / card badges to batch schedule).

## 6. Screens that must be redesigned (mockup conflicts with superseded Decisions, or workflow changed)

Do **not** copy these literally — reconcile against CONTEXT.md *Flagged ambiguities* / Decisions first:

- **Dashboard "Batch Schedule Review" (12) & any "Approve" affordance** — Decision §7 removed the approval gate (`AUTO_ASSIGNED → OVERRIDDEN`, no `PENDING_REVIEW`). Keep greenfield's monitoring + post-hoc override shape, not the mockup's review framing.
- **Ticket Detail (08/09/28)** — drop any `REVIEW_PENDING` state or **SE Confirmation / trust_score** (REVIEW_PENDING dropped; SE Confirmation removed; presence is multi-signal). Redesign tabs around `presence_source` + `VERIFICATION_PENDING`.
- **Readiness (10)** — `EXPECTED_BACK` removed; enum is `AT_PLANT | UPCOMING_TRIP | ON_TRIP | STALE | UNKNOWN | WAITING_CONFIRMATION | AVAILABLE_FOR_REPAIR`; STALE/UNKNOWN are colour hints, not blockers.
- **Dashboard Action-Required panel (01)** — card *set* is defined by the current issue backlog (8 sources), not the mockup snapshot.
- **Role dashboards (02/03/04)** — design CSM-acting banner + `acted_as_role` surfacing from real acting-context (Decision §15), not the mockup.
- **Intra-day Queue (13)** — confirm acceptance vocabulary matches Decision §16 (SE Acceptance, 10-min Acceptance Timeout, 3-retry escalation, decline reason codes) and the **no pre-emptive activity-ping filter** rule before wiring.
- **Override reason inputs (anywhere)** — backend is **free-text**; either keep free-text or first add a reason-code vocabulary to CONTEXT.md (a domain decision, not a UI one).

---

## Summary

| Track | Start | 80% reached at | Critical path |
|---|---|---|---|
| **Admin** | 25% | **A12 (~82%)** | P0a → A1…A12 (issues 21, 22, 23, 24, 25, 28, 29/30, 39/40/42, 44 + dashboard/ticket polish) |
| **Mobile** | 3% | **M7 (80%)** | P0b → M1…M7 (new M-series + existing 17) |

**Two prerequisites before any screen work:** (1) install the shared design system / RN kit (Phase 0); (2) file the orphaned **M-series mobile UI issues** into the backlog. Reports/analytics/help and mobile daily-status/profile are the intended deferred 20% on each side.
