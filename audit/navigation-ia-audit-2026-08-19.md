# Navigation & Information Architecture Audit — FSM Admin Console

**Thirty-two doors, one corridor**

| | |
| --- | --- |
| **Scope** | `apps/admin/src` — 205 files, 31,241 LOC, 46 authenticated routes |
| **Branch / commit** | `feat/autoplant-integration` @ `77a7c1b` |
| **Date** | 2026-08-19 |
| **Type** | Analysis only — no source file was modified |
| **Focus** | Navigation, page hierarchy, information architecture, cross-page workflow |

Read: `AppRoutes.tsx`, `components/shell/{nav,breadcrumb,Sidebar,TopBar,AppShell,Footer}.tsx`, all 40
page components, `components/data/{MetricStrip,PageHeader,DataTable}.tsx`,
`backend/src/dashboard/dashboard.service.ts`, `CONTEXT.md`, `docs/SYSTEM-STATE-2026-07.md` §3k,
`docs/ui/desktop/v2-reference/`, and `git log` on `nav.ts`.

Companion document: `audit/frontend-ux-audit-2026-08-19.md` covers within-page density and
information load. This document covers only what happens *between* pages. §9 of that document
overlaps at the margins; where the two disagree, this one is the later read.

---

## Contents

1. [Executive summary](#1-executive-summary)
2. [The current navigation model](#2-the-current-navigation-model)
3. [The domain graph vs the page graph](#3-the-domain-graph-vs-the-page-graph)
4. [Findings, ranked](#4-findings-ranked)
5. [Why this happened](#5-why-this-happened)
6. [Recommended architecture](#6-recommended-architecture)
7. [Journeys, before and after](#7-journeys-before-and-after)
8. [Cost of each recommendation](#8-cost-of-each-recommendation)
9. [Appendix — route ledger](#9-appendix--route-ledger)

---

## 1. Executive summary

The console has **46 addressable authenticated screens**. **32 of them have zero contextual inbound
links** — no page, table row, KPI card, or button anywhere in the application leads to them. The
sidebar is the only way in.

That is the finding. It is not "the sidebar has too many items"; the sidebar count is a symptom. The
sidebar is the application's *only corridor*, so every task necessarily walks back into it.

| Metric | Value |
| --- | --- |
| Authenticated routes | 46 |
| Routes reachable only from the sidebar | **32** |
| Routes with ≥1 contextual inbound link | 14 |
| Sidebar rows — Operations Head | **37** (36 with `OPS_EXPLORER_ENABLED` off) |
| Sidebar rows — Central Service Manager | 27 |
| Sidebar rows — Zonal Manager | 26 |
| Sidebar rows — Warehouse Manager | 5 |
| Nested layout routes in the app | **1** (`/tickets`) |
| Pages that read their filters from the URL | **4** of 40 |
| Competing global navigation taxonomies | **5** |
| Outbound links from the ticket detail view | **0** |

The five most consequential defects, in order:

1. The dashboard's Action Required panel — nine urgency-sorted live counts, each mapping to an
   existing route — is not clickable.
2. Opening a ticket from any queue silently unmounts that queue and strands the user in
   `/tickets`.
3. The ticket detail view, the richest entity surface in the product, links to nothing.
4. Only `DeviceDetailPage` reads filters from the URL, which blocks most contextual deep-linking.
5. Six routes describe one entity (the Service Engineer) with zero links between them.

Two of these are afternoon-scale linking fixes. See §8.

---

## 2. The current navigation model

### 2.1 The nav data model has no third level

All navigation is produced by one pure function, `buildNav(role, features)` in
`components/shell/nav.ts`:

```ts
interface NavLink  { label: string; to: string; icon: Icon; }
interface NavGroup { heading: string; items: NavLink[]; }
function buildNav(role: string, features: NavFeatures = {}): NavGroup[]
```

`NavGroup → NavLink`, and nothing further. **There is no representation for a sub-page, a tab, or a
contextual view.** A page is either a top-level sidebar row or it is not in the navigation at all.
That constraint — not any design decision — is what forces every feature to become a peer of every
other feature.

### 2.2 What each role sees

| Role | Rows | Groups | Shape |
| --- | ---: | --- | --- |
| Warehouse Manager | 5 | Warehouse (4) · Support (1) | Coherent. The only role whose nav fits its job. |
| Zonal Manager | 26 | Operations (18) · Components & Warehouse (2) · Analytics (5) · Support (1) | An 18-row scrolling list with no internal order. |
| Central Service Manager | 27 | …+ Policy (1) | Identical to ZM plus one orphaned setting. |
| Operations Head | 37 | …+ Analytics (6) · Admin (9) | Six groups, 37 peers, no hierarchy. |

The manager `Operations` group, in source order — `Zone Dashboard, Tickets, Create Install,
Schedules, Scheduler Preview, Dispatch Runs, Intra-day Queue, SE Activity, Manage SEs, SE Planner,
Verification Review, Readiness & Vehicle, Non-Operational, Cross-Zone, Tier Overrides, Recovery
Decisions, Leave Requests, Expense Vouchers` — mixes a dashboard, a list, a create form, three
dispatch views, four SE surfaces, five decision queues, and one policy setting as equals.

### 2.3 Five competing taxonomies

Beyond the sidebar there are four more global navigation surfaces. No two agree on how the product is
organised.

**The breadcrumb** (`shell/breadcrumb.ts`) is derived *from the sidebar array* by longest-prefix
match, plus six hard-coded detail patterns. It is therefore never deeper than the sidebar is:

- a route absent from `buildNav` resolves to the literal crumb `Dashboard › Console`;
- because the match is exact-or-prefix and returns a two-crumb trail on an exact hit, the Reports
  family renders as `Dashboard › Root Cause Analytics` — the `/reports` parent is skipped. The URL
  hierarchy is real but invisible.

**The footer** (`shell/Footer.tsx`) invents a fifth grouping — `Command Center / Planning /
Warehouse / Governance` — over 16 links, **not role-gated**. A Warehouse Manager sees "Settings" and
"Exports"; clicking either silently bounces them to `/` via `RoleRoute`. The file's own comment
acknowledges this and treats it as safe: *"Role-gated targets are safe for all viewers: `RoleRoute`
redirects an unauthorized role back to `/`."* A silent redirect to an unrelated page is not a safe
outcome for the person clicking.

**The Help Center** keeps a sixth list. Four of its Analytics topics — Reports, Device Detail,
Root-Cause Analytics, System Efficiency — point at `to: '/'`, the dashboard. It omits roughly fifteen
shipped pages entirely (dispatch runs, cross-zone, vouchers, install create, tier overrides, plant
zones, bulk unassign, exports, build health, ops explorer, engineers/manage, commissioning, scheduler
preview, fleet directory, assignment threshold).

**The top bar** carries the breadcrumb, a global search that submits to `/reports/device?search=`,
and one primary CTA — **"Assign SE"** — whose handler is `navigate('/')`. It is a decorative button
occupying the most valuable pixels on screen. (Note: `SYSTEM-STATE` §3k records that the global
search was itself decorative until 2026-08-17 and was fixed; the same class of defect is still live
one control to its right.)

### 2.4 Pages have no visible identity

`components/data/PageHeader.tsx` renders its title and subtitle `sr-only`. The visible title block
was deliberately removed as duplicative of the breadcrumb — a defensible density decision in
isolation, with a navigational cost that was not priced:

> the top bar's breadcrumb already names the page, so the card was a second, larger copy of
> information the operator had just read

The consequence is that a page's entire visible identity is a two-crumb trail in the top bar plus a
highlighted sidebar row. **There is no place on any page that says what the page is, what it is part
of, or where to go next.**

The `actions` slot survives and 15 of ~40 pages use it. Every one of those is an Export or a Create
control. **Not one is a navigational action.** The v2 reference put an `INTRA-DAY QUEUE` button in
the Zone Dashboard header (`01-dashboard-zonal-manager.png`) and a `BACK TO TICKETS` control on
Ticket Detail (`08-ticket-detail.png`) — both are page-level navigation in exactly this slot, and
neither was built.

### 2.5 Two concrete defects

**Breadcrumb collision.** `resolveBreadcrumb` scans `DETAIL_CRUMBS` before the nav table, and its
`/^\/schedules\/([^/]+)$/` pattern matches `/schedules/preview`. The Scheduler Preview page (#251)
therefore renders `Dashboard › Schedules › Schedule Detail`. `AppRoutes.tsx` guards against this
exact literal-vs-param collision in its own route ordering, with a comment saying so; the breadcrumb
resolver does not, and `test/breadcrumb.test.tsx` has no case for it.

**No catch-all route.** `AppRoutes` has no `*` route. A mistyped or retired URL matches nothing, so
the pathless layout route never renders — the result is a blank page with no shell, no message, and
no way back except the browser's Back button.

---

## 3. The domain graph vs the page graph

### 3.1 What the domain connects

From `CONTEXT.md` §Relationships and the API clients, the entity graph is a strict spine with
clusters hanging off it. Every arrow below is a page transition a manager genuinely makes.

```
Zone ──▸ Plant ──▸ Company ──▸ Vehicle ──▸ DEVICE
                                             │
                                             ├─▸ Failure Cycle ──▸ TICKET (troubleshoot|install|recovery)
                                             │                       │
                                             │                       ├─▸ Verification Run
                                             │                       ├─▸ Troubleshoot Form ──▸ Root Cause
                                             │                       ├─▸ Component Request ──▸ Warehouse
                                             │                       ├─▸ Vehicle Unavailability Report
                                             │                       ├─▸ Non-Operational marking ──▸ Recovery Ticket
                                             │                       └─▸ Assignment
                                             │                            │
                                             │                            ▼
Dispatch Run ──▸ Zone result ──▸ BATCH ──▸ Work Schedule (SE day plan)
                                             │
SERVICE ENGINEER ◂───────────────────────────┘
   ├─▸ Coverage (plant | territory)     ├─▸ Availability / Leave
   ├─▸ Van stock                        └─▸ Expense Voucher
```

### 3.2 What the pages connect

Counting, for each route, how many places in the application link to it — **excluding** the sidebar,
footer and Help Center, which are global lists rather than contextual navigation:

| Cluster | Routes | Inbound | Assessment |
| --- | --- | ---: | --- |
| **Fleet investigation** | `/reports/device`, `/reports/fleet`, `/tickets/:id` | 8 · 4 · 8 | Well connected — the one worked example in the app. |
| **Dispatch chain** | `/dispatch-runs/:runId`, `/…/zones/:zoneId`, `/batches/:id`, `/schedules/:seId` | 2 · 2 · 3 · 2 | Linked downward only; the chain dead-ends at Batch. |
| **Decision queues** | `/verification`, `/readiness/×3`, `/cross-zone`, `/component-blocked`, `/intraday` | **0 each** | Sidebar only. |
| **Engineer cluster** | `/engineers`, `/engineers/manage`, `/engineers/planner`, `/leave-requests`, `/vouchers`, `/coverage` | **0 each** | Sidebar only. |
| **Reports family** | `/reports`, `/reports/root-cause`, `/reports/system-efficiency`, `/reports/commissioning`, `/reports/zm-scorecard`, `/reports/csm-approval-share` | **0 each** | Sidebar only. |
| **Admin & policy** | `/settings`, `/plant-zones`, `/plant-deactivations`, `/tier-overrides`, `/assignment-threshold`, `/bulk-unassign`, `/exports`, `/ops-explorer` | **0 each** | Sidebar only. |
| **Warehouse** | `/warehouse/requests`, `/warehouse/shadow-use`, `/warehouse/recovery-receipt` | 1 · 1 · **0** | The WM dashboard links two of its own three queues. |

The complete set of internal navigation call sites in `pages/` and `components/` is **33 links**
across a 46-route application. Twenty-two of those 33 point at either `/tickets/:id` or
`/reports/device`.

---

## 4. Findings, ranked

### F1 — CRITICAL · The Action Required panel is not clickable

The backend returns nine cards, sorted by urgency, each with a live count
(`dashboard.service.ts:292–300`):

| key | label | urgency | route that already exists |
| --- | --- | ---: | --- |
| `unreviewed_batches` | Auto-dispatched batches awaiting review | 1 | `/schedules` · `/dispatch-runs` |
| `vehicle_unavailability` | Vehicle Unavailability & readiness conflicts | 2 | `/readiness/vehicle-unavailability` |
| `critical_insertions_awaiting_accept` | CRITICAL insertions awaiting SE Acceptance | 3 | `/intraday` |
| `failed_verification` | Failed Verification items | 4 | `/verification` |
| `component_blocked` | Component-Blocked Tickets | 5 | `/component-blocked` |
| `waiting_component_overdue` | WAITING_COMPONENT over 7 days | 6 | `/component-requests` |
| `non_op_awaiting_manager` | Non-Op requests awaiting manager confirmation | 7 | `/readiness/non-operational` |
| `manual_assignment_required` | Manual assignment required (retry exhausted) | 8 | `/tickets?assignmentState=UNASSIGNED` † |
| `recovery_stalled` | Recovery Tickets stalled 14+ days | 9 | `/readiness/recovery-decisions` |

† blocked by F4 — `TicketsPage` ignores query params.

`pages/dashboard/ActionRequiredPanel.tsx` renders all nine as inert `<Card>` elements. No `Link`, no
`onClick`.

This is the product's own triage list telling the manager exactly what to do next, and then requiring
them to find the matching sidebar row from memory — where the labels do not match. *"Non-Op requests
awaiting manager confirmation"* is filed under the sidebar row `Non-Operational`; *"Vehicle
Unavailability & readiness conflicts"* under `Readiness & Vehicle`.

### F2 — CRITICAL · Opening a ticket from any queue destroys that queue

`/tickets/:ticketId` is a child route of `/tickets`, so the drawer only ever renders over the ticket
list:

```tsx
<Route path="/tickets" element={<TicketsPage />}>
  <Route path=":ticketId" element={<TicketDetailDrawer />} />
</Route>
```

Seven surfaces deep-link into it — Verification Review, Component Blocked, Component Requests, Shadow
Use, Intra-day Queue, Vehicle Unavailability, Vouchers. When a manager clicks a row in Verification
Review, that queue is unmounted and the full Tickets page mounts underneath the drawer. Closing calls
`navigate('/tickets')` **unconditionally**, so they are left standing in the ticket list — position,
filters and queue context all gone.

This is the single behaviour that makes every queue a one-shot. A manager cannot process a queue row
by row, which is the only way any of these queues is meant to be worked.

### F3 — CRITICAL · The ticket detail view links to nothing

The Overview tab (`TicketDetailDrawer.tsx:220–275`) renders Device, Vehicle, Company, Plant, Assigned
SE, Batch # and Schedule # as plain text. Every one has a working destination that accepts exactly
the identifier already on screen:

| rendered as text | existing destination |
| --- | --- |
| `ticket.deviceId` | `/reports/device?search=` |
| `ticket.plantName` / `plantId` | `/reports/device?plantId=` |
| `ticket.companyName` / `companyId` | `/reports/fleet?tab=companies` |
| `ticket.assignedSeId` | `/schedules/:engineerId` |
| `ticket.batchId` | `/batches/:batchId` |
| `ticket.scheduleId` | `/schedules/:engineerId` |

The only action on the entire surface is *"Manually close Recovery Ticket"*.

**The v2 reference specified the opposite.** `08-ticket-detail.png` is a full page with an entity
chip row (Device · Vehicle · Plant · Company · Transporter · Zone), a `BACK TO TICKETS` control, and
an **Action Center** rail carrying six contextual jumps — Review Evidence, Reassign, Override with
Reason, Trigger Verification Retry, Escalate, and *Open Component Request*. What shipped is an
informational drawer with six read-only tabs.

### F4 — CRITICAL · Only one page reads its filters from the URL

`useSearchParams` appears in four page files:

| page | params read |
| --- | --- |
| `DeviceDetailPage` | `search`, `status`, `zoneId`, `companyId`, `plantId`, `bucket`, `commissionedWithinDays` |
| `SettingsPage` | `tab` |
| `FleetDirectoryPage` | `tab`, `companyId` |
| `TicketDetailDrawer` | `tab` |

`DeviceDetailPage` is, not coincidentally, the best-connected page in the application. **Every other
page holds its filters in local `useState`** — including `TicketsPage`
(`useState<TicketFilters>({})`, line 48).

This is the hard blocker under most contextual navigation. It also means no filtered view is
shareable, and browser Back discards filter state on every list in the product.

### F5 — HIGH · Six routes for one entity: the Service Engineer

| route | what it is |
| --- | --- |
| `/engineers` | derived Activity Status, Set Availability |
| `/engineers/manage` | admin-entered SE CRUD + plant coverage |
| `/engineers/planner` | plant-visit intent grid |
| `/leave-requests` | leave approvals |
| `/vouchers` | expense voucher review |
| `/coverage` | floating-SE territory config (OH-only, filed under **Admin**) |
| `/schedules/:seId` | the SE's day plan |

Seven surfaces about one person, occupying six sidebar rows across three different groups, with
**zero** links between them.

There is no page in the application that answers *"tell me about this engineer."* A manager approving
a leave request cannot see the day plan that leave will disrupt. The schedule detail page cannot
reach availability. The SE Activity row does not link to the schedule it summarises.

`SeManagementDirectoryPage`'s own error copy points at the split:
`FLOATING_USES_TERRITORY: 'Floating SEs use the Territory page, not plant coverage.'` — a
cross-page instruction delivered as an error string, with no link.

### F6 — HIGH · The dispatch timeline is three sidebar rows and a dead end

`Scheduler Preview` (what tomorrow's run *would* do), `Schedules` (what today's run produced, per SE)
and `Dispatch Runs` (the ledger of past runs) are three views of one timeline presented as three
unrelated destinations. `SchedulerPreviewPage`'s own docstring names the relationship:

> That page is the *post*-dispatch twin of this one, so matching it is what makes the two read as one
> workflow rather than two designs.

The navigation expresses that nowhere — the two are adjacent rows only because they were added in
that order.

The drill-down chain `Run → Zone → Batch` also terminates. `DispatchBatchDetailPage` displays
`detail.seName`, `detail.plantName` and every `r.ticketId` in the batch — none linked. To see that
SE's actual day plan, the user returns to the sidebar, opens Schedules, and searches by name.

### F7 — HIGH · Reports is a seventh report sitting at the parent URL

`/reports` renders Fleet Uptime. It does not link to `/reports/root-cause`,
`/reports/system-efficiency`, `/reports/commissioning`, `/reports/device`, `/reports/zm-scorecard` or
`/reports/csm-approval-share`. Its only header action is a CSV Export.

The URL hierarchy asserts a parent-child relationship the page contradicts, and the breadcrumb —
derived from the sidebar rather than the route tree — hides it too.

### F8 — HIGH · The readiness pipeline is split across four rows and two role groups

Vehicle Unavailability → Non-Operational confirmation → Recovery Decision → Recovery Receipt is one
sequential process; a device moves through all four stages. The first three are manager rows under
`Operations`; the fourth is a Warehouse Manager row under `Warehouse`. Nothing links any stage to the
next.

The URL prefix `/readiness/` implies a parent page that does not exist — there is no `/readiness`
route — though `docs/ui/desktop/v2-reference/10-readiness.png` exists.

### F9 — HIGH · Role-gating the container forced features out of it

`/settings` is `RoleRoute`-gated to Operations Head **as a whole console**. So when a setting had to
be co-owned with another role, the only available move was a new top-level route. `AppRoutes.tsx`
says so outright:

> the setting is co-owned with the CSM and the Settings console is OH-only, so the one shared control
> is routed rather than the whole console widened

`/assignment-threshold` renders `AssignmentThresholdSection` — the identical component the Settings
console already renders as a tab under *Field operations*. `/tier-overrides` exists for the same
reason. `/plant-zones`, `/plant-deactivations`, `/coverage`, `/exports`, `/build-health` and
`/ops-explorer` are all configuration or administration surfaces sitting outside the configuration
console.

The whole-console gate is a routing convenience that became an IA decision.

### F10 — MEDIUM · One page, two sidebar rows, two roles

`ComponentRequestsPage` is mounted at `/warehouse/requests` (Warehouse Manager, acting) and again at
`/component-requests` with a `readOnly` prop (managers, observing). Both appear in their respective
sidebars under the label **Component Requests**.

The same work item therefore has two addresses depending on who is looking, so a manager cannot send
a Warehouse Manager a link to the thing they are both discussing.

### F11 — MEDIUM · Half the dashboard's KPIs drill; half do not

`MetricStrip` already supports a per-metric `onClick` and renders a real `<button>` when one is
present (`MetricStrip.tsx:24,160`). The ZM dashboard wires it on three of six cards — Companies,
Plants, Operational Fleet. **Fleet Uptime, Inactive Operational Devices and Critical Devices — the
three that actually describe a problem — are inert.** The Reports page's six metrics are all inert.

The v2 reference draws a drill-through arrow (`↗`) on every KPI card.

### F12 — MEDIUM · Breadcrumb collision and missing 404

Both described in §2.5. Small, concrete, independently fixable.

---

## 5. Why this happened

This is not carelessness. Each page in isolation is well built: the queue pages share a documented
"canonical queue recipe," `DataTable` is one component with 38 render sites, KPI definitions live in
a single catalog (`lib/kpiCatalog.ts`) surfaced in-product by `KpiInfo`, and the SLA colour ramp is
script-validated for colour-blind legibility. The problem is entirely *between* the pages.

Three forces produced it.

**1. The reference set stopped; the backlog did not.** `docs/ui/desktop/v2-reference/` holds 28
screens, and its sidebar (`01-dashboard-zonal-manager.png`) shows ~13 rows in three groups. Roughly
twenty routes have shipped since with no designed place: Dispatch Runs, Cross-Zone, Vouchers, Install
Create, Tier Overrides, Plant Zones, Bulk Unassign, Exports, Build Health, Data Explorer,
Commissioning Cohort, Scheduler Preview, Fleet Directory, SE Directory, Leave Requests, Recovery
Decisions, Non-Operational, Assignment Threshold, CSM Backup Share, Recovery Receipt.

`git log --follow` on `nav.ts` shows **17 commits**, each appending one row:

```
2026-08-19  feat(#251): tomorrow's plan, shown without a gate in front of it
2026-08-17  feat(#238): a second threshold for when an SE is sent
2026-08-13  feat(#232): the commissioning cohort admin surface
2026-08-06  feat(#217): Operations Data Explorer
2026-07-29  feat(#179): Slice 4 — admin UI
2026-07-27  feat(#157) slice 5 — tier-overrides admin surface
2026-07-23  feat(#158) slice 2 — OH can move a plant's zone
2026-07-20  feat(#131) build-health UI parity
2026-07-16  feat(#123) dispatch-runs transparency
2026-07-14  feat(#119) slice 3 — OH Plant Deactivations
2026-07-14  feat(#121) slice 2 — OH Exports page + nav entry
…
```

The reference set also specified a **secondary top-bar navigation** — `Help ▾ · Contact ▾ · Raise
Concern ▾ · Support ▾ · Settings ▾` dropdowns — which was never built. Some of the sidebar's
overflow was designed to live there.

**2. The nav model has no third level.** §2.1. A new page can only be a peer, so nothing can be a
sub-page.

**3. The vertical-slice discipline stops at the page boundary.** `CLAUDE.md`'s parity gate asks
whether an issue's own UI was built. It does not ask what links *to* it. Every issue therefore
shipped complete and correct, and the corridor grew by one door.

### The codebase has already solved this twice, locally

`SettingsPage` was eleven flat peer tabs. Its rewrite grouped them into four named sections with a
one-sentence purpose each, added roving focus, and put the open section in `?tab=` so
"Settings → Dispatch Schedule" became a sendable link. The docstring makes the argument precisely:

> Eleven peer tabs across the top asked the operator to read every label before they could act, and
> said nothing about what any of them meant to each other — "Zones" and "Scoring Weights" looked like
> the same kind of thing. They are not.

And `#193` added `ZoneDrilldownSection` to Device Detail specifically so the page

> answers "how bad is this zone, where, and who's holding it" **without a trip back to the
> dashboard.**

Both are the right instinct applied at page scope. Neither could be applied at application scope,
because the nav model cannot express it.

---

## 6. Recommended architecture

**Principle: group by the object the user is working on, not by the issue that built the page.**

Seven top-level destinations plus Reports, Admin and Help, each with tabbed sub-navigation, and five
detail pages promoted to hubs. **No page is deleted, no functionality moves, and every route named
below already exists.**

### 6.1 Current vs proposed

**Current — Operations Head, 37 peers**

```
Operations               Zone Dashboard · Tickets · Create Install · Schedules ·
                         Scheduler Preview · Dispatch Runs · Intra-day Queue ·
                         SE Activity · Manage SEs · SE Planner · Verification Review ·
                         Readiness & Vehicle · Non-Operational · Cross-Zone ·
                         Tier Overrides · Recovery Decisions · Leave Requests ·
                         Expense Vouchers
Components & Warehouse   Component Blocked · Component Requests
Analytics                Reports · Device Detail · Commissioning Cohort ·
                         Root Cause Analytics · System Efficiency · ZM Scorecard
Policy                   SE Assignment Threshold
Admin                    Data Explorer · Coverage · CSM Backup Share · Bulk Unassign ·
                         Plant Deactivations · Plant Zones · Exports · Build Health · Settings
Support                  Help
```

**Proposed — 9 destinations, the same 46 routes**

```
Dashboard      /                    role variant · every card and KPI drills

Work           /tickets             All · Unassigned · Critical+ · Special
                                    Create Install → an action, not a row
                                    ▸ Ticket  /tickets/:id  — HUB

Review         /review              Verification · Vehicle Unavailability ·
                                    Non-Operational · Recovery Decisions ·
                                    Component Blocked · Cross-Zone
                                    one tab bar, live counts, shared queue chrome

Dispatch       /dispatch            Preview (tomorrow) · Schedules (today) ·
                                    Runs (history) · Intra-day
                                    ▸ Run → Zone → Batch → SE day plan, linked both ways

Engineers      /engineers           Activity · Directory · Planner · Leave ·
                                    Vouchers · Coverage
                                    ▸ Engineer  /engineers/:seId  — HUB

Fleet          /fleet               Devices · Plants · Companies
                                    ▸ Device  /fleet/devices/:id  — HUB

Warehouse      /warehouse           Requests · Shadow Use · Recovery Receipt
                                    one route per queue; WM acts, managers observe

Reports        /reports             index page listing: Fleet Uptime · Root Cause ·
                                    System Efficiency · Commissioning · ZM Scorecard ·
                                    CSM Backup Share · Exports

Admin          /settings            Organisation · Field operations · Rules & policy ·
                                    Governance
                                    + Coverage, Plant Zones, Deactivations, Tier Overrides,
                                      Assignment Threshold, Bulk Unassign, Build Health,
                                      Data Explorer
                                    per-section role gating replaces the whole-console gate

Help           /help
```

**Operations Head: 37 → 9. Zonal Manager: 26 → 7. Warehouse Manager: 5 → 3.** Eighteen sidebar rows
become tabs inside the destination they belong to.

### 6.2 Which pages genuinely deserve top-level navigation

| Deserves top level | Because |
| --- | --- |
| Dashboard | The daily entry point for every role. |
| Work (Tickets) | The central object; every other surface refers back to it. |
| Review | The manager's actual job — a set of decisions, currently six rows. |
| Dispatch | A distinct mental mode (planning, not triage) with its own timeline. |
| Engineers | A first-class entity with six surfaces and no home. |
| Fleet | The asset view; the global search target belongs here. |
| Warehouse | A separate role's whole world, and managers' oversight of it. |
| Reports | Periodic, not operational — deliberately separated from daily work. |
| Admin | Configuration, entered rarely and deliberately. |

| Is really a sub-page | Belongs under |
| --- | --- |
| Verification Review, Vehicle Unavailability, Non-Operational, Recovery Decisions, Component Blocked, Cross-Zone | Review — tabs |
| Scheduler Preview, Schedules, Dispatch Runs, Intra-day Queue | Dispatch — tabs |
| SE Activity, Manage SEs, SE Planner, Leave Requests, Expense Vouchers, Coverage | Engineers — tabs |
| Device Detail, Fleet Directory | Fleet — tabs |
| Root Cause, System Efficiency, Commissioning, ZM Scorecard, CSM Backup Share, Exports | Reports — index entries |
| Tier Overrides, Assignment Threshold, Plant Zones, Plant Deactivations, Bulk Unassign, Build Health, Data Explorer | Admin — sections |

| Is really a contextual action | Should be |
| --- | --- |
| Create Install | A button on the Work list and on a Plant hub — not a nav row. |
| Bulk Unassign | An action on a filtered ticket selection. |
| Assign SE (top bar) | Either wired to a real assignment surface, or removed. |

### 6.3 Detail pages as hubs

Five entities are where investigations converge. Each already renders the data — it just renders it
as text.

| Hub | Should reach | Data already on the page |
| --- | --- | --- |
| **Ticket** `/tickets/:id` | device · plant · company · SE day plan · batch · run · component requests · verification run · other tickets on this device | All of it — Overview plus five lazy-loaded tabs. |
| **Device** `/fleet/devices/:id` | open ticket · downtime history · plant · company · zone · root-cause history | Links the open ticket; the rest is plain. |
| **Engineer** `/engineers/:seId` | day plan · availability · leave · vouchers · coverage · van stock · today's tickets | Split across six pages; no hub exists. |
| **Batch** `/batches/:id` | run · zone · SE day plan · each ticket · plant | All rendered; only run and zone linked. |
| **Zone** `/fleet?zoneId=` | devices · plants · scorecard · SEs · dispatch runs | `ZoneDrilldownSection` already does most of this. |

### 6.4 Roles

**Keep one taxonomy across roles; vary emphasis, not structure.**

The temptation is to give each role its own shape. The acting-as-ZM mechanic makes that actively
harmful: a Central Service Manager who enters a zone must find the ZM's surfaces exactly where the ZM
would describe them over the phone. What should vary:

- **Zonal Manager** — lands on the zone dashboard. Review and Dispatch carry live counts. Reports is
  one row; Admin is absent.
- **Central Service Manager** — lands on the cross-zone tower. Cross-Zone is promoted out of Review
  to a first-class tab; the acting-zone control stays in the top bar.
- **Operations Head** — lands on Pan-India. Reports and Admin expand; Review collapses to a summary,
  since the OH confirms rather than triages.
- **Warehouse Manager** — three destinations: Dashboard, Warehouse, Help. Their dashboard should link
  all three of their own queues, not two.

Role differences belong in *which tabs appear* and *what the landing route is* — never in a different
set of top-level nouns.

---

## 7. Journeys, before and after

### 7.1 Morning triage — a ZM clears the Action Required panel

**Now**

```
Dashboard — reads "Failed Verification: 12"
  → scan the 26-row sidebar for a matching label       ← round-trip 1
Verification Review — click a row
  → ticket drawer opens OVER THE TICKETS PAGE
Decide · close drawer
  → lands in /tickets; queue position lost
  → sidebar → Dashboard                                ← round-trip 2
Reads "Component-Blocked: 7"
  → sidebar → Component Blocked                        ← round-trip 3
… repeat for all nine cards
```

Cost: **9 sidebar round-trips to clear 9 cards**, queue position lost every time.

**Proposed**

```
Dashboard — click "Failed Verification: 12"
Review › Verification, pre-filtered
Click a row → ticket opens OVER THIS QUEUE
Decide → next unresolved → … queue drains in place
Tab across to Component Blocked — no sidebar
```

Cost: **1 entry, 0 round-trips**, position preserved.

### 7.2 "Why did this ticket go to this engineer?"

**Now**

```
Ticket drawer — reads "Batch #4471" as text
  → sidebar → Dispatch Runs                            ← round-trip 1
Find today's run by timestamp → open
Find the zone card → open
Find the batch in the table → open
Decision trace found. Now: is that SE overloaded?
  → sidebar → Schedules → search the SE by name        ← round-trip 2
  → sidebar → SE Activity for their status             ← round-trip 3
```

Cost: **3 round-trips, 8 steps** — and the batch ID was on screen at step 1.

**Proposed**

```
Ticket → click "Batch #4471"
Batch detail — decision trace, SE named and linked
  → Engineer hub: day plan, load, availability, van stock
Breadcrumb back to the ticket at any point
```

Cost: **0 round-trips, 3 steps.**

### 7.3 A plant is complaining about repeat failures

**Now**

```
Dashboard → Company/Plant Overview → inactive count
Device Detail, plant-scoped                            ← this link works
Open ticket                                            ← this link works
  → sidebar → Root Cause Analytics — CANNOT SCOPE TO THE PLANT
  → sidebar → Commissioning Cohort to check install quality
  → sidebar → Component Requests for parts history
```

Starts well — this is the app's one linked path — then collapses. The reports family is unreachable
in context and, once reached, cannot inherit the plant scope.

**Proposed**

```
Dashboard → Fleet › Plants → plant hub
Devices · open tickets · root cause · install cohort · parts — as tabs on the plant
Each tab carries the plant scope forward
```

Cost: **1 entry, scope never re-entered.**

---

## 8. Cost of each recommendation

### 8.1 Navigation / linking only

No routing change, no new page, no data change. Every target route and every needed query parameter
already exists.

| Change | Where | Why it is cheap |
| --- | --- | --- |
| Action Required cards become links | `ActionRequiredPanel.tsx` | All 9 targets are live routes; add a `key → route` map. |
| Ticket Overview entities become links | `TicketDetailDrawer.tsx` | Every target accepts the identifier already rendered (see F3 table). |
| All KPI cards drill | `ZmDashboard`, `OpsHeadDashboard`, `ReportsPage` | `MetricStrip` already renders a `<button>` when `onClick` is set. |
| Reports landing indexes its family | `ReportsPage.tsx` | Six links plus role gating mirroring `buildNav`. |
| Batch → SE day plan, → tickets, → plant | `DispatchBatchDetailPage.tsx` | `seId`, `ticketId`, `plantId` are all in the payload. |
| SE pages cross-link | `SeManagementPage`, `ScheduleDetailPage`, `LeaveRequestsPage` | Shared `seId`; `/schedules/:seId` exists. |
| WM dashboard links Recovery Receipt | `WarehouseDashboard.tsx` | Two of three queues are already linked there. |
| Fix four Help Center targets pointing at `/` | `HelpCenterPage.tsx` | Typo-class defect. |
| Role-gate the footer; align its headings to the sidebar's | `Footer.tsx` | Reuse `buildNav` instead of a second hand-kept list. |
| Fix the `/schedules/preview` breadcrumb | `breadcrumb.ts` | Check the literal path before `DETAIL_CRUMBS`. Add the missing test. |
| Give "Assign SE" a real destination, or remove it | `TopBar.tsx` | Currently `navigate('/')`. |
| Add a catch-all 404 route | `AppRoutes.tsx` | One route. |

### 8.2 Routing / page-structure changes

Listed in dependency order — the first two unblock most of the rest.

| Change | Touches | Depth |
| --- | --- | --- |
| **URL-backed filters on every list**, starting with `TicketsPage` | `TicketsPage` + ~10 queue pages | Moderate. `useState` → `useSearchParams`; the pattern is proven on `DeviceDetailPage`. **Prerequisite for most contextual links.** |
| **A third level in the nav model** — `NavGroup → NavLink → NavLink[]` | `nav.ts`, `Sidebar.tsx`, `breadcrumb.ts`, `test/sidebar-shell.test.tsx` | Moderate. Without it nothing can be a sub-page. Breadcrumbs should then derive from the route tree, not the nav array. |
| **Layout routes with tabbed sub-nav** — `/review`, `/dispatch`, `/engineers`, `/fleet`, `/warehouse` | `AppRoutes.tsx` + 5 shell components | Moderate. Only `/tickets` nests today. Old paths redirect; page bodies unchanged. |
| **Ticket detail as a full page with an Action Center** | `TicketDetailDrawer` → `TicketDetailPage` | Deeper. This is the v2 reference's own design. Keep the drawer for in-list peeking; give the ticket a real page for investigation. |
| **Per-section role gating in Settings**, absorbing 8 admin routes | `SettingsPage`, `RoleRoute`, `AppRoutes` | Deeper. Removes the reason `/tier-overrides` and `/assignment-threshold` exist separately. |
| **Split `/reports/device`** into a Fleet list and a Device detail page | `DeviceDetailPage` (650 lines), `ZoneDrilldownSection` | Deeper. It is currently three surfaces in one — fleet explorer, zone drill-down, device detail — and also the global search target. |
| **An Engineer hub at `/engineers/:seId`** | new page over 5 existing API clients | Deeper. No new endpoints; composition only. |
| **De-duplicate `/component-requests` and `/warehouse/requests`** | `AppRoutes`, `ComponentRequestsPage` | Shallow-structural. One route; derive `readOnly` from role. |

### 8.3 If only one thing

**Make the Action Required panel clickable, and stop the drawer from swallowing its queue.**

The first is an afternoon's work against nine routes that already exist, and it converts the
dashboard from a report into a launchpad — which is what it was designed to be. The second makes
every queue in the application processable row by row instead of one ticket at a time.

Together they remove more sidebar round-trips than the entire restructure that follows, and neither
requires a routing change.

---

## 9. Appendix — route ledger

All 46 authenticated routes. **In** = contextual inbound links, excluding sidebar, footer and Help
Center.

| Route | Role gate | In | Linked from |
| --- | --- | ---: | --- |
| `/` | all | — | logo, breadcrumb, TopBar "Assign SE" |
| `/tickets` | all | 1 | drawer close (unconditional) |
| `/tickets/:ticketId` | all | 8 | Verification, ComponentBlocked, ComponentRequests, ShadowUse, Intraday, VehicleUnavailability, Vouchers, DeviceDetail, CompanyPlantTable |
| `/install` | ZM/CSM/OH | **0** | — |
| `/schedules` | ZM/CSM/OH | 1 | ScheduleDetail back-link |
| `/schedules/preview` | ZM/CSM/OH | **0** | — |
| `/schedules/:engineerId` | ZM/CSM/OH | 2 | SchedulesPage row, OpsExplorer drilldown |
| `/dispatch-runs` | ZM/CSM/OH | 3 | back-links from its own detail pages |
| `/dispatch-runs/:runId` | ZM/CSM/OH | 2 | DispatchRunsPage row, ZoneDetail back |
| `/dispatch-runs/:runId/zones/:zoneId` | ZM/CSM/OH | 2 | RunDetail ZoneCard, BatchDetail |
| `/batches/:batchId` | ZM/CSM/OH | 3 | ZoneDispatchTable, CompanyPlantTable, self |
| `/intraday` | ZM/CSM/OH | **0** | — |
| `/engineers` | ZM/CSM/OH | **0** | — |
| `/engineers/manage` | ZM/CSM/OH | **0** | — |
| `/engineers/planner` | ZM/CSM/OH | **0** | — |
| `/leave-requests` | ZM/CSM/OH | **0** | — |
| `/vouchers` | ZM/CSM/OH | **0** | — |
| `/verification` | ZM/CSM/OH | **0** | — |
| `/readiness/vehicle-unavailability` | ZM/CSM/OH | **0** | — |
| `/readiness/non-operational` | ZM/CSM/OH | **0** | — |
| `/readiness/recovery-decisions` | ZM/CSM/OH | **0** | — |
| `/cross-zone` | ZM/CSM/OH | **0** | — |
| `/component-blocked` | ZM/CSM/OH | **0** | — |
| `/component-requests` | ZM/CSM/OH | **0** | — |
| `/warehouse/requests` | WM | 1 | WarehouseDashboard |
| `/warehouse/shadow-use` | WM | 1 | WarehouseDashboard |
| `/warehouse/recovery-receipt` | WM | **0** | — |
| `/reports` | ZM/CSM/OH | **0** | — |
| `/reports/device` | ZM/CSM/OH | 8 | TopBar search, ZM KPI, OH KPI, ScorecardTable, InactiveCountLink ×3, FleetDirectory, Commissioning, OpsExplorer |
| `/reports/fleet` | ZM/CSM/OH | 4 | ZmDashboard ×2, OpsHeadDashboard ×2 |
| `/reports/root-cause` | ZM/CSM/OH | **0** | — |
| `/reports/system-efficiency` | ZM/CSM/OH | **0** | — |
| `/reports/commissioning` | ZM/CSM/OH | **0** | — |
| `/reports/zm-scorecard` | OH | **0** | — |
| `/reports/csm-approval-share` | OH | **0** | — |
| `/tier-overrides` | ZM/CSM/OH | **0** | — |
| `/assignment-threshold` | CSM/OH | **0** | — |
| `/bulk-unassign` | OH | **0** | — |
| `/plant-deactivations` | OH | **0** | — |
| `/plant-zones` | OH | **0** | — |
| `/coverage` | OH | **0** | — |
| `/exports` | OH | **0** | — |
| `/build-health` | OH | 1 | BuildHealthNotice |
| `/ops-explorer` | OH + flag | **0** | — |
| `/settings` | OH | **0** | — |
| `/help` | all | **0** | — |

**14 routes linked · 32 sidebar-only.**

---

*No files were modified by this audit. Counts are from the working tree at `77a7c1b` on
`feat/autoplant-integration`.*
