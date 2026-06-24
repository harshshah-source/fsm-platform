# FSM Platform — UI Ownership Plan (Issues 01–21)

> Planning artifact. **No implementation, no code changes.** Maps every completed backend capability
> (Issues 01–21) to the Admin/Mobile surface that should expose it. Backend-led TDD continues — this
> does **not** switch the roadmap to UI-first. Screenshot references (`docs/ui/desktop/v2-reference/`,
> `docs/ui/mobile/`) are the parity authority per `docs/agents/workflow.md` / `domain.md`.
> Companion to `UI-RECOVERY-PLAN.md` and `DOC-RECONCILIATION-GOVERNANCE-REVIEW.md`.

Status: ✅ complete · 🟡 partial · ❌ missing · n/a. Effort: **S**/**M**/**L**.

## Consolidated UI Ownership Table — Issues 01–21

| Issue | Backend | Admin UI | Mobile UI | Reference | Existing surface to use | Missing UI work | Ownership | Effort |
|---|---|---|---|---|---|---|---|---|
| **01** Foundation/infra | ✅ auth, RBAC, Prisma, settings | ✅ `LoginPage`, `AdminShell`, `AuthProvider` | 🟡 auth shell only (`Login`/`Session`) | `v2/00-login` | Login + shell (both apps) | Mobile beyond login = the shell itself (no tabs/screens) | **New issue** (Mobile Foundation) | L |
| **02** Org/reference config + Settings | ✅ zones/plants/users/companies/engineers/coverage/SLA/scoring/kit/geo CRUD | 🟡 `SettingsPage`+`sections`, `TerritoryPage` | n/a | `v2/26-settings` | `SettingsPage` | Plants admin CRUD page; Company-update page; full user-mgmt UI; surface code-constant settings (geofence radius, PGI window) | **Future** (45 Plants, 46 Company, 49) + **retrofit** Settings | M |
| **03** Notifications & audit spine | ❌ not built (ready-for-human) | ❌ | ❌ | (none) | — | **No backend to surface** — out of scope until built (then: notification center / audit viewer) | n/a | — |
| **04** Snapshot + data-as-of | ✅ | ✅ `SnapshotBanner` | ❌ home last-sync | `mobile/home-dashboard.png.png` | Mobile Home (unbuilt) | Online/last-sync pill on mobile Home | **New issue** (Mobile Home) | S |
| **05** Device state + ticket creation | ✅ | ✅ via Tickets/Dashboard | n/a | — | TicketsPage, DashboardHome | none (system pipeline) | — | — |
| **06** Zone Dashboard | ✅ | 🟡 cards stubbed, no KPI strip, no role variants | n/a | `v2/01`(+`02/03/04/05`) | `DashboardHome`, `ActionRequiredPanel` | 8 live Action cards; KPI strip (uptime %); role-variant dashboards | **Retrofit** + **future** (27/new variants) | M+M |
| **07** Ticket List & Detail | ✅ | 🟡 4 of 6 drawer tabs stub | ❌ | `v2/07,08,28`; `mobile/tickets-priority-view`, `ticket-detail-ready` | `TicketsPage`, `TicketDetailDrawer`; none (mobile) | Admin: fill Forms/Components/Assignment tabs, badge cols. Mobile: list + detail | Admin **retrofit**; Mobile **new issue** | M+L |
| **08** Auto-recovery + repeat | ✅ | 🟡 badges render; manual-close no button | n/a | `v2/08` | `TicketDetailDrawer` | Manual "mark auto-recovery (pre-submission)" control | **Retrofit** / 08 follow-up | S |
| **09** Coverage/territory | ✅ | 🟡 polygon editor disabled | n/a | (org config; no v2 screen) | `TerritoryPage` | Polygon map-drawing editor | **New issue** (spatial editor) | L |
| **10** Recommender scoring | ✅ | 🟡 reasoning shown; no gate-skip view | n/a | `v2/01` (gate area) | `DashboardHome`/`ScheduleDetailPage` | Company-Tier gate-skip / starve-depth panel (Decision §3) | **Future issue** (dashboard panel) | M (low) |
| **11** Batch dispatch → Day Plan | ✅ | 🟡 no KPI strip/card badges/pickup stop | ❌ Day Plan | `v2/12`; `mobile/home-dashboard` | `SchedulesPage`; none (mobile) | Admin: KPI strip, card badges, pickup stop. Mobile: Day Plan home | Admin **retrofit**; Mobile **new issue** | S/M+L |
| **12** SE Shared Pool | ✅ | n/a | ❌ Ticket Pool | `mobile/home-dashboard` ("Open Ticket Pool") | none (mobile) | Pool entry + list (separate from Assigned) | **New issue** (M-series) | M |
| **13a/b** ZM Monitoring & Override | ✅ | 🟡 near-complete | n/a | `v2/12` | `SchedulesPage`, `ScheduleDetailPage`, `CriticalQueue` | KPI strip; drag-reorder (now position-based); reason-code vocab | **Retrofit** (polish) | S/M |
| **14a/b** SE Planner | ✅ | 🟡 minor gaps | n/a | `v2/16` | `PlannerPage` | Date-range/cadence picker; engineer names; real drag | **Retrofit** (minor) | S |
| **15** Soft states + activity ping | ✅ | ❌ no SE-activity surface | ❌ no soft-state actions | `v2/15-se-activity`; `mobile/ticket-detail-ready` | none (admin); none (mobile) | Admin: SE Activity board. Mobile: VIEWED/ON_SITE/Start + geofence prompt | Admin **future** (25); Mobile **new issue** | M+M |
| **16** Troubleshoot form | ✅ | 🟡 Forms tab stub | ❌ | `mobile/troubleshooting`; `v2/08` Forms tab | `TicketDetailDrawer`; none (mobile) | Admin: submitted-form view. Mobile: full form | Admin **retrofit**; Mobile **new issue** | S+L |
| **17** Offline queue | ❌ not built | n/a | ❌ | `mobile/*` (offline states) | — | **No backend to surface** — build-from-scratch, not surfacing | n/a (existing issue 17) | — |
| **18** GPS verification | ✅ | ✅ (via 19) | ❌ | `v2/14` (done); `mobile/verification`, `ticket-detail-verification-pending` | `VerificationReviewPage`; none (mobile) | Mobile: verification view + PARTIAL_RECOVERY badge + CTA | Mobile **new issue** | M |
| **19** Verification Review page | ✅ | ✅ `VerificationReviewPage` | n/a | `v2/14` | — | none | — | — |
| **20** QR + Technical Hints | ❌ not built | n/a | ❌ | `mobile/*` | — | **No backend to surface** — build-from-scratch | n/a (existing issue 20) | — |
| **21** Van Stock + Component-Blocked | ✅ | 🟡 page done; no AR cross-link/WM status | ❌ | `v2/17` (done); `mobile/inventory`, `home` kit badge | `ComponentBlockedPage`; none (mobile) | Admin: AR cross-link, real WM status. Mobile: Stock screen + Home kit badge | Admin **21 follow-up** + future (22/23); Mobile **new issue** | S+M |

