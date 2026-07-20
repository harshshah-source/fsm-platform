# 12 — Tables

> Part of the [UI Redevelopment Handoff](20-master-index.md). Previous: [11 — Forms](11-forms.md) · Next: [13 — Dialogs](13-dialogs.md).

## The reusable table — `DataTable<T>` (`components/data/DataTable.tsx`)

```ts
interface Column<T> { key; header: ReactNode; render?; align?: 'left'|'right'; className?;
                      sortable?: boolean; sortValue?: (row) => string|number }
props: { columns; rows; rowKey(row); ariaLabel; onRowClick?; rowTestId?; rowAccent?;
         loading?; error?; onRetry?; empty?; stickyHeader?; maxBodyHeight? = '70vh' }
```

Behavior contracts: caps header row (`bg-surface-raised`); optional **client-side sort** (click header toggles asc/desc, `aria-sort`, ▲/▼); **sticky header** mode (internal scroll, opaque header cells); **loading** = 5 skeleton rows matching real cell padding; **error** = `ErrorState` + Retry across colSpan; **empty** = `EmptyState` or `empty` prop; clickable rows get `tabIndex=0` + Enter/Space activation and hover/focus styles, `<tr>` keeps implicit `row` role; `rowAccent` adds a severity `border-l-2`; `rowTestId` → `data-testid`. The wrapper is a rounded bordered card with `overflow-x-auto`.

## Every table in the app

| Table (aria-label) | Page | Columns | Sort | Filter | Pagination | Selection | Row actions / click |
|---|---|---|---|---|---|---|---|
| Tickets | TicketsPage | Ticket (id8+device), Work Type, Plant/Company, Tier, Status, Inactive (duration badge), Age, Flags | server (bucket desc) | 4 selects + companyId/plantId inputs (server query) | none (server-scoped list) | — | row → `/tickets/:id` |
| Batch Schedules | SchedulesPage | Engineer, Dates, Batches, Tickets, Status | none | — | — | — | row → `/schedules/:seId` |
| Intra-day Queue | IntradayQueuePage | Event, Ticket, SE, SE Acceptance (placeholder), By, At | none | — | — | — | ticket-id button → drawer |
| SE Management | SeManagementPage | SE (button), Activity, Coverage, Availability, Active Tickets, Kit | none | — | — | — | name → detail panel |
| SE Directory | SeManagementDirectoryPage | Name (button), Phone, Email, Address, Zone, Mapped Plants, Mapped Companies (—), Status | none | zone select (client) | — | — | name → edit panel |
| Leave Requests *(plain table)* | LeaveRequestsPage | Engineer, Type, Window, Reason, Status, [Actions] | none | — | — | — | Approve / Reject inline |
| SE Planner grid *(bespoke)* | PlannerPage | Engineer, Coverage, Batch Schedule, + 7 day cells | none | plant picker | — | — | drag/drop + add/remove intents |
| Vehicle Unavailability Reports | VehicleUnavailabilityPage | Report, Ticket, Vehicle & Plant, Reason, Filed by, Expected date, Primary SLA, Secondary SLA, Status, Actions | none | — | — | — | Confirm date / Resume SLA |
| Non-Operational dual confirmation | NonOperationalQueuePage | Device, Reason, Deal Type, State, Awaiting, Actions | server (awaiting_since asc) | — | — | — | Confirm / Override-confirm |
| Recovery decision queue | RecoveryDecisionQueuePage | Ticket, Device, Unable reason, Actions | none | — | — | — | Reschedule / Close FAILED / Escalate |
| Component-Blocked Queue | ComponentBlockedPage | Company, Zone, Engineer, Missing parts, Warehouse, Age | Age sortable (client) | text search (client) | — | — | row → ticket ?tab=Components |
| Component Requests | ComponentRequestsPage (both routes) | Request, Company, Zone, Component, Requested by, Ticket, Status, Age, Actions | none | — | — | — | Approve / Reject / Ship (or read-only) |
| Shadow Use Queue | ShadowUseQueuePage | Ticket, Component, Qty, Engineer, Company, Age, Actions | none | — | — | — | Reconcile / Dispute |
| Awaiting Warehouse Receipt | RecoveryReceiptQueuePage | Ticket, Device, Confirmed serial, Condition notes, Status, Actions | none | — | — | — | Confirm Receipt |
| Cross-Zone Auto-Escalations / Manual Flags (2 tables) | CrossZonePage | Ticket, Company+Tier, Bucket, Status, Age, [Actions] | none | — | — | — | Approve / Deny / Defer (deciders) |
| Verification review *(plain table)* | VerificationReviewPage | Company, Zone, Device, Outcome, Actions | none | outcome + company (server query) | — | — | row → ticket ?tab=Verification; Escalate / Mark auto-recovery |
| Expense Vouchers | VoucherReviewPage | [checkbox], Voucher, SE, Zone, Items, [Activity], Total, Submitted, [Status], [Actions] — columns vary by view | none | view toggle (server status param) | — | **multi-select** (approved view) → Mark PAID | Approve / Reject / Clarify; photo lightbox |
| Zone Overview | dashboard/ZoneOverviewTable | Zone, Inactive/Total, 8 bucket pills, Trend | none | zone + bucket selects (client) | — | — | CSV export |
| Company/Plant Overview *(bespoke grouped)* | dashboard/CompanyPlantTable | grouped: Company header → Plant, Inactive/Total, 8 buckets, Devices toggle | none | company select (client) | — | — | expand → lazy device sub-list; CSV export |
| Zone Performance Scorecard | dashboard/ScorecardTable | Zone, Inactive/Total, Critical+, Worst Bucket | client sortable (zone, inactive, critical) | — | — | — | — |
| Warehouse Stock / Component Request Queue / Shadow-Use Reconciliation | WarehouseDashboard | see [06](06-pages.md) | none | — | — | — | Adjust (stock) |
| Device list | DeviceDetailPage | Device ID, Vehicle Number, Company, Plant, Zone, Inactive Duration, SLA Bucket | server (5-value sort whitelist) | search + 4 selects (server query) | **server-paged** — PAGE_SIZE 100, Prev/Next, "Showing x–y of z", reset-on-filter-change | — | row → detail cards |
| Downtime summary | DeviceDetailPage | Month, Cycles, Downtime | none | — | — | — | toggle with chart |
| Zone breakdown | ReportsPage | Zone, Inactive w/ work, Critical+, Fleet Uptime | none | — | — | — | — |
| Root cause breakdown / Efficiency by zone / ZM scorecard / CSM Backup Share | report pages | see [06](06-pages.md) | none | — | — | — | — |
| CSV errors | InstallCreatePage | Line, Error, Field | none | — | — | — | — |
| Current territory | TerritoryPage | Coverage, [Remove] | none | — | — | — | Remove |
| Settings section lists (×8) + Role access matrix *(plain tables)* | settings/sections.tsx | per section | none | — | — | — | inline create/edit forms |

## Non-negotiables for redesign

1. `aria-label` on every table and `data-testid` per row are **test contracts** — keep them byte-identical.
2. Server-side ordering (tickets by bucket, non-op by awaiting_since) and server paging (devices) must not be re-implemented client-side.
3. The Device list pager semantics: filter/search/sort change resets to page 1; backend caps 200/page.
4. Bucket pill columns render count + `BUCKET_CLASS` color and header label + `BUCKET_RANGE_LABEL` range from `lib/slaBucket` — never hardcode ranges or colors.
5. CSV export buttons produce client-side CSVs via `lib/csv.ts` with the exact header rows currently emitted.
