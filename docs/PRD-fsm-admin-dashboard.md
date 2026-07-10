# PRD — FSM GPS Field Service Management

> **Status:** Final · **Date:** 2026-06-05
> **Products:** Admin Web Dashboard · SE Mobile App
> **Roles served:** Zonal Manager · Central Service Manager · Operations Head · Warehouse Manager · Service Engineer
> **Domain model & decisions:** see [CONTEXT.md](../CONTEXT.md)

---

## Problem Statement

A pan-India fleet of ~50,000 GPS devices must stay ≥98% active each month to meet contractual SLA commitments. A finite pool of ~40 Service Engineers (SEs) must be intelligently allocated to inactive devices across the country.

Currently there is no unified operations interface. Zonal Heads share work lists via Excel and WhatsApp at irregular intervals — alternate day, weekly, or 2–3 times a week depending on zone — with no structure, no audit trail, and no visibility into whether the work happened. There is no real-time view of which devices are inactive, no structured workflow for building and approving SE work schedules, no component availability tracking, and no single place to confirm whether GPS auto-verification succeeded after an SE visit. SEs have no structured way to receive plans, submit repairs, capture expenses, or signal field status.

The result is reactive fire-fighting: devices age past SLA thresholds, SE travel is wasted on uncoordinated visits, component consumption is untracked, and finance and compliance are done offline in spreadsheets.

---

## Solution

Two complementary products that together close the full Field Service Management lifecycle:

### Admin Web Dashboard

A browser-based command centre for Zonal Manager, Central Service Manager, Operations Head, and Warehouse Manager:

- **Situational awareness:** live zone / company / plant inactivity tables with SLA bucket drill-down and trend signals, data-as-of Snapshot timestamp on every panel.
- **Plant-wise Batch Schedule management:** the Recommender generates Plant-wise Batch Assignments per SE and **auto-dispatches them to the SE Day Plan**; Zonal Manager monitors and overrides post-hoc at a flexible Schedule Cadence (daily / alternate day / weekly / on-demand) — no approval gate, no auto-approve timer.
- **Intra-day control:** system-triggered CRITICAL/HIGH_CRITICAL insertions surface automatically with SE Acceptance flow; ZM can push manual same-day updates at any time; dashboard reflects real-time SE Acceptance status and WhatsApp Confirmation.
- **Component and inventory visibility:** Component-Blocked Queue and Shadow Use Queue make blocked and disputed inventory rows operational, not silent.
- **Verification governance:** GPS auto-verification outcomes reviewed with full three-phase detail.
- **Reporting:** Fleet Uptime %, Soft Inactive Count, SE productivity, and auto-recovery rates.
- **Configuration:** Operations Head manages zones, plants, SE mappings, SLA rules, company tiers, and user accounts.

### SE Mobile App

An Android/iOS app for Service Engineers in the field:

- **Work Schedule / Day Plan:** ordered, plant-clustered Ticket list; SE acts on assigned Tickets immediately on dispatch — no ZM approval gate, no pre-approval pending lock.
- **Ticket workflow:** soft-state progression (VIEWED → ON_SITE → TROUBLESHOOT_STARTED), offline-capable form submission with client-side dedup.
- **Intra-day insertion:** Accept/Decline flow with WhatsApp Confirmation on acceptance of urgent same-day dispatches.
- **Component handling:** component_unavailable flag, receipt confirmation, resubmit after spare arrives.
- **Install & Recovery:** distinct lifecycle screens for INSTALL and RECOVERY work types.
- **Expense Vouchers:** offline-capable draft with photo proof, linked to Ticket and/or Vehicle.
- **Leave & availability:** SOFT_UNAVAILABLE flag and Leave Request submission for ZM approval.
- **QR Scanner:** scan-to-open Ticket Detail shortcut — entry only, no state changes.
- **Technical Hints:** advisory diagnostic signals derived from device snapshot telemetry, shown on Ticket Cards and Ticket Detail.

---

## Roles & Product Access

| Role | Web Dashboard | Mobile App |
|---|---|---|
| Zonal Manager | Full access to own zone | — |
| Central Service Manager | Full cross-zone access + acting scope | — |
| Operations Head | Full fleet-wide access + Settings | — |
| Warehouse Manager | Warehouse queues only | — |
| Service Engineer | — | Full access |

When a Central Service Manager acts in a Zonal Manager's scope, a persistent **"Acting as Zonal Manager for [Zone]"** banner displays across every page. All such actions carry `acted_as_role = CENTRAL_SERVICE_MANAGER` in the audit trail (CONTEXT.md Decision §15).

| Page / Module | Zonal Manager | Central Service Manager | Operations Head | Warehouse Manager |
|---|---|---|---|---|
| Zone Dashboard Home | Own zone | All zones (read + acting scope) | All zones (read) | — |
| Batch Schedule Review | Own zone | Acting scope | All zones (read) | — |
| Intra-day Queue | Own zone | Acting scope | All zones (read) | — |
| Ticket List & Detail | Own zone | All zones | All zones | — |
| SE Management & Planner | Own zone | All zones (read) | All zones (read) | — |
| Verification Review | Own zone | All zones | All zones | — |
| Non-Op Marking Queue | Own zone | Acting scope | Own zone + override-confirm | — |
| Expense Voucher Review | Own zone | — | Export + Mark PAID | — |
| Component-Blocked Queue | Own zone | — | — | — |
| Component Requests | Own zone (read-only: component, ticket/device, SE, status, WM action, age) | All zones (read-only) | All zones (read-only) | All zones (approve/reject/ship) |
| Shadow Use Queue | — | — | — | All zones |
| Warehouse Stock | — | — | — | All zones |
| Cross-Zone Dashboard | — | Full access | Full access | — |
| Install Ticket Create / CSV | Own zone (create + CSV) | Authority scope (create + CSV) | All zones (create + CSV) | — |
| Reports | Own zone | All zones | All zones | — |
| Device Detail (downtime history/trend) | Own zone | All zones | All zones | — |
| Root Cause Analytics | Own zone | All zones | All zones | — |
| System Efficiency Report | Own zone | All zones | All zones | — |
| ZM Performance Scorecard | — (not a ZM self-score) | All zones (read) | Full access | — |
| Settings | — | — | Full access | — |

---

## User Stories

### Zonal Manager — Dashboard & Situational Awareness

1. As a Zonal Manager, I want to see a live summary of all inactive GPS devices in my zone broken down by SLA bucket (WARNING · EARLY_RISK · RISK · CRITICAL · HIGH_CRITICAL · SEVERE · VERY_SEVERE · LONG_PENDING), so that I know which devices are most urgent when I review and approve SE batch schedules.
2. As a Zonal Manager, I want to see inactive device counts per company and per plant (with drill-down from company → plant → device), so that I can identify which customer accounts are at risk of SLA breach.
3. As a Zonal Manager, I want to see a trend % for each zone row showing whether inactive counts are improving or worsening vs the previous day, so that I can spot deteriorating zones before they become critical.
4. As a Zonal Manager, I want to filter the Zone and Company Overview tables by zone, SLA bucket, company, and plant, so that I can focus on a specific slice of my operational load.
5. As a Zonal Manager, I want to export Zone Overview and Company/Plant Overview tables to Excel, so that I can share them in operations calls.
6. As a Zonal Manager, I want to see a data-as-of timestamp on every dashboard panel derived from the last successful Snapshot, so that I know how fresh my device data is and can escalate if it's stale.
7. As a Zonal Manager, I want an Action Required panel surfacing recently auto-dispatched batches not yet reviewed, Vehicle Unavailability Reports (expected-availability to confirm) and readiness conflicts, SLA-at-risk Tickets, Failed Verification items, Component-Blocked Tickets, and WAITING_COMPONENT Tickets exceeding 7 days, so that I can respond to pressing items without hunting through lists.
8. As a Zonal Manager, I want to see a Grouped Critical Work Queue of CRITICAL+ Tickets grouped by company/plant, with suggested SE assignment options and plant-cluster multiplier signals, so that I can act on batch plant assignments efficiently.

### Zonal Manager — Batch Schedule Review

9. As a Zonal Manager, I want to see each SE's auto-dispatched Plant-wise Batch Assignment (already live in the SE's Day Plan), so that I can monitor and override work assignments at my operational cadence (daily, alternate day, weekly, or on-demand) without a forced morning deadline or approval gate.
10. As a Zonal Manager, I want system-generated batches to be committed and immediately actionable by the SE without any approval action from me, so that normal scheduled work proceeds without a manual gate — my involvement is only needed when I choose to override.
11. As a Zonal Manager, I want to override a dispatched batch at any time — swapping the suggested SE, splitting a batch across SEs, removing specific Tickets, reordering stops, or deferring Tickets — so that I can correct Recommender suggestions that don't match field reality.
12. As a Zonal Manager, I want recently auto-dispatched batches I haven't yet reviewed flagged as `AUTO_ASSIGNED` (vs `OVERRIDDEN`), so that I can prioritise spot-checking system output — understanding the SE is already actioning them and no approval is required.
13. As a Zonal Manager, I want to override a dispatched batch at any time (including after an SE marks ON_SITE), with an explicit warning when the SE's physical presence is disrupted, so that overrides are deliberate and reason-coded, not accidental.
14. As a Zonal Manager, I want to see the Recommender's reasoning for each suggestion (Company Tier, Device Bucket, Priority Rank, Plant Cluster Multiplier) in a "why was this suggested?" panel, so that I can evaluate Recommendations with confidence.

### Zonal Manager — Intra-day Re-plan

15. As a Zonal Manager, I want to see real-time notifications when a new CRITICAL or HIGH_CRITICAL Ticket fires an Intra-day Re-plan, so that I know a mid-shift re-route is in progress.
16. As a Zonal Manager, I want to see the SE Acceptance status (pending, accepted, timed-out, declined) for each system-triggered intra-day insertion, so that I know whether the SE has committed to the assignment.
17. As a Zonal Manager, I want to see the full retry chain when an intra-day insertion times out and re-routes to the next-best SE, so that I understand why the final assignment is who it is.
18. As a Zonal Manager, I want to be escalated to for explicit assignment after 3 unsuccessful retries on an intra-day insertion, so that no CRITICAL Ticket sits unassigned while the system loops.
18a. As a Zonal Manager, I want to manually add, remove, or reorder Tickets in an SE's current Day Plan at any time during the shift (manual same-day update), without requiring SE Acceptance, so that I can make operational adjustments directly when field conditions change.
18b. As a Zonal Manager, I want to see an explicit conflict warning when my manual same-day update removes a Ticket from a plan where the SE holds an ON_SITE soft state, so that I don't accidentally disrupt an SE who is physically at that vehicle.
19. As a Zonal Manager, I want to manually flag any Ticket for cross-zone escalation before the auto-trigger fires, so that I retain judgment over when cross-zone capacity is warranted for Gold or Silver companies.

### Zonal Manager — Tickets