*Fully complete (no UI work): 05, 19. Complete-for-scope: 04 admin banner, 01 auth. Not backend-complete (excluded from surfacing): 03, 17, 20.*

---

## A. Retrofit Queue (existing screens needing parity work)

| # | Screen / file | Work | Serves | Effort |
|---|---|---|---|---|
| A1 | `TicketDetailDrawer.tsx` | Fill Forms / Components / Assignment-History tabs; add manual auto-recovery-close button | 07, 08, 16(admin) | M |
| A2 | `TicketsPage.tsx` | Missing inline badge columns; align filters to `v2/07` | 07 | S |
| A3 | `DashboardHome.tsx` + `ActionRequiredPanel.tsx` | Wire 8 live Action cards; add KPI metric strip (uptime % + counts) | 06 | M |
| A4 | `SchedulesPage`/`ScheduleDetailPage.tsx` | KPI strip; per-ticket card badges; optional drag-reorder | 11, 13 | S/M |
| A5 | `PlannerPage.tsx` | Date-range/cadence picker; engineer display names; real drag | 14 | S |
| A6 | `ComponentBlockedPage.tsx` | Action-Required cross-link; real WM action status (after 22/23) | 21 | S |
| A7 | `SettingsPage.tsx` | Surface code-constant config (geofence radius, PGI window, stuck-snapshot threshold) | 02 | S |
| A8 | `TerritoryPage.tsx` | Enable polygon map-drawing editor | 09 | L |
| A9 | `AdminShell.tsx` nav | Remove/disable 3 dead labels (`Intra-day`, `Engineers`, `Reports`); group nav into OPERATIONS/COMPONENTS/ANALYTICS | nav-integrity | S |

---

## B. Admin UI Missing Features (backend complete, admin UI absent — net-new)

| # | Feature | Backend evidence | Reference | Effort |
|---|---|---|---|---|
| B1 | **SE Activity board** | Issue 15 `activity-status.ts`, `/soft-state`, `/activity-ping` | `v2/15-se-activity` | M |
| B2 | **Plants admin / Company-update / user-mgmt pages** | Issue 02 org CRUD APIs | `v2/26-settings` | M |
| B3 | **Company-Tier gate-skip / starve-depth panel** | Issue 10 `recommendations` + canonical sort | `v2/01` | M (low) |
| B4 | **Role-variant dashboards** (CSM-acting, Ops-Head, Warehouse) | Issue 06 aggregations + acting-context | `v2/02,03,04,05` | M |

