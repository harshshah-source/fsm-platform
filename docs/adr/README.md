# Architecture Decision Records

Decisions resolved during the FSM PRD grill, documented here for use by `/grill-with-docs` and future design sessions. Each ADR follows the format: Status → Context → Decision → Consequences.

Cross-references use `ADR-NNNN` notation.

| ADR | Title |
|-----|-------|
| [0001](0001-se-routing-strict-precedence.md) | SE-to-Device Routing Uses Strict Precedence with Capacity Fallback |
| [0002](0002-recommender-hybrid-cadence.md) | Recommender Cadence Is Hybrid — Daily Plan + Event-Triggered Re-plan |
| [0003](0003-scoring-customer-tier-device-bucket.md) | Scoring Uses Customer-Tier-First, Device-Bucket-Second Tier Structure |
| [0004](0004-unified-ticket-work-type.md) | Installs and Troubleshoots Share One Ticket Entity Distinguished by `work_type` |
| [0005](0005-fleet-uptime-monthly-soft-inactive-count.md) | Fleet Uptime Is Monthly Time-Weighted; Soft Inactive Count Drives the Recommender |
| [0006](0006-floating-se-territory-hierarchical-polygon.md) | Floating SE Territory Combines Hierarchical Geography with Polygon Overlay |
| [0007](0007-morning-batch-one-click-approval.md) | Morning Batch Is Per-SE Day Plan One-Click Approval; Intra-day Uses SE Acceptance Flow |
| [0008](0008-failure-cycle-resubmit-waiting-component.md) | Failure-Cycle Resubmit After Component Wait — State, Cardinality, and Ownership |
| [0009](0009-auto-gps-verification-three-phase.md) | Auto-GPS Verification Is Three-Phase; ±500m Applies Only to First Post-Submission Ping |
| [0010](0010-se-availability-time-windowed-table.md) | SE Availability Is One Time-Windowed Table; Zonal Manager and SE Are the Only Setters |
| [0011](0011-install-tickets-operations-head-only-v1.md) | Install Tickets Created by Operations Head Only in v1; External Order Webhook Deferred to v2 |
| [0012](0012-component-availability-layered-hard-filter.md) | Component Availability Is a Layered Hard Filter — Common Kit Always, Expected Component When Known |
| [0013](0013-shadow-use-auto-record-on-409.md) | Rejected-on-409 SE's Physical Component Use Is Auto-Recorded as Shadow Use |
| [0014](0014-non-operational-dual-confirmation.md) | Non-Operational Marking Requires Dual Confirmation; Recurring-Deal Devices Trigger a Recovery Ticket |
| [0015](0015-role-hierarchy-backup-cascade.md) | Role Hierarchy Is Operations Head → Central Service Manager → Zonal Manager; Backup Cascades Up |
| [0016](0016-intraday-se-acceptance-whatsapp.md) | Intra-day CRITICAL Insertions Require SE Acceptance + WhatsApp Confirmation |
| [0017](0017-canonical-candidate-processing-order.md) | Canonical Candidate Processing Order: Company Tier → Device Bucket → Priority Rank → Oldest → Device ID |
| [0018](0018-cross-zone-platinum-auto-escalation.md) | Cross-Zone Help Auto-Asked Only for Platinum; Gold/Silver Require Manual Escalation |
| [0019](0019-day-plan-approval-sla-visibility-override.md) | Day Plan Approval SLA — Pending-Visible, Read-Receipt Flag Clear, Always-Overridable |
| [0020](0020-sla-pauses-component-only-not-vehicle.md) | SLA Pauses Only for Component Unavailability, Never for Vehicle Unavailability |
| [0021](0021-repeat-failure-cycle-new-cycle-immutable-verified.md) | Repeat Failure Opens a New Cycle; VERIFIED Cycles Are Immutable |
| [0022](0022-se-planner-soft-bias-morning-batch.md) | SE Planner Is a Soft Morning Batch Bias Signal, Not a Hard Constraint |
| [0023](0023-se-activity-status-derived-never-stored.md) | SE Activity Status Is Derived at Query Time, Never Stored |