20. As a Zonal Manager, I want to view all open Troubleshoot and Install Tickets in my zone, filterable by work_type, status, company, plant, SLA bucket, and assignment state, so that I have a full picture of outstanding work.
20a. As a Zonal Manager, I want to create Install Tickets for Plants in my own zone (single create or CSV), so that I can enter new-device fitments for my zone without routing every request through Operations Head; my role is recorded as `created_by_role = ZONAL_MANAGER` with full audit.
21. As a Zonal Manager, I want to see a Ticket detail drawer showing the full lifecycle state, Failure Cycle history, form submissions, SE assignment, GPS verification status, and component usage, so that I have all context without leaving the list.
22. As a Zonal Manager, I want to see Tickets in `WAITING_COMPONENT` state clearly flagged, with days elapsed and the Component Request status, so that I know which Tickets are blocked on parts.
23. As a Zonal Manager, I want to be notified and see in the queue when a `WAITING_COMPONENT` Ticket exceeds 7 days, so that I can escalate, extend, or close-defer appropriately.
24. As a Zonal Manager, I want to see Repeat Failure and ESCALATED Tickets flagged distinctly, with links back to the previous Failure Cycle, so that I can identify devices with recurring inactivity patterns.
25. As a Zonal Manager, I want to see Auto-Recovery Ticket closures (`CLOSED_AUTO_RECOVERY`) separated from SE-repaired closures, so that SE productivity metrics are not inflated by self-healing devices.
26. As a Zonal Manager, I want to approve Non-Operational marking requests initiated by customers or my own team, so that Devices with confirmed vehicle scrapping or pausing are legitimately excluded from Fleet Uptime calculation.
27. As a Zonal Manager, I want to review and resolve readiness conflicts (UNKNOWN / STALE / WAITING_CONFIRMATION vehicles) flagged on Tickets, so that SEs aren't dispatched to unreachable vehicles.
28. As a Zonal Manager, I want to review SE-filed Vehicle Unavailability Reports — reason code, Transporter contacted, and expected-availability window — and edit/confirm the expected-availability date or manually resume SLA, so that vehicle-access pauses are governed and Tickets resurface for scheduling at the right time.
28a. As a Zonal Manager, Central Service Manager, or Operations Head, I want to see the Secondary SLA Clock (true elapsed time that never pauses) alongside the paused primary SLA on any Ticket, so that a component or vehicle-unavailability pause can never hide real aging from oversight. This clock is never shown to the SE.
29. As a Zonal Manager, I want to review Expense Vouchers submitted by SEs in my zone, verifying activity records, expense type legitimacy, per-category limits, and photo proof, so that SE reimbursement claims are validated before Finance export.

### Zonal Manager — SE Management

30. As a Zonal Manager, I want to see real-time SE Activity Status (AVAILABLE · ON_SITE · BUSY · SHIFT_ENDING · OFFLINE) derived from SE Availability + soft states + last_activity_at, so that I know who is reachable for intra-day insertions.
31. As a Zonal Manager, I want to set SE availability for SEs in my zone (ON_LEAVE · OFF_SHIFT · WEEKLY_OFF · SOFT_UNAVAILABLE), so that unavailable SEs are excluded from Recommender candidate scoring.
32. As a Zonal Manager, I want to approve SE-submitted leave requests, so that planned absences are recorded and the Recommender adjusts Day Plans accordingly.
33. As a Zonal Manager, I want to use the SE Planner (multi-day plant-visit grid) to assign which SE visits which plant on which day(s), so that plant-intent signals flow into the next batch run as a bias and support flexible Schedule Cadence planning.
34. As a Zonal Manager, I want Planner entries to automatically appear in the corresponding Batch Schedule, overridable at approval time, so that my plant-intent and the Recommender's batch output are coherent.
35. As a Zonal Manager, I want to see Van Stock levels per SE and know which SEs have incomplete Common Kit, so that I can direct restocking before SEs are grounded by the Hard Filter.
36. As a Zonal Manager, I want to see a Component-Blocked Queue listing Tickets dropped from Day Plans due to missing Common Kit or out-of-stock Expected Components, with Warehouse Manager action status per row, so that blocked work is visible and actionable.
36a. As a Zonal Manager, I want to see all Component Requests raised by SEs for Tickets/devices in my zone — requested component, Ticket/device, the SE who raised it, request status, Warehouse action/status, and age (read-only) — so that I have visibility into parts in flight, without being able to approve stock movement myself unless explicitly authorized.

### Zonal Manager — Recovery Tickets

37a. As a Zonal Manager, I want to see Recovery Tickets where the SE has marked "unable to collect" in my Action Required panel, so that I can decide whether to reschedule a new collection attempt, close as FAILED_RECOVERY, or escalate to Operations Head.
37b. As a Zonal Manager, I want to manually close a Recovery Ticket in exception cases (with mandatory reason and full audit trail including `closure_type`), so that stuck or disputed Recovery Tickets do not block inventory tracking indefinitely.
37c. As a Zonal Manager, I want to see Recovery Tickets with no state progression for 14+ days flagged in my Action Required panel, so that stalled recoveries are visible before the asset trail goes cold.

### Zonal Manager — Verification Review

37. As a Zonal Manager, I want to see all GPS auto-verification outcomes for Tickets in my zone — CLOSED, FAILED_VERIFICATION, PARTIAL_RECOVERY, and fraud-flagged — in a single review page, so that I can quickly triage which failures need escalation.
38. As a Zonal Manager, I want to see PARTIAL_RECOVERY Tickets (1–2 pings received) marked with their ping count and the time remaining before the 24h escalation window, so that I can monitor recovering devices.
39. As a Zonal Manager, I want to see fraud-flagged verification outcomes (Phase-1 ping location far from SE submission location) highlighted with the distance delta, so that I can investigate and escalate potential fraud.
40. As a Zonal Manager, I want to see FAILED_VERIFICATION reasons split by "no pings" vs "fraud flag", so that I understand whether devices failed to respond or were submitted fraudulently.
41. As a Zonal Manager, I want to set recovery Tickets as `CLOSED_AUTO_RECOVERY` when the device resumes pinging without SE intervention, so that auto-recoveries are not credited as SE repairs.

### Central Service Manager

42. As a Central Service Manager, I want to see cross-zone Ticket queues including Tickets auto-escalated from Platinum companies that couldn't be covered locally, so that I can authorise cross-zone SE deployment in one action.
43. As a Central Service Manager, I want to see all zones' Batch Schedule approval status and pending escalations, so that I can act with full Zonal Manager authority when a Zonal Manager is unavailable.
44. As a Central Service Manager, I want to approve or deny cross-zone escalation requests from Zonal Managers and auto-triggered Platinum escalations, so that cross-zone capacity is allocated deliberately.
45. As a Central Service Manager, I want my actions taken in a Zonal Manager's scope to be labelled `acted_as_role = CENTRAL_SERVICE_MANAGER` in the audit trail, so that reports distinguish my actions from the Zonal Manager's.
46. As a Central Service Manager, I want to see a per-zone breakdown of "% of approvals performed by Central Service Manager this month", so that Operations Head can identify zones where Zonal Manager backup is becoming routine.

### Operations Head

47. As an Operations Head, I want to see fleet-wide Fleet Uptime % (time-weighted, eligibility-gated) per zone / company / plant, so that I can track contractual SLA performance at a strategic level.
48. As an Operations Head, I want to see Soft Inactive Count trend (twice-daily, per zone), so that I can monitor the intraday operational signal that drives Recommender mode switching.
49. As an Operations Head, I want to create Install Tickets individually or via CSV bulk upload (vehicle_no, plant_id, company_id, device_type, device_id; optional: sim_id, target_date, notes) across all zones, so that new-device installation requests enter the SE workflow. Zonal Managers create within their own zone and Central Service Managers within their authority scope via the same UI/CSV; every Install Ticket records `created_by` + `created_by_role` and a full audit entry.
50. As an Operations Head (or Zonal Manager / Central Service Manager within scope), I want CSV upload to validate Vehicle existence, absence of an active Device mapping, Plant existence, company-account context, and that each row's Plant is within the creator's zone authority, before creating Tickets — with line-number errors for bad rows, so that partial-import failures don't silently corrupt the backlog.
51. As an Operations Head, I want to configure zones, plants, SE mappings, and SE coverage types (DEDICATED, MULTI_PLANT, FLOATING), so that the Recommender has accurate geographic routing data.
52. As an Operations Head, I want to configure Floating SE territory via a hierarchical selector (State / Region / District) and optionally draw a polygon overlay on a map, so that SE coverage is precisely described for pan-India routing.
53. As an Operations Head, I want to configure SLA rules (submit_within_minutes, verify_within_minutes, escalate_after_minutes) per device bucket or company tier, so that SLA enforcement matches contractual commitments.
54. As an Operations Head, I want to configure Company Tier (PLATINUM / GOLD / SILVER) and Company Priority Rank (A / B / C) per company, overriding CRM/SAP data when integration data is missing, so that the Recommender scores candidates correctly.
55. As an Operations Head, I want to configure the Common Kit definition (cables, SIM, antenna, fuse) and Recommender scoring weights (company_priority_rank, vehicle dispatch urgency, repeat-failure penalty, distance), so that Hard Filter and scoring behaviour is tunable without code changes.
56. As an Operations Head, I want to manage user accounts for all roles (Zonal Manager, Central Service Manager, Warehouse Manager), so that there is no separate Admin persona and all system configuration is owned in one role.
57. As an Operations Head, I want to override-confirm a Non-Operational marking when the other party doesn't respond within 7 days, with a mandatory audit reason, so that stuck markings don't block Device eligibility indefinitely.
57a. As an Operations Head, I want to manually close or override a Recovery Ticket in any zone with a mandatory reason (`closure_type = OPERATIONS_HEAD_OVERRIDE_CLOSE`, full audit), so that escalated or disputed recoveries can be resolved when Zonal Manager authority is insufficient.
58. As an Operations Head, I want to see "auto-escalations triggered this month" per zone, so that I can identify zones with capacity gaps that need structural remediation.
59. As an Operations Head, I want to set `PAID` status on Expense Voucher batches after Finance confirms the monthly export was processed, so that SE reimbursement status is reflected in FSM.
60. As an Operations Head, I want to export a monthly Finance Excel file of all APPROVED Expense Vouchers, so that Finance can process the batch reimbursement outside FSM.
61. As an Operations Head, I want to tag `device.deal_type` (RECURRING / ONE_TIME) manually when CRM/SAP integration data is missing, so that Non-Operational marking correctly triggers or suppresses Recovery Ticket creation.

### Operations Head — Performance & Analytics

61a. As an Operations Head / Operations Manager, I want a **Zonal Manager Performance Scorecard** that measures the quality and impact of each ZM's decisions (overrides, override rate, override-after-ON_SITE, reassignments, split batches, deferrals, manual assignments, time-to-intervention, SLA impact of overrides, tickets improved vs delayed, SE overload caused/reduced, long-pending reduction, escalations handled, zone SLA compliance, SE utilization balance, manual-intervention vs auto-assignment success) computed from assignment history, audit logs, ticket events, SLA outcomes, and override records, so that I can evaluate ZM effectiveness objectively. This scorecard is **not** shown to the ZM as a planning view and ZMs never enter their own scores; it is read from summary tables (not raw multi-year scans), with ZM-wise comparison, zone-wise drill-down, and weekly/monthly trend.
61b. As an Operations Head, I want a **Root Cause Analytics** view showing the percentage distribution of device-inactivity root causes (POWER_ISSUE, SIM_NETWORK_ISSUE, GPS_ANTENNA_ISSUE, WIRING_ISSUE, DEVICE_HARDWARE_FAULT, CONFIGURATION_ISSUE, VEHICLE_ACCESS_ISSUE, INSTALLATION_ISSUE, CUSTOMER_SIDE_ISSUE, UNKNOWN), filterable by Fleet / Zone / Company / Plant / device type / SE / time period, so that I can target the most common failure drivers. This is built from the structured root-cause data captured on the Troubleshooting Form, not free-text diagnosis notes.
61c. As an Operations Head, I want a **System Efficiency Report** measuring end-to-end operational performance (devices detected, Failure Cycles, tickets auto-created, auto-assignment success rate, manual assignment rate, ZM override rate, detection-to-ticket / ticket-to-assignment / assignment-to-ON_SITE / ON_SITE-to-submission / submission-to-verification times, total and average downtime, SLA compliance %, pause and aging counts, repeat-failure rate, first-time-fix rate, failed-verification rate, auto-recovery rate, warehouse fulfilment time, recovery closure time), filterable by Fleet / Zone / Company / Plant / device type / SE / time period and served from summary tables for long ranges, so that I can prove whether the FSM system reduces downtime and improves operations.