*(Everything else admin-side is retrofit, Section A — the core screens already exist.)*

---

## C. Mobile UI Missing Features (backend complete, mobile UI absent — all net-new)

All blocked on a **Mobile Foundation** shell that no issue currently owns.

| # | Feature | Backend endpoint | Reference | Effort |
|---|---|---|---|---|
| C0 | **Mobile Foundation** (RN shell, bottom-tabs Home/Tickets/Stock/Vouchers/Profile, component kit, offline-aware client) | — (prerequisite) | all mobile mockups | L |
| C1 | **Home** — last-sync (04) · Day Plan/Next Visit/Plant Workload (11) · kit badge (21) · Open Ticket Pool (12) | `/api/schedules/me`, `/api/me/van-stock`, `/api/me/shared-pool`, snapshot latest | `home-dashboard.png.png` | L |
| C2 | **Tickets list + Ticket Detail** (07) | `/api/tickets`, `/api/schedules/me` | `tickets-priority-view`, `ticket-detail-ready` | L |
| C3 | **Soft-state actions** on detail (15) | `/soft-state` | `ticket-detail-ready` | M |
| C4 | **Troubleshoot form** (16) | `/api/tickets/:id/troubleshoot` | `troubleshooting.png.png` | L |
| C5 | **Verification view + PARTIAL_RECOVERY badge** (18) | `/api/tickets/:id/verification` | `verification.png.png`, `ticket-detail-verification-pending` | M |
| C6 | **Stock screen** (21) | `/api/me/van-stock` | `inventory.png.png` | M |

---

## D. Ownership Recommendations (which issue owns each gap; retrofit / follow-up / new)

| Gap | Owning issue | Type |
|---|---|---|
| A1–A9 retrofits | Originating issue lineage (06/07/08/11/13/14/02/09) + a small **admin-retrofit issue** for cross-cutting (drawer tabs, dashboard cards) | **Retrofit** (no new screen) |
| 08 manual auto-recovery button | Issue 08 | **Extend existing issue** (or fold into A1) |
| 21 Action-Required cross-link / WM status | Issue 21 (cross-link) + Issues 22/23 (WM status) | **Follow-up** + future |
| B1 SE Activity board | **Issue 25** (planned) | Future issue (planned) |
| B2 Plants / Company / users pages | **Issues 45, 46, 49** (planned follow-ups) | Follow-up (planned) |
| B3 gate-skip panel · B4 role dashboards | **New issue** (dashboard panel) · **27** + **new** (Ops-Head/Warehouse variants) | New / future |
| 09 polygon editor | **New issue** (spatial editor) | New issue |
| C0 Mobile Foundation | **New issue** (file first) | New issue |
| C1–C6 mobile surfaces | **New M-series** issues, each parented to its done backend issue (04/07/11/12/15/16/18/21) | New issues (follow-ups of done backend) |

**Key ownership finding:** the only *unowned* gaps are the **Mobile Foundation + M-series (C0–C6)**, the **polygon editor (09)**, and **B3/B4 dashboard variants**. Everything else maps to an existing or already-planned issue. Filing C0 + M-series converts all mobile `❌` from orphaned to tracked.

---

## E. Recommended Sequencing

Backend-led TDD continues uninterrupted; this orders only the **surfacing** work.

1. **First — Foundations & tracking:** file **Mobile Foundation (C0)** + **M-series** + the **admin-retrofit issue**; add design-system primitives (DataTable/MetricStrip/StatusPill). *Without C0, nothing mobile can proceed.*
2. **Second — Admin retrofit (cheapest visibility wins, screens exist):** A1 → A2 → A3 → A4 → A5 → A6 → A7 → A9. Surfaces completed backend for 06/07/08/11/13/14/02/21 at S/M effort.
3. **Third — Admin net-new:** B1 SE Activity (Issue 25), then B2 (45/46/49).
4. **Fourth — Mobile field loop (largest gap):** C1 Home → C2 Tickets/Detail → C3 soft-state actions → C4 Troubleshoot form → C5 Verification → C6 Stock — restores the end-to-end SE workflow.
5. **Fifth — Lower-priority surfacing:** A8 polygon editor (09), B3 gate-skip panel (10), B4 role-variant dashboards (06/27).

---

**Bottom line:** every completed backend capability in 01–21 maps to a specific surface — **9 admin retrofits**, **4 net-new admin features** (mostly owned by 25/45/46/27), and **1 Mobile Foundation + 6 mobile surfaces** (currently unowned). No backend rebuild is needed anywhere; 03/17/20 are excluded because their backend isn't built (nothing to surface yet).