### Zonal Manager / Operations Head — Device Detail & Downtime History

61d. As a Zonal Manager or Operations Head, I want a **Device Detail** page showing a device's full lifetime downtime history — each Failure Cycle with downtime start/end, total duration, SLA bucket reached, assigned SE, Plant, Company, root cause, component used, vehicle-unavailable impact, component-blocked impact, verification outcome, closure type, auto-recovery flag, and repeat-failure flag — so that I can understand a device's failure pattern. Recent detail comes from hot operational records; the lifetime trend comes from monthly summary tables.
61e. As a Zonal Manager or Operations Head, I want **Device Lifetime Downtime Trend** views (downtime cycles over lifetime, downtime hours by month, repeat-failure trend, average time to recover, longest downtime episode, auto-recovery vs SE-repaired split, component-related downtime trend, root-cause trend) on Device Detail, so that I can spot chronically unreliable devices, served from summary tables (never multi-year raw scans).

### Warehouse Manager

62. As a Warehouse Manager, I want to confirm receipt of a recovered device by marking RECEIVED_AT_WAREHOUSE on a Recovery Ticket after physically checking the device serial against the Ticket record, so that the Ticket auto-closes with a full audit trail and the recovered asset is correctly logged back into inventory.
64. As a Warehouse Manager, I want to see Component Requests routed to me for approval, with the Ticket context, SE identity, and requested component detail, so that I can approve or reject parts requests promptly.
65. As a Warehouse Manager, I want to mark Component Requests as APPROVED, REJECTED, or SHIPPED, and record tracking details on SHIPPED, so that SEs know when to expect their parts.
66. As a Warehouse Manager, I want to see the Shadow Use Queue listing unreconciled SHADOW_USE inventory rows (components physically consumed by a rejected-409 SE), so that I can mark each RECONCILED or DISPUTED without losing the inventory audit trail.
67. As a Warehouse Manager, I want to escalate DISPUTED Shadow Use rows to the Zonal Manager with a reason, so that genuine inventory fraud or coordination failures are investigated at the right level.
68. As a Warehouse Manager, I want to see GPS serial numbers and SIM serial numbers for Install Tickets, so that I can verify component usage against Ticket records.
69. As a Warehouse Manager, I want to handle inventory rollback when a Ticket fails GPS verification (the device was not actually installed/repaired), so that van stock is corrected to reflect physical reality.
70. As a Warehouse Manager, I want to reconcile the Shadow Use Queue when two SEs physically worked the same Ticket, so that Van Stock is accurate for both engineers going forward.
71. As a Warehouse Manager, I want to see Zone Warehouse stock levels for each component, so that I can identify what needs replenishment from the Mother Warehouse before SEs are Hard-Filtered out of Day Plans.

### All Roles — Notifications & Audit

72. As any role, I want in-app notifications for events relevant to my role (new Ticket assignments, SLA warnings, verification failures, component approvals, Batch Schedule status changes, Recovery Ticket decisions), so that I don't need to actively poll the dashboard for updates.
73. As any role, I want to see the full audit trail for any Ticket (Recommendation → BatchApproved → SEAccepted → OnSite → Closed, or the intra-day retry chain; `closure_type` and reason on every Recovery Ticket close), so that post-incident review has a complete record.
74. As any role, I want dashboards to clearly display the data-as-of timestamp from the last successful Snapshot, and surface FAILED or stuck Snapshots as an operational alert, so that stale data is never mistaken for a real fleet health improvement.

### Service Engineer — Day Plan & Assignments

73. As a Service Engineer, I want to see my Recommender-generated Plant-wise Batch Assignments as an ordered Day Plan on the mobile home screen as soon as the system dispatches the batch (no ZM approval needed), so that I can start acting on Tickets immediately — with no pre-approval waiting screen or lock.
74. As a Service Engineer, I want to be notified when the system dispatches a new batch or my ZM makes a manual same-day update to my plan, so that I know when new or changed work is available without needing to poll the app.
75. As a Service Engineer, I want to see my Day Plan as an ordered, plant-clustered route — with stop sequence, plant name, device count per stop, and any Zone Warehouse pickup step — so that I can optimise travel without having to re-plan manually.
76. As a Service Engineer, I want to see a Shared Pool of open Tickets for my covered Plants as always-visible secondary work alongside my Assigned Work — regardless of whether I have Formal Assignments — and never to see Tickets outside my covered Plants unless explicitly assigned by an authorized override, so that productive work for my Plants is always visible without exposing work I'm not responsible for.
77. As a Service Engineer, I want to see Tickets under "Assigned to Me" (Formal Assignments) as a clear primary list separate from the Shared Pool, so that my committed work is never mixed with unassigned work.

### Service Engineer — Intra-day Re-plan Acceptance

78. As a Service Engineer, I want to receive an in-app notification when a new CRITICAL or HIGH_CRITICAL Ticket is inserted into my plan mid-shift, asking me to Accept or Decline the assignment, so that I am the commit authority for any urgent mid-day route change.
79. As a Service Engineer, I want to Accept an intra-day insertion in one tap and immediately receive a WhatsApp Confirmation carrying the Ticket number, vehicle details, plant, expected component (if any), and a deeplink back to the app, so that I have full context even if I later lose app state.
80. As a Service Engineer, I want to Decline an intra-day insertion with a mandatory reason code (AT_CAPACITY · TRAVEL_TOO_FAR · VEHICLE_TROUBLE · OTHER), so that my decline is recorded and the Recommender can reroute to the next-best SE with accurate signal.
81. As a Service Engineer, I want to see a clear notification when a Ticket was offered to me but rerouted to another SE because I was offline or didn't respond within the Acceptance Timeout, so that I'm never confused about assignments that appear and disappear.

### Service Engineer — Troubleshoot Ticket Work

82. As a Service Engineer, I want to view Ticket detail showing device ID, vehicle number, plant, Transporter name, SLA bucket, Failure Cycle history, expected components, Technical Hints, and raw telemetry fields, so that I arrive on-site with full context and a diagnostic hypothesis.
83. As a Service Engineer, I want to update my soft state on a Ticket (VIEWED → ON_SITE → TROUBLESHOOT_STARTED) so that the Zonal Manager sees my real-time progress and the dashboard reflects accurate SE Activity Status.
84. As a Service Engineer, I want to submit the troubleshooting form with a `client_submission_id` for offline dedup, so that a poor network connection never results in duplicate form submissions when I regain connectivity.
84a. As a Service Engineer, I want the troubleshooting form to capture **structured root cause data** — `root_cause_category` (POWER_ISSUE / SIM_NETWORK_ISSUE / GPS_ANTENNA_ISSUE / DEVICE_HARDWARE_FAULT / WIRING_ISSUE / CONFIGURATION_ISSUE / VEHICLE_ACCESS_ISSUE / INSTALLATION_ISSUE / CUSTOMER_SIDE_ISSUE / UNKNOWN), `root_cause_subcategory`, `root_cause_notes`, `action_taken_category`, `action_taken_notes`, `component_used`, `component_unavailable`, and `photo_refs` — in addition to free-text notes, so that root-cause analytics are reliable and not dependent on parsing free text.
84b. As a Service Engineer, I want to see readiness colour hints on my Ticket Detail — `UPCOMING_TRIP` (vehicle has a planned trip soon), `ON_TRIP` (vehicle currently on a trip), and `UNKNOWN` / `STALE` (no fresh availability signal) — so that I know a vehicle may be hard to reach, while understanding these are warnings only and (except `ON_TRIP`) do not block my assigned work.
85. As a Service Engineer, I want to submit the troubleshooting form with `component_unavailable = true` when the required part is not in my van, so that a Component Request is automatically raised to the Warehouse Manager and SLA is paused while I wait.
86. As a Service Engineer, I want to confirm receipt of a Component Request shipment from the Warehouse, so that SLA resumes and I can submit a new troubleshooting form (with a new `client_submission_id`) on the same Ticket.
87. As a Service Engineer, I want my ON_SITE status to auto-update when my app captures a location inside the Plant/vehicle geofence (with a manual ON_SITE tap as a fallback when location is off or capture fails), so that I don't have to complete a separate "I am at the vehicle" confirmation screen for every Ticket and my presence is still recorded for verification.
88. As a Service Engineer, I want to see a PARTIAL_RECOVERY badge on a Ticket in VERIFICATION_PENDING when 1–2 GPS pings have been received, so that I know the device is responding and can decide whether to wait on-site or move to the next stop.
89. As a Service Engineer, I want to see the GPS auto-verification outcome (CLOSED · FAILED_VERIFICATION · PARTIAL_RECOVERY) on each submitted Ticket, so that I know whether my repair was verified without having to call the Zonal Manager.
90. As a Service Engineer, I want to receive a clear 409 Conflict message when another SE has already submitted on the same Ticket, including confirmation that my consumed components have been logged as Shadow Use for Warehouse reconciliation, so that I know the work is not lost and my van stock will be corrected.
90a. As a Service Engineer, when I reach the Plant and the vehicle is not available to work, I want to contact the Transporter (name + number shown on the Ticket) and file a Vehicle Unavailability Report — reason code (VEHICLE_ON_TRIP / VEHICLE_NOT_AT_PLANT / DRIVER_NOT_AVAILABLE / CUSTOMER_REFUSED / OTHER), whether I contacted the Transporter, and the expected-availability window — so that SLA pauses with a documented reason and the Ticket resurfaces for scheduling when the vehicle is expected back.

### Service Engineer — Install Ticket Work

91. As a Service Engineer, I want to see Install Tickets in my Day Plan with the full lifecycle (SCHEDULED → ON_SITE → FITTED → ACTIVATED → CLOSED), so that new-device fitting work is managed in the same flow as troubleshooting.
92. As a Service Engineer, I want to record the GPS device serial number and SIM serial number at the FITTED stage, so that inventory records are accurate and GPS auto-verification can track the new device_id.
93. As a Service Engineer, I want to be notified if an Install Ticket moves to FAILED_ACTIVATION (first GPS ping not received within the expected window post-fitment), so that I can return to site or escalate before the Zonal Manager has to follow up.

### Service Engineer — Recovery Ticket Work

94. As a Service Engineer, I want to see Recovery Tickets in my Day Plan with the lifecycle (SCHEDULED → ON_SITE → COLLECTED → RECEIVED_AT_WAREHOUSE → CLOSED), so that physical device retrieval after a Non-Operational marking is managed as a first-class Ticket type.
95. As a Service Engineer, I want to record collection details at the COLLECTED stage — device serial confirmation and physical condition notes (both mandatory) — so that the audit trail proves the provider-owned asset was recovered and the Zone Warehouse can verify the serial matches the Ticket record.
95a. As a Service Engineer, I want to mark a Recovery Ticket as "unable to collect" with a mandatory reason code (COMPANY_REFUSED / VEHICLE_UNREACHABLE / DEVICE_MISSING / OTHER), so that the Zonal Manager is notified and can decide whether to reschedule, close as FAILED_RECOVERY, or escalate.

### Service Engineer — Availability & Leave

96. As a Service Engineer, I want to flag myself as SOFT_UNAVAILABLE for a defined time window from the mobile app, so that the Recommender excludes me from intra-day candidate scoring for that period and my Zonal Manager is notified.
97. As a Service Engineer, I want to submit a leave request from the mobile app for Zonal Manager approval (ON_LEAVE · WEEKLY_OFF), so that planned absences are recorded in SE_AVAILABILITY and the Recommender excludes me from candidate scoring for the approved window before batches are generated.

### Service Engineer — Expense Vouchers

98. As a Service Engineer, I want to create an Expense Voucher draft offline with at least one photo proof (receipt or item photo), using a `client_submission_id` for dedup, so that poor connectivity on-site never blocks me from filing my reimbursement claim.
99. As a Service Engineer, I want to optionally link an Expense Voucher to a Ticket and/or Vehicle for context, so that the Zonal Manager can verify the activity record against the claimed plant and date.
100. As a Service Engineer, I want to see the status of my submitted Expense Vouchers (SUBMITTED · ZONAL_MANAGER_REVIEW · APPROVED · REJECTED · NEEDS_CLARIFICATION · PAID), so that I know where my reimbursement claim stands without contacting my manager.

### Service Engineer — Van Stock & Components

101. As a Service Engineer, I want to see my current Van Stock levels per component in the mobile app, so that I know whether my Common Kit is complete before the batch Hard Filter grounds me from new assignments.
102. As a Service Engineer, I want to be notified when a Common Kit item is running low or missing from my van, so that I can arrange a Zone Warehouse restocking stop before it blocks my Day Plan.

### Service Engineer — QR Scanner

103. As a Service Engineer, I want to scan a vehicle QR code, device QR code, or device serial barcode from the Home screen to open the matching active Ticket directly, so that I can find and open the right Ticket at the vehicle without searching by hand.
104. As a Service Engineer, I want the scanner to tell me "No active ticket found" when the scanned vehicle or device has no open eligible Ticket, so that I don't spend time looking for a Ticket that doesn't exist.
105. As a Service Engineer, I want the scanner to open a cached Ticket Detail in read-only mode when I'm offline and the Ticket was already synced, so that QR-based access still works in low-connectivity field conditions.

### Service Engineer — Technical Hints

106. As a Service Engineer, I want to see a short Technical Hint on each Ticket card (e.g., "No main power — check fuse", "Weak GSM signal", "GPS signal invalid") derived from the device's last snapshot telemetry, so that I can form a diagnosis hypothesis before arriving at the vehicle.
107. As a Service Engineer, I want to see all Technical Hints and the full set of raw telemetry fields (power status, voltage, GPS validity, signal strength, network registration, ignition, speed, coordinates, IP/port) in Ticket Detail — always visible without collapsing — so that I have the complete device health picture when I am on-site and troubleshooting.
108. As a Service Engineer, I want the Technical Hints section to show "Telemetry unavailable" when snapshot data is missing for the device, rather than showing nothing, so that I know the absence of hints is a data gap rather than a healthy device.

---

## Implementation Decisions

### Architecture — Admin Web Dashboard

- **Stack:** React + TypeScript + Vite. Tailwind CSS. shadcn/ui component primitives. No SSR in v1.
- **Data layer (current):** ~~Static mock data in the admin data directory drives all pages.~~ **[Corrected 2026-07-10 by the SYSTEM-STATE audit: this is complete — every admin page now consumes real API clients (`apps/admin/src/api/*`); no mock-data remnants remain. See `docs/SYSTEM-STATE-2026-07.md` §3k.]**
- **Backend contract:** REST (or tRPC) API. The dashboard is a consumer — it displays state and triggers transitions without mutating server state without a round-trip.
- **Routing:** React Router required to support deep-linking to Ticket Detail Drawers and Batch Schedule screens.
- **Shell:** `AdminShell` provides the sidebar and top-bar frame. `ZoneDashboardHome` dispatches to page components via an `AdminPage` union type. New pages added as `AdminPage` values.
- **Role / Zone context:** derived from auth session. CSM acting in ZM scope: persistent banner in top-bar; all API calls carry `acted_as_role = CENTRAL_SERVICE_MANAGER`.
- **Key UI invariants:**
  - SE Activity Status is always computed at render time from SE_AVAILABILITY.status + active Ticket soft states + `last_activity_at` — never fetched from a stored field.
  - Snapshot freshness banner runs across every page; FAILED or stuck Snapshot renders a red alert.
  - SLA bucket colour coding: LONG_PENDING (deep red) › VERY_SEVERE › SEVERE › HIGH_CRITICAL › CRITICAL › RISK › EARLY_RISK › WARNING (green). ACTIVE (0–4h) never appears in Ticket queues.
  - SLA pause indicator shown for two documented pause reasons — `WAITING_COMPONENT` and `VEHICLE_UNAVAILABLE` (the latter requires a filed Vehicle Unavailability Report, never raw readiness). Raw readiness (`ON_TRIP` / `STALE` / `UNKNOWN`) alone must not show a pause indicator. The Secondary SLA Clock (true elapsed, never pauses) renders only for Zonal Manager / Central Service Manager / Operations Head — never for the SE.
  - Fleet Uptime denominator shown in reports is always Eligible Devices only (active PGI within ~15 days AND not Non-Operational), never raw installed-device count.
  - WhatsApp Confirmation displayed as "sent" (not "attempted") — it is a first-class delivery channel for SE Acceptance events.

### Architecture — SE Mobile App

- **Stack:** React Native + Expo (SDK 54) + Expo Router. Android-first; iOS-compatible.
- **Offline-first:** Troubleshooting Form submission, Expense Voucher drafts, and soft-state updates must queue locally (WatermelonDB / SQLite) and auto-sync on connectivity restore. See CONTEXT.md → Offline Queue for full storage, retention, photo, and queue-limit rules.
- **Offline Queue storage constraints (low-end Android):** store only pending metadata and compact JSON payloads — no full Ticket history, no large raw telemetry blobs, no zone-wide Ticket list. Cache only assigned/current Tickets. Queue table indexed by `status`, `queued_at`, `ticket_id`, `submission_type`. Sync in small batches. Photos compressed and stored as local file references, not SQLite blobs; local copies removed after successful upload. `DELIVERED` items compacted after sync; `FAILED` items kept until SE resolves; completed Tickets cleared after configurable retention (default 7–15 days). Max 500 pending items (configurable); warn SE when approaching limit; never auto-delete pending unsynced submissions without explicit SE acknowledgement.
- **Push notifications:** FCM (Android) / APNs (iOS). Required for Batch Schedule approval, intra-day insertion (quick-action Accept/Decline in notification shade), ZM manual same-day update, verification outcomes, Component Request status changes, leave request decisions.
- **GPS capture:** auto-captured silently at form submission; also used to auto-update ON_SITE when a deliberate app action places the SE inside the Plant/vehicle geofence (`onsite_source = AUTO_GEOFENCE`), with a manual ON_SITE tap (`onsite_source = MANUAL`, audited) as fallback when location is off or capture fails. No separate SE Confirmation step; no continuous background tracking.
- **SE Activity Ping:** any SE-initiated app action (opening a Ticket, tapping VIEWED / ON_SITE / TROUBLESHOOT_STARTED, submitting a form, confirming receipt, scanning QR, refreshing, syncing offline queue) updates `ENGINEER_MASTER.last_activity_at` — no fixed background timer (ADR-0024). Background processes must not trigger an activity ping. Activity pings are for dashboard visibility and audit only — they must not auto-clear Soft States. An absent ping does not mean the SE has left the vehicle; the SE may be working offline.
- **Dedup:** all submissions carry `client_submission_id` (UUID generated at draft creation time, not at submit time) for server-side idempotency.
- **Secure storage:** react-native-keychain for auth tokens.

### Web Dashboard — Page Inventory

| Page Key | Proposed Route | Description |
|---|---|---|
| `zone-dashboard` | `/` | Zone Dashboard Home — Action Required panel, Zone/Company overview tables, Grouped Critical Work Queue |
| `batch-schedule` | `/schedules` | SE list with Plant-wise Batch Assignment status per SE (AUTO_ASSIGNED / OVERRIDDEN) at current Schedule Cadence — batches are already live for the SE; this view is for monitoring/override |
| `batch-schedule-detail` | `/schedules/:engineerId` | Single SE Batch Schedule — ordered stop list, Recommender reasoning, override/split/reassign/defer controls (no approve gate) |
| `intraday-queue` | `/intraday` | Intra-day queue — system-triggered CRITICAL/HIGH_CRITICAL insertions (SE Acceptance flow) and ZM manual same-day updates |
| `tickets` | `/tickets` | Ticket List — filterable by work_type, status, company, plant, SLA bucket, assignment state |
| `ticket-detail` | `/tickets/:ticketId` | Ticket Detail Drawer (opens inline over list) — lifecycle, forms, verification, components, history |
| `se-management` | `/engineers` | SE list — derived Activity Status, Van Stock completeness, availability controls |
| `se-planner` | `/engineers/planner` | Multi-day plant-visit grid (SE × day cell = plant intent; flows into next batch run as bias signal) |
| `verification-review` | `/verification` | GPS auto-verification outcomes — CLOSED, PARTIAL_RECOVERY, FAILED_VERIFICATION, fraud-flagged |
| `non-op-marking` | `/non-op` | Non-Operational marking requests — dual-confirmation queue, override-confirm for Operations Head |
| `expense-vouchers` | `/vouchers` | Expense Voucher review (Zonal Manager) and Finance export + PAID marking (Operations Head) |
| `component-blocked` | `/component-blocked` | Tickets dropped from Day Plans for missing Common Kit or OOS expected components |
| `component-requests` | `/warehouse/requests` | Warehouse: Component Request approval, shipping details, SHIPPED/RECEIVED tracking. Zonal Manager has a read-only view of own-zone requests (component, ticket/device, SE, status, WM action, age) |
| `shadow-use` | `/warehouse/shadow-use` | Warehouse: Shadow Use reconciliation — RECONCILED or DISPUTED per row |
| `warehouse-stock` | `/warehouse/stock` | Warehouse: Zone Warehouse stock levels per component |
| `cross-zone` | `/cross-zone` | Cross-Zone Escalation — auto-escalations (Platinum) + manual flags (Gold/Silver) |
| `install-create` | `/install/new` | Single Install Ticket creation (Zonal Manager own-zone / Central Service Manager scope / Operations Head all zones; records created_by + created_by_role) |
| `install-csv` | `/install/upload` | CSV bulk Install Ticket upload with row-level validation |
| `reports` | `/reports` | Fleet Uptime %, Soft Inactive Count trend, SE productivity, auto-recovery rates |
| `device-detail` | `/devices/:deviceId` | Device Detail — lifetime downtime history (per Failure Cycle) + downtime trend views; recent detail from hot records, lifetime trend from monthly summaries |
| `root-cause-analytics` | `/reports/root-cause` | Root Cause % distribution (from structured Troubleshooting Form data); filter by Fleet/Zone/Company/Plant/device type/SE/time period |
| `system-efficiency` | `/reports/efficiency` | System Efficiency Report — end-to-end operational metrics; served from summary tables; same filter set |
| `zm-scorecard` | `/reports/zm-scorecard` | Zonal Manager Performance Scorecard (Operations Head / Operations Manager only) — ZM-wise comparison, zone drill-down, weekly/monthly trend; read from `zm_performance_summary_monthly` |
| `settings` | `/settings` | Zones, plants, SE mappings, SLA rules, Company Tier/Priority, Common Kit, user accounts |

### Web Dashboard — Page Flows

#### Flow 1: Zone Dashboard Home

**Entry:** default on login.

1. **Snapshot freshness banner** runs across the top of every page: last successful Snapshot timestamp. If the Snapshot is `FAILED` or has been `RUNNING` past the expected window → red alert banner.
2. **Action Required panel** (cards, ordered by urgency):
   - Recently auto-dispatched batches not yet reviewed (informational — SEs are already actioning them; no approval required).
   - Vehicle Unavailability Reports filed by SEs (expected-availability windows to confirm/edit) and readiness conflicts to resolve.
   - CRITICAL Ticket insertions awaiting SE Acceptance.
   - Failed Verification items.
   - Component-Blocked Tickets with no Warehouse action.
   - WAITING_COMPONENT Tickets exceeding 7 days.
   - `AWAITING_MANAGER_CONFIRMATION` Non-Op Marking requests.
   - Manual assignment required (3-retry exhaustion).
3. **Zone Overview table** — zone rows, columns: total inactive, count per SLA bucket, trend % vs yesterday. Filter: zone, SLA bucket. Export to Excel.
4. **Company / Plant Overview table** — company rows with drill-down to plant → device list. Filter: zone, company, plant, SLA bucket. Export to Excel.
5. **Grouped Critical Work Queue** — CRITICAL+ Tickets grouped by company/plant, suggested SE options, plant-cluster multiplier signals. One-click assign to SE.

#### Flow 2: Plant-wise Batch Schedule Monitoring & Override

**Entry:** Action Required panel → recently auto-dispatched batches, or Sidebar → Schedules.

1. SE list page — each row: SE name, batch ticket count, date range covered, status badge (`AUTO_ASSIGNED` / `OVERRIDDEN`). Batches are **already live in the SE's Day Plan** — this page is for monitoring and override, not approval.
   - No countdown clock and no Approve action. A configurable **Schedule Cadence reminder** notification (e.g., 08:00 IST) may prompt the ZM to review dispatched batches, but this is advisory only — not a workflow gate and it locks nothing.
2. Manager opens one SE → **Batch Schedule Detail**:
   - Ordered stop list: Plant name, device count per Plant-wise Batch, Zone Warehouse pickup step (if any).
   - Each Ticket row: device ID, company, SLA bucket badge, "Why suggested?" chip (expands to Company Tier, Device Bucket, Priority Rank, Plant Cluster Multiplier).
   - Override controls: **Swap SE** (dropdown of AVAILABLE SEs), **Split Batch** (assign a subset to a different SE), **Remove Ticket** (×), **Reorder** (drag), **Defer Ticket** (date picker), **Reassign**.
3. Any override commits immediately and flips the batch status to `OVERRIDDEN`; the SE's Day Plan updates and a push notification fires. There is no Approve step — system-generated batches were already actionable on dispatch.
4. **Override of in-progress work** (any time, including mid-shift):
   - If SE holds an ON_SITE soft state on a Ticket in the batch → warning banner: *"[SE Name] is currently on-site at [Plant]. Overriding may disrupt their active visit."*
   - Manager must explicitly confirm; modal records override reason code (mandatory).

#### Flow 3: Intra-day Queue

**Entry:** Real-time notification badge in app header → or Sidebar → Intra-day.

The Intra-day Queue handles two distinct sub-types of mid-shift plan changes:

**3a. System-triggered CRITICAL/HIGH_CRITICAL Insertion**

1. New Ticket enters CRITICAL or HIGH_CRITICAL bucket → Qualifying Event fires → in-app notification badge increments.
2. Queue row (type = `SYSTEM_CRITICAL`): Ticket ID, company, SLA bucket, SE offered, offered_at, status badge (`PENDING_ACCEPTANCE` / `ACCEPTED` / `TIMED_OUT` / `DECLINED`).
3. SE accepts on mobile → row → `ACCEPTED`; "WhatsApp Sent" timestamp chip appears.
4. **Acceptance Timeout (10 min)** — row → `TIMED_OUT`; "Routing to next SE (Retry N of 3)"; system reroutes per strict-precedence (CONTEXT.md Decision §1).
5. **SE Declines** — row shows decline reason code; system reroutes.
6. **After 3 retries** → row → `ESCALATION_REQUIRED`; Action Required panel gains "Manual assignment needed" alert. Manager assigns via manual assignment modal: AVAILABLE SEs only (`last_activity_at` within 15 min).
7. Full retry chain in **Ticket Detail Drawer → Assignment History tab**.

**3b. Zonal Manager Manual Same-day Update**

1. ZM navigates to SE's current Day Plan (from SE Management or Batch Schedule Detail).
2. ZM adds, removes, or reorders Tickets on the SE's current Day Plan.
   - If SE holds an ON_SITE soft state on a Ticket being removed → warning banner. Mandatory confirm + reason code.
3. Change applies immediately to the SE's Day Plan. No SE Acceptance required.
4. Push notification fires on SE's device: *"Your plan has been updated by [ZM Name]."*
5. Queue logs the change as a row (type = `MANUAL_ZM_UPDATE`): ZM name, action (add / remove / reorder), affected Ticket ID, timestamp.

#### Flow 4: Ticket List & Detail

**Entry:** Sidebar → Tickets.

1. **Ticket List** — filterable: `work_type`, `status`, `company`, `plant`, `SLA bucket`, `assignment state`. Default sort: SLA bucket descending. Colour-coded SLA bucket badges per severity table (LONG_PENDING = deep red → WARNING = green).
2. Inline badges: `WAITING_COMPONENT` (amber + days elapsed) · `PARTIAL_RECOVERY` (teal + "N/3 pings") · `REPEAT FAILURE` (flame icon + link to prior cycle) · `ESCALATED` (red icon) · `FRAUD FLAG` (orange + distance delta) · `CLOSED_AUTO_RECOVERY` (grey "auto" label).
3. Click row → **Ticket Detail Drawer** slides in from right; list stays visible.
4. **Drawer tabs:**

   | Tab | Contents |
   |---|---|
   | Overview | work_type, device ID, vehicle, plant, Transporter, SLA bucket, Failure Cycle state |
   | Lifecycle | All state transitions with actor, role, timestamp |
   | Forms | All Troubleshooting Form Submissions — component_used, component_unavailable, SE GPS |
   | Verification | GPS auto-verification phases; fraud flag + distance delta |
   | Components | Component Request status; Shadow Use rows |
   | Assignment History | Full Recommendation → AutoAssigned → (Overridden?) → OnSite chain; intra-day SE-Accepted retry chain |

5. **Role-gated actions:** Approve/Deny Non-Op Marking · Flag Cross-Zone Escalation · Resolve Readiness Conflict · Confirm/Edit Vehicle Unavailability window · Resume SLA · Mark CLOSED_AUTO_RECOVERY · Manual close Recovery Ticket (ZM / OH / CSM-acting — mandatory reason, `closure_type` recorded).

#### Flow 5: Component-Blocked Queue & Component Requests

**Component-Blocked Queue (Zonal Manager — read-only):**
Each row: Ticket ID, SE, missing part(s), Warehouse Manager action status. Rows aged >7 days with no WM action gain "Warehouse Overdue" badge and surface in Action Required.

**Component Request Approval (Warehouse Manager):**
1. Request list sorted by `created_at` desc. Click row → Ticket context, SE, component, delivery destination.
2. **Approve** → shipping details form → **Mark Shipped**.
3. **Reject** → mandatory reason; ZM notified.
4. SE confirms receipt on mobile → `RECEIVED`; SLA resumes; SE resubmits form with new `client_submission_id`.
5. 7-day auto-escalation: Ticket surfaces in ZM Action Required.

**Shadow Use Queue (Warehouse Manager):**
Per-row actions: **Mark Reconciled** or **Mark Disputed** (escalates to ZM; Ticket gains "Inventory Dispute" flag).

#### Flow 6: GPS Verification Review

1. Filter: outcome, zone, company, date range. Default: all non-CLOSED for zone, sorted by `submitted_at` desc.
2. Row types: PARTIAL_RECOVERY (ping count + 24h countdown) · FAILED_VERIFICATION no-pings · FAILED_VERIFICATION fraud-flag (distance delta chip in orange) · CLOSED (green, no action).
3. Click → Ticket Detail Drawer, pre-navigated to Verification tab.
4. Fraud-flagged: **Escalate** action with mandatory reason. Auto-recovery: **Mark CLOSED_AUTO_RECOVERY** button.

#### Flow 7: Non-Operational Marking

1. Queue sorted by `awaiting_since` asc. Row states: `AWAITING_MANAGER_CONFIRMATION` · `AWAITING_CUSTOMER_CONFIRMATION` (days-elapsed badge) · `CONFIRMED`.
2. **Confirm** modal: reason code, effective window, deal type, active Tickets that will auto-close. RECURRING device: warning *"A Recovery Ticket will be auto-created."* Requires explicit checkbox confirmation.
3. **7-day override-confirm** (Operations Head only) — mandatory free-text audit reason.
4. On `CONFIRMED` for RECURRING device: toast confirms *"Recovery Ticket #XXXXX created and added to the Recommender queue."*

#### Flow 8: Expense Voucher Review

**Zonal Manager:**
1. List: status = `ZONAL_MANAGER_REVIEW`, sorted by `submitted_at`. Click row → activity check (system finds/warns on linked Ticket), expense items with over-limit rows in red, photo thumbnails with full-screen lightbox.
2. Actions: **Approve** / **Reject** (mandatory reason) / **Needs Clarification** (comment field; SE notified).

**Operations Head:**
1. **Export Finance Excel** — monthly batch of all `APPROVED` vouchers.
2. After Finance batch: multi-select → **Mark PAID**; SE notified.

#### Flow 9: Cross-Zone Escalation

**Zonal Manager:** Flag any Ticket → reason → submitted to CSM queue. Ticket row gains "Cross-Zone Flagged" badge. CSM decision feeds back as notification + reason.

**CSM / Operations Head:** Dashboard split: **Auto-Escalations (Platinum)** system-triggered vs **Manual Escalations (Gold/Silver)** ZM-flagged. Per-row actions: **Approve Cross-Zone** (select target zone + SE) / **Deny** (mandatory reason) / **Defer** (review date). Denied auto-escalations return to home ZM queue; ZM can re-escalate to Operations Head.

#### Flow 10: SE Management

1. SE list: name, coverage type, derived Activity Status badge (AVAILABLE / ON_SITE / BUSY / SHIFT_ENDING / OFFLINE — **computed at render time**, never stored), today's Ticket count, Common Kit completeness chip.
2. Click SE → detail panel: Current Day Plan status · Van Stock per-component (missing items in red) · Availability rows.
3. Manager actions: **Set Availability** (ON_LEAVE / OFF_SHIFT / WEEKLY_OFF / SOFT_UNAVAILABLE + time window) · **Approve Leave Request**.
4. **SE Planner**: multi-day grid, rows = SEs, columns = days. Drag-to-assign from plant picker. Planner entries flow into next batch run as a bias signal; overridable at Batch Schedule approval time.

### SE Mobile App — Screen Inventory

| Screen | Description |
|---|---|
| Home / Day Plan | Primary entry point — ordered Day Plan list showing Plant-wise Batch Assignments; fully actionable as soon as the batch is dispatched (no approval gate, no pre-approval pending lock) |
| Ticket Detail | Device ID, vehicle, plant, Transporter name + contact number (tap to call), SLA bucket, Failure Cycle history, expected components, soft-state controls, Vehicle Unavailable action; readiness colour hints (`UPCOMING_TRIP` / `ON_TRIP` / `UNKNOWN` / `STALE` — warnings only); Technical Hints (derived) and raw telemetry fields always visible |
| Troubleshooting Form | Structured root cause (`root_cause_category` + subcategory + notes), action taken (category + notes), component usage, component_unavailable toggle, photo refs, free-text diagnosis notes, SE GPS auto-capture, offline dedup via client_submission_id |
| Vehicle Unavailability | Report screen when the vehicle is not available — Transporter name/number (tap to call), reason_code, transporter_contacted, expected-availability window (from/to), notes, GPS if available; on submit pauses SLA with `pause_reason = VEHICLE_UNAVAILABLE` |
| Install Form | FITTED stage: GPS device serial, SIM serial, optional photo; transitions to ACTIVATED |
| Recovery Collection Form | COLLECTED stage: device serial confirmation, condition notes |
| Intra-day Insertion Screen | Full-screen Accept/Decline prompt for CRITICAL/HIGH_CRITICAL mid-shift insertion |
| Verification Result | Per-Ticket outcome badge (CLOSED / PARTIAL_RECOVERY / FAILED_VERIFICATION) with ping details |
| 409 Conflict Screen | "Ticket closed by another SE — your components logged as Shadow Use" screen |
| Van Stock | Per-component quantities; Common Kit completeness; missing items highlighted |
| Expense Voucher Create | Offline-capable draft — date, plant, type, amount, category, photo proof, optional Ticket/Vehicle link |
| My Vouchers | Voucher list with status (DRAFT / SUBMITTED / ZONAL_MANAGER_REVIEW / APPROVED / REJECTED / NEEDS_CLARIFICATION / PAID) |
| Leave Request | Leave type selector (ON_LEAVE / WEEKLY_OFF), date range, submit for ZM approval |
| Availability | SOFT_UNAVAILABLE flag with from/to time window |
| Shared Pool | Always-visible secondary list of open Tickets for the SE's covered Plants, shown alongside Assigned Work regardless of Formal Assignment; never shows Tickets outside the SE's coverage |
| QR Scanner | Scan vehicle QR, device QR, or device serial barcode to open matching Ticket Detail directly — entry shortcut only, no state changes |
| Notifications | In-app notification list for all SE-relevant events |

### SE Mobile App — App Flows

#### Flow 1: Work Schedule / Day Plan View

**Entry:** App open (any time).

1. Home screen shows current **Work Schedule** as an ordered **Day Plan** — Tickets from dispatched Plant-wise Batch Assignments, ordered by stop sequence. All Ticket action buttons (VIEWED, ON_SITE) are immediately enabled.
2. If no batch dispatched yet: Home screen shows *"Your plan is being prepared — check back shortly."* Once the system dispatches the batch, a push notification fires: *"Your Day Plan is live. Tap to start."*
3. SE taps a Ticket → Ticket Detail screen.
4. ZM manual same-day update arrives → push notification; updated Ticket is highlighted (new addition at top of affected plant group; removed Ticket shows "removed" label for one session).
5. Intra-day CRITICAL insertion accepted → Ticket appears at top of Day Plan, badged `CRITICAL INSERTION`.

#### Flow 2: Troubleshoot Ticket Workflow

**Entry:** Ticket Detail screen from Day Plan (or Shared Pool fallback).

1. **Ticket Detail** shows: device ID, vehicle number, plant, Transporter name + contact number (tap to call), SLA bucket badge, Failure Cycle history, expected components list, **Technical Hints** (derived from snapshot telemetry — always visible, no collapse), and raw telemetry fields.
2. **ON_SITE** updates automatically when the app captures a location inside the Plant/vehicle geofence on a deliberate action (`onsite_source = AUTO_GEOFENCE`); if location is off or capture fails, the SE taps **Mark ON_SITE** manually (`onsite_source = MANUAL`, audited). Either way the Zonal Manager dashboard reflects "ON_SITE" for this SE.
3. SE taps **Start Troubleshooting** → soft state → TROUBLESHOOT_STARTED.
4. SE taps **Submit Form** → Troubleshooting Form screen:
   - **Structured root cause:** `root_cause_category` (required), `root_cause_subcategory`, `root_cause_notes`.
   - **Action taken:** `action_taken_category`, `action_taken_notes`.
   - Component used fields (multi-component; auto-populated with expected components if any).
   - `component_unavailable` toggle.
   - Photo refs.
   - Diagnosis notes (free text — supplementary, not the source for root-cause analytics).
   - SE GPS auto-captured silently at submission.
   - `client_submission_id` generated at draft creation and stored locally for offline dedup.
5. **Submit** (online) → success toast; Ticket enters VERIFICATION_PENDING.
6. **Submit** (offline) → saved to local queue; auto-uploads on connectivity restore.
7. Verification outcome notification arrives; Ticket Detail updates accordingly.

#### Flow 3: Component Unavailable Flow

1. SE enables `component_unavailable` toggle → component selector opens.
2. SE submits form → server creates Component Request; Failure Cycle → WAITING_COMPONENT; SLA paused.
3. **Warehouse ships** → SE receives push notification with tracking details.
4. SE receives physical part → taps **Confirm Receipt** → Component Request → RECEIVED; SLA clock resumes.
5. Troubleshooting Form reopens with a **new** `client_submission_id`; SE resubmits on the same Ticket.

#### Flow 4: Intra-day Insertion Accept / Decline

1. Push notification: *"CRITICAL Ticket at [Plant] — Accept assignment?"*
2. Notification shade shows **Accept** and **Decline** quick-action buttons.
3. **Accept** → assignment committed; toast: *"Accepted. WhatsApp Confirmation sent."*; new Ticket appears at top of Day Plan.
4. **Decline** → mandatory reason code picker (AT_CAPACITY / TRAVEL_TOO_FAR / VEHICLE_TROUBLE / OTHER); system reroutes.
5. **Offline / no response within 10 min** → on reconnect, SE sees: *"Ticket-XXXXX was offered to you at HH:MM and routed to [SE Name] at HH:MM because you were offline. No action needed."*

#### Flow 5: Vehicle Unavailability Report

1. SE reaches the Plant and finds the vehicle not available to work. Ticket Detail shows the **Transporter name and contact number**; SE taps to call the Transporter to coordinate.
2. SE taps **Vehicle Unavailable** → report form: `reason_code` (VEHICLE_ON_TRIP / VEHICLE_NOT_AT_PLANT / DRIVER_NOT_AVAILABLE / CUSTOMER_REFUSED / OTHER), `transporter_contacted` (yes/no), transporter name/number used, `expected_available_from` and `expected_available_to`, optional notes; SE GPS auto-captured if available.
3. **Submit** → primary SLA clock pauses with `pause_reason = VEHICLE_UNAVAILABLE`; the Ticket shows *"Vehicle unavailable — expected back on [date/time]."* The manager-only Secondary SLA Clock keeps running.
4. When the expected-availability date arrives, the system resurfaces the Ticket for scheduling/reassignment. SLA resumes when the vehicle is marked available, the SE reaches ON_SITE / access is confirmed, the ZM manually resumes, or trusted fresh AutoPlant DB readiness confirms availability.

**Note:** there is no separate "I am at the vehicle" confirmation screen — physical presence is established by multi-signal Presence (ON_SITE geofence auto-capture / manual ON_SITE / form-submission GPS).

#### Flow 6: Install Ticket Workflow

1. Ticket Detail shows lifecycle: SCHEDULED → ON_SITE → FITTED → ACTIVATED → CLOSED.
2. SE marks **ON_SITE** → state transitions.
3. SE marks **FITTED** → Install Form: GPS device serial (mandatory), SIM serial (mandatory), installation photo (optional).
4. Submit → Ticket → ACTIVATED; GPS auto-verification begins (waits for first valid ping post-fitment).
5. **First valid ping received** → push: *"Installation verified — Ticket #XXXXX CLOSED."*
6. **FAILED_ACTIVATION** → push: *"GPS ping not received for Ticket #XXXXX."*

#### Flow 7: Recovery Ticket Workflow

**Normal path:**
1. Ticket Detail shows lifecycle: SCHEDULED → ON_SITE → COLLECTED → RECEIVED_AT_WAREHOUSE → CLOSED.
2. SE marks **ON_SITE** → arrives at vehicle location.
3. SE marks **COLLECTED** → Collection Form opens: device serial confirmation (mandatory, validated against Ticket record), physical condition notes (mandatory).
4. SE returns device to Zone Warehouse → Warehouse Manager checks physical device and serial number, confirms receipt → `RECEIVED_AT_WAREHOUSE` → Ticket **auto-closes** (`closure_type = AUTO_CLOSED_ON_WAREHOUSE_RECEIPT`). No ZM approval required.
5. SE and ZM receive closure notification.

**Unable to collect (failed recovery path):**
1. SE taps **Unable to Collect** on the Ticket Detail screen.
2. Mandatory reason code picker: `COMPANY_REFUSED | VEHICLE_UNREACHABLE | DEVICE_MISSING | OTHER`.
3. Submission routes Ticket to **ZM decision queue** (surfaces in Action Required panel).
4. Zonal Manager chooses one of:
   - **Reschedule** — assigns a new SE attempt on the same Ticket.
   - **Close as FAILED_RECOVERY** — mandatory reason; `closure_type = FAILED_RECOVERY_CLOSE`; audit trail recorded.
   - **Escalate to Operations Head** — for asset disputes or persistent unreachability.

**Manual closure (exception path — web dashboard only):**
- Zonal Manager, Operations Head, or CSM acting in ZM scope can manually close a Recovery Ticket from the Ticket Detail Drawer with a mandatory reason.
- `closure_type` is set to `ZM_MANUAL_CLOSE`, `OPERATIONS_HEAD_OVERRIDE_CLOSE`, or `CSM_ACTING_CLOSE` respectively.
- System records full audit: `actor_id`, `actor_role`, `closure_type`, `reason`, `timestamp`, `previous_state`, `device_serial` (if available).
- Manual close never silently bypasses warehouse receipt — all manual closures are flagged as non-standard in compliance reports.

#### Flow 8: 409 Conflict Handling

1. App shows full-screen 409 screen: *"This Ticket was already closed by [SE Name] at [time]. Your consumed components have been automatically logged as Shadow Use for Warehouse reconciliation."*
2. Van Stock decremented on the server regardless of submission rejection.
3. SE can tap **View Van Stock** or **Go Back to Day Plan**.

#### Flow 9: Expense Voucher Creation

1. Draft created locally with `client_submission_id` — works fully **offline**.
2. Fields: date, plant, expense type, amount per category, optional Ticket link, optional Vehicle link.
3. **Photo proof**: at least 1 photo required before submission.
4. **Submit** — if offline, queued and auto-submitted on reconnect.

#### Flow 10: Leave Request

1. SE selects: leave type (ON_LEAVE / WEEKLY_OFF), start date, end date.
2. Submits → ZM receives in-app notification; SE sees `PENDING` badge.
3. **ZM approves** → SE notified; SE_AVAILABILITY updated; Recommender excludes SE from candidate scoring for the approved window.
4. **ZM rejects** → SE notified with reason; SE can revise and resubmit.

#### Flow 11: SOFT_UNAVAILABLE Flag

1. SE sets SOFT_UNAVAILABLE with from-time and to-time.
2. During the window: SE excluded from Intra-day Re-plan candidate scoring; ZM notified.
3. At `to_ts`, availability automatically reverts to AVAILABLE.

#### Flow 12: Van Stock View

1. Per-component quantities. Common Kit items have a completeness indicator — all present → green "Kit Complete" badge; any missing → red "Kit Incomplete: [item list]" badge on Home screen.
2. Read-only — restocking arranged through ZM or Warehouse.
3. Push notification fires when a Common Kit item drops to zero.

#### Flow 13: QR Scanner

**Purpose:** Entry shortcut only. Opens Ticket Detail for a scanned vehicle or device. Does not create, assign, claim, submit, or close Tickets.

**Online flow:**
1. SE taps Scan → camera opens in scanner mode.
2. SE scans vehicle QR code, device QR code, or device serial barcode.
3. Backend searches active eligible Tickets by `vehicle_no` or `device_id`.
4. **Match found** → Ticket Detail opens. **No match** → toast: *"No active ticket found."*

**Offline behavior:**
- Matched Ticket cached locally → open cached Ticket Detail in read-only mode with offline indicator.
- Not cached → toast: *"Cannot search ticket while offline."*

**Constraints:**
- If multiple active Tickets exist for the same vehicle (multiple devices), a disambiguation list is shown before opening Ticket Detail.
- Manual text entry of `vehicle_no` or `device_id` available as fallback for damaged or missing QR labels.

#### Flow 14: Technical Hints

**Purpose:** Advisory diagnostic signals derived from raw AutoPlant DB snapshot telemetry. Purely informational — do not affect Ticket lifecycle, SLA, assignment, Recommender scoring, verification, or closure.

**Ticket Card (one or two most critical hints):**

| Condition | Hint shown on card |
|---|---|
| `MAINS_STATUS` = off / 0 | "No main power — check fuse" |
| `MAINS_VOLTAGE` < 10 V | "Low voltage" |
| `CSQ` ≤ 9 | "Weak GSM signal" |
| `GPS_VALIDITY` = invalid | "GPS signal invalid" |
| `GPS_MODE` = no fix | "No GPS fix" |
| `CREG` or `CGREG` = not registered | "Not on network" |
| Ignition = OFF | "Ignition off" |
| Speed > 5 km/h | "Vehicle in motion" |

If multiple anomalies exist, show the highest-severity hint only on the card.

**Ticket Detail (full technical section — always visible, no collapse):**
1. **Technical Hints section** — all derived hints for this device.
2. **Raw telemetry fields section** — Device Type, Unit No, IST Date/Time, GPS Date/Time, Ignition Status, MAINS_STATUS, MAINS_VOLTAGE, GPS_VALIDITY, GPS_MODE, Speed, CREG, CGREG, CSQ, Latitude/Longitude, IP Address/Port No, SIM Subscriber Name. All sourced from most recent Snapshot; carry the same data-as-of timestamp.
3. If no snapshot data available: shows "Telemetry unavailable" — hints section shows nothing; raw section shows the unavailability message.

### Domain Model & Routing Decisions

The following decisions are fully resolved in CONTEXT.md and are summarised here for PRD completeness. Each decision is binding; see CONTEXT.md for full rationale.

**Recommender routing (Decision §1):** Strict precedence — Dedicated SE first, Multi-Plant SE second, Floating SE last. Floating SE engaged when primary is ON_LEAVE/OFF_SHIFT/at-capacity or Plant has no plant-mapped SE.

**Recommender cadence (Decision §2):** Morning Batch at flexible Schedule Cadence (daily/alternate day/weekly/on-demand) produces Plant-wise Batch Assignments that **auto-dispatch** directly to the SE Day Plan. No fixed 08:00 IST gate, no approval gate, no auto-approve timer. Intra-day Re-plan fires only on Qualifying Events.

**Scoring (Decision §3):** Hard Filters → Company Tier gate → Device Bucket tier within Company Tier → weighted score within each cell → Plant Cluster Multiplier. Canonical sort: Company Tier → Device Bucket → Company Priority Rank → Oldest Inactive → Device ID (Decision §17).

**Work type unification (Decision §4):** Both Install and Troubleshoot share one Ticket entity with `work_type` discriminator. One SE capacity pool. SLA tier lets CRITICAL Troubleshoot pre-empt routine Install.

**Fleet Uptime (Decision §5):** Monthly time-weighted, eligibility-gated (active PGI within ~15 days AND not Non-Operational). Denominator = Eligible Devices only. Soft Inactive Count (recomputed twice daily) drives Recommender mode switching.

**Floating SE Territory (Decision §6):** Hierarchical (State/Region/District) + polygon overlay, union membership. PostGIS required. Pre-computed materialised view for performance.

**Batch Schedule dispatch (Decision §7):** System-generated Plant-wise Batch Assignments **auto-dispatch** to the SE Day Plan as Formal Assignments — **no ZM approval gate**. Status `AUTO_ASSIGNED → OVERRIDDEN`. No pending-but-visible lock, no auto-approve timer. ZM monitors and overrides post-hoc at flexible cadence; override surfaces ON_SITE conflict warning; mandatory reason code.

**Component resubmit (Decision §8):** Failure Cycle → WAITING_COMPONENT state; 1+ submissions per cycle. Resubmit ownership: Dedicated/Multi-Plant SE retains soft ownership; Floating SE ownership depends on spare delivery destination. 7-day auto-escalation.

**Auto-GPS verification (Decision §9):** Three-phase. ±500m applies only to the Phase-1 first ping, anchored on the SE's form-submission GPS (or ON_SITE geofence capture); skipped when `presence_source = NONE` (no fraud flag). Phase-2 movement expected. Install verification tracks new `device_id`.

**Presence (Decision §9):** No dedicated SE Confirmation screen. Presence is multi-signal — `presence_source = GEOFENCE_AUTO | MANUAL_ONSITE | FORM_GPS | NONE`. ON_SITE auto-updates from geofenced app actions (event-driven, not background tracking) with a manual ON_SITE fallback (audited). `STALE`/`UNKNOWN` readiness is a ZM readiness-conflict signal, not a Hard Filter drop or per-Ticket confirmation gate.

**Vehicle readiness model (CONTEXT.md §Readiness):** Readiness enum is `AT_PLANT | UPCOMING_TRIP | ON_TRIP | STALE | UNKNOWN | WAITING_CONFIRMATION | AVAILABLE_FOR_REPAIR` — `EXPECTED_BACK` is **removed**. An external **LR Date / Next Trip** signal (from another application, a planning hint only) feeds `UPCOMING_TRIP` (planned trip soon — colour hint, not a blocker) and, combined with current system time, `ON_TRIP` (on trip now — Hard Filter blocks normal assignment; Ticket still created and visible, manager override possible). `AT_PLANT` is confirmed only by SE field action (ON_SITE / deliberate location capture) — never inferred from LR Date. `UNKNOWN`/`STALE` are colour warnings only — never block assignment, never require SE Confirmation. LR Date alone never confirms `AT_PLANT` and never pauses SLA.

**SE cannot reject normal assigned work (CONTEXT.md §Formal Assignment):** The SE has **no Reject action** for normal assigned Tickets, Plant-wise Batch Assignments, or Work Schedules. The only accept/decline gate is **SE Acceptance/Decline on a system-triggered intra-day CRITICAL/HIGH_CRITICAL insertion** — distinct from rejecting normal work. An SE who cannot work an assigned Ticket files a Vehicle Unavailability Report or marks incomplete/unable with a mandatory reason.

**Analytics & reporting (CONTEXT.md §Analytics, Reporting & Data Lifecycle):** ZM Performance Scorecard (Operations Head / Operations Manager only — not a ZM self-score), Device Downtime History/Lifetime Trend on Device Detail, Root Cause % analytics (from structured Troubleshooting Form data), and System Efficiency Report are all served from summary tables / materialized views — never raw telemetry or multi-year `ticket_events` scans. Three data layers (hot operational / historical business / cold archive) with a retention policy keep operational APIs fast.

**SLA pause (glossary §Vehicle availability):** Primary SLA pauses only for documented reasons — `WAITING_COMPONENT` or a filed `VEHICLE_UNAVAILABLE` Report (each with `pause_reason` + `pause_source`). Raw readiness never auto-pauses. A manager-only **Secondary SLA Clock** keeps true elapsed time, visible only to ZM/CSM/Operations Head.

**SE Availability (Decision §10):** Single `SE_AVAILABILITY` time-windowed table. Status enum: AVAILABLE / ON_LEAVE / OFF_SHIFT / WEEKLY_OFF / SOFT_UNAVAILABLE / OFFLINE. ZM and SE are the only setters. Admin has no role.

**Install Ticket creation (Decision §11):** Manual creation by Zonal Manager (own zone) / Central Service Manager (scope) / Operations Head (all zones), single-create or CSV, scope-enforced. `install_trigger_source = MANUAL_OPERATIONS`; every Ticket records `created_by` + `created_by_role`.

**Component Hard Filter (Decision §12):** Common Kit (always) + Expected Component (when known). Blocked Tickets surface on Component-Blocked Queue.

**Shadow Use (Decision §13):** 409 Conflict → components decremented from Van Stock → SHADOW_USE INVENTORY_TRANSACTION row → Warehouse reconciliation queue.

**Non-Op marking (Decision §14):** Dual-confirmation lifecycle. CONFIRMED blocks new Failure Cycles, auto-closes in-flight Tickets, auto-creates Recovery Ticket for RECURRING deals.

**Role hierarchy and backup (Decision §15):** Operations Head → Central Service Manager → Zonal Manager. Backup cascades strictly up. All acted-as actions carry `acted_as_role` audit field.

**Intra-day SE Acceptance (Decision §16):** SE Acceptance required only for urgent same-day dispatches (system-triggered CRITICAL/HIGH_CRITICAL insertions). Not required for normal batch assignments. Acceptance Timeout = 10 min. After 3 retries → escalates to ZM for explicit assignment. WhatsApp Confirmation sent on acceptance. Offline SE handling: 15-min `last_activity_at` Hard Filter (activity-ping-based); ghost-assignment notification on reconnect.

**Cross-zone escalation (Decision §18):** Platinum auto-escalated to CSM after 1h unassigned in CRITICAL or 4h to SUBMITTED. Gold/Silver via manual ZM flag only.

### SE Activity Ping (ADR-0024)

Any SE-initiated app action updates `ENGINEER_MASTER.last_activity_at` — this is the SE Activity Ping. No fixed background timer. Background processes must not trigger an activity ping. Activity pings are for dashboard visibility and audit only; they must not auto-clear Soft States. An absent ping means the app has not received a recent signal — not that the SE has stopped working.

Two independent thresholds: 15-min (Recommender Hard Filter, silent — excludes SE from intra-day candidate scoring) and 1-h (OFFLINE SE Activity Status, visible on ZM dashboard — means "app not recently used", not "SE absent").

**Soft State rules:** VIEWED has a configurable timeout (default 1.5 h, Operations Head-configurable in Settings); on expiry it clears from active display but remains in audit. ON_SITE and TROUBLESHOOT_STARTED do **not** expire by time — resolved only by explicit events (form submission, SE marks incomplete/unable, ZM force-override with mandatory reason, shift end with ZM warning, or Ticket closure via valid system rules). Long-running ON_SITE and TROUBLESHOOT_STARTED trigger configurable stale-work warnings to the ZM; warnings do not clear the state. Warning thresholds are configurable globally by Operations Head in Settings.

### client_submission_id Dedup Contract

Generated at draft creation time, not at submit time. Uniqueness key: `(se_id, submission_type, client_submission_id)`. Submission types: `TROUBLESHOOTING_FORM`, `EXPENSE_VOUCHER`, `COMPONENT_REQUEST`, `COMPONENT_RESUBMIT`. Server must return the already-created record (or `duplicate = true`) on repeat — never create a second record or inventory transaction. A true 409 Conflict (Ticket already closed by another SE) is distinct from an idempotency duplicate. Inventory transactions reference their parent submission's `client_submission_id` rather than carrying their own.

### Notification Delivery

Two distinct delivery models: **General notifications** follow a fallback chain (mobile push → SMS → WhatsApp → email); in-app notification always fires. **SE Acceptance confirmation** always delivers WhatsApp Confirmation as a first-class channel in addition to in-app push — not a fallback.

---

## Testing Decisions

### What makes a good test

Tests should verify **external behaviour** through the component's public interface (rendered output, user events, callback invocations) — not internal state, class names, or implementation hooks. A good test breaks when the feature breaks, not when the implementation is refactored.

### Modules to test

1. **SLA Bucket classifier** — maps `inactiveHours` to `BucketKey`. Pure function; test full boundary set (0, 4, 8, 12, 24, 48, 72, 120, 168+ hours).
2. **Candidate sort order** — test that a mixed `(company_tier, bucket, priority_rank, oldest_inactive, device_id)` array sorts deterministically per CONTEXT.md Decision §17.
3. **Failure Cycle state machine transitions** — each valid and invalid transition; `WAITING_COMPONENT` pauses SLA; `VERIFIED` cycles are immutable.
4. **Batch Schedule dispatch flow** — system-generated batch is `AUTO_ASSIGNED` and SE-actionable immediately (no approval gate, no pending lock); ZM override flips status to `OVERRIDDEN` and propagates to the SE Day Plan; override-after-ON_SITE shows conflict warning; ZM manual same-day update propagates without SE Acceptance.
5. **Device/Ticket filtering** — filter combinations (zone + bucket + company + assignment) produce correct row subsets.
6. **Non-Op marking dual-confirmation** — `CONFIRMED` only reachable after both parties confirm; in-flight Ticket auto-close fires correctly.
7. **GPS Phase-1 location check** — ±500m rule applies only to first post-submission ping; Phase-2 pings accepted regardless of location.
8. **Recommender Hard Filter** — candidates with `ON_TRIP` readiness, incomplete Common Kit, or missing expected components dropped before scoring.
9. **SE Activity Status derivation** — computed at render time from SE_AVAILABILITY + soft states + `last_activity_at`; never stored; correct derivation for each combination including OFFLINE = "app not recently used, not absent."
10. **Soft State lifecycle rules** — VIEWED clears on configurable timeout (default 1.5 h); ON_SITE and TROUBLESHOOT_STARTED do not expire by time; stale-work warning fires at configured threshold without clearing state; shift-end while ON_SITE produces warning, not silent clear; ZM force-override records mandatory reason.
11. **Offline Queue lifecycle** — PENDING item auto-syncs on reconnect; idempotency duplicate marks DELIVERED without creating a second record; 409 Conflict marks FAILED and surfaces correct screen; DELIVERED items are removed on cleanup; FAILED items persist until SE acknowledges; pending unsynced items are never deleted automatically; queue approaching limit surfaces warning.
12. **Offline Queue storage constraints** — photo stored as file reference not blob; local photo copy removed after successful upload; completed Tickets cleared after retention window without touching pending submissions; batch sync sends items in small batches, not all at once.
13. **Offline dedup (mobile)** — submitting the same `client_submission_id` twice results in exactly one server record, not two.
14. **409 Conflict handling (mobile)** — Shadow Use row created; Van Stock decremented; SE sees correct conflict screen.
15. **SE Activity Ping** — any SE-initiated app action updates `last_activity_at`; background processes (offline queue flush, push notification receipt) do not trigger a ping; ping absence does not clear any Soft State.
16. **QR Scanner resolution** — online match, offline-cached, offline-uncached paths; multi-device disambiguation list shown when a vehicle has multiple active Tickets.
17. **Technical Hints derivation** — hints correctly derived from raw telemetry field values; no hint changes Ticket state, SLA, or assignment; "Telemetry unavailable" shown when no snapshot data.

### Testing approach

- **Unit tests:** Vitest (web) for pure functions and state machine logic.
- **Component tests:** React Testing Library for page-level interaction (filter controls, Batch Schedule approval, Ticket Detail Drawer tabs).
- **Mobile:** platform-appropriate unit and integration tests for form dedup, offline queue, GPS capture, SE Activity Ping trigger, and Soft State lifecycle rules.
- **Prior art:** No tests currently exist in the repo. First test: SLA Bucket classifier — pure function, clear domain rules, zero UI dependencies.

---

## Out of Scope

- **External Order Webhook (v2)** — auto-creating Install Tickets from SAP PGI events is deferred.
- **Finance system integration** — Finance processes reimbursements via the monthly Excel export only. No Finance role, webhook, or real-time payment status in v1.
- **Customer portal** — Customer confirmation of Non-Operational markings is done via one-time tokenised email link in v1; a customer-facing portal is v2.
- **Courier tracking on Component Requests** — the 6-state Phase 2 lifecycle (`IN_TRANSIT → DELIVERED → CONFIRMED`) is schema-reserved but not built in v1.
- **Floating SE polygon territory editor** — map polygon drawing deferred; hierarchical (State / Region / District) selectors are v1.
- **Data Quality Error Queue** — engineering-owned; not a domain concept visible to any operations role.
- **Stale-work warning threshold default values** — ON_SITE and TROUBLESHOOT_STARTED warning thresholds are configurable in Settings; specific default values are implementation-defined and tuned during rollout.
- **Offline Queue configurable limits** — max pending items (default 500), storage warning threshold, and Ticket cache retention window (default 7–15 days) are tuned during rollout based on observed device performance.

---

## Further Notes

### Terminology

| Use | Avoid |
|---|---|
| Zonal Manager | Zone Head, Zone Manager |
| Company | Customer |
| LONG_PENDING | AGED_CRITICAL |
| Van Stock | Service Engineer Stock |
| Component Request | spare request, parts request |
| Snapshot | sync, refresh, pull |
| SE Activity Status | SE status (derived display label, never a stored field) |
| WhatsApp Confirmation | WhatsApp fallback (first-class channel for SE Acceptance, not a fallback) |
| Fleet Uptime denominator | total installed devices (denominator = Eligible Devices only) |
| SLA paused (documented: `WAITING_COMPONENT` or `VEHICLE_UNAVAILABLE` Report) | SLA auto-paused from raw readiness (ON_TRIP/STALE/UNKNOWN) without a Vehicle Unavailability Report |
| Work Schedule / Plant-wise Batch Assignment | Morning Day Plan (daily cycle), daily plan |
| Schedule Cadence | fixed daily cadence, morning batch cycle |
| Batch Schedule Monitoring & Override | Day Plan Approval, Batch Schedule Review (no approval gate) |
| ZM manual same-day update | intra-day re-plan (system-triggered CRITICAL path is distinct) |
| SE acts immediately on dispatched batch (`AUTO_ASSIGNED`) | approval gate, pending-but-visible, awaiting-approval lock |
| Schedule Cadence reminder notification | approval gate, 08:00 IST deadline, auto-approve |
| SE Acceptance (urgent same-day dispatches only) | SE Acceptance for normal batch assignments (not required) |
| SE Activity Ping / `last_activity_at` | Heartbeat, fixed-interval timer, continuous background ping |
| OFFLINE Activity Status = "app not recently used" | OFFLINE = "SE is not working" or "SE is absent" |
| Stale-work warning (ON_SITE / TROUBLESHOOT_STARTED) | Auto-expiry or timer-based clear of ON_SITE or TROUBLESHOOT_STARTED |
| Device GPS Ping (from GPS hardware via AutoPlant DB) | SE Activity Ping (from mobile app) — these are separate signals |
| AutoPlant DB (Snapshot ingestion source) | NG / Drishti (legacy name; keep only in historical references) |
| Vehicle Unavailability Report (documented SLA pause) | pausing SLA on raw readiness without a report |
| Secondary SLA Clock (manager-only, never pauses) | showing a never-pausing clock to the SE; using it as the contractual SLA |
| Multi-signal Presence (geofence / manual ON_SITE / form GPS) | SE Confirmation screen, trust_score 0.85 (removed) |
| Readiness: AT_PLANT / UPCOMING_TRIP / ON_TRIP / STALE / UNKNOWN | EXPECTED_BACK (removed) |
| UPCOMING_TRIP / UNKNOWN / STALE = colour warning only | UNKNOWN / STALE as an assignment blocker or SE-confirmation gate |
| AT_PLANT confirmed by SE field action | AT_PLANT inferred from LR Date alone |
| ON_TRIP = LR Date + current system time (blocks assignment) | LR Date alone pausing SLA |
| LR Date / Next Trip = external planning signal (hint) | LR Date as sole source of truth or contractual SLA-pause trigger |
| SE Acceptance/Decline (intra-day CRITICAL insertion only) | SE rejecting normal assigned Tickets / Batches / Work Schedules |
| ZM Performance Scorecard (Operations Head / Operations Manager) | ZM self-score / ZM planning scorecard shown to the ZM |
| Reports/scorecards read summary tables / MVs | scanning raw telemetry or multi-year ticket_events per request |
| Structured root_cause_category on Troubleshooting Form | relying only on free-text diagnosis_notes for root-cause analytics |

### Data-as-of Timestamp

Every dashboard panel that derives from Snapshot data must display the timestamp of the last successful Snapshot. A `FAILED` or stuck Snapshot renders a red alert. Stale data must never be mistaken for a real fleet health improvement.

### SLA Bucket Reference

| Bucket | Inactivity Age | Colour |
|---|---|---|
| LONG_PENDING | 7d+ | Deep red |
| VERY_SEVERE | 5–7d | Red |
| SEVERE | 3–5d | Orange-red |
| HIGH_CRITICAL | 48–72h | Orange |
| CRITICAL | 24–48h | Amber |
| RISK | 12–24h | Yellow |
| EARLY_RISK | 8–12h | Yellow-green |
| WARNING | 4–8h | Green |
| ACTIVE | 0–4h | Not shown in queues |
