# FSM — GPS Field Service Management

Operations-side system for keeping a fleet of installed GPS devices ≥98% active by intelligently surfacing inactive devices to a finite field-engineer pool via Zonal-Manager-approved suggestions, and recording installs and troubleshooting for governance.

## Operating envelope

- **Installed fleet:** ~50,000 GPS devices, pan-India.
- **Field workforce:** ~40 Service Engineers (mixed coverage types — see below).
- **Master service target:** **≥98% Fleet Uptime** — measured monthly, eligibility-gated. See *Decisions* §5.
- **Management posture:** the system **assigns** schedules directly to SEs; the **Zonal Manager monitors and can override** (reassign, split, defer, reorder) at any time. System-generated Plant-wise Batch Assignments dispatch to the SE Day Plan without a pre-approval gate. Urgent intra-day CRITICAL/HIGH_CRITICAL insertions still require explicit **SE Acceptance** before they commit.

## Language

### People

**Service Engineer (SE)**:
Field engineer who installs new GPS devices and troubleshoots inactive ones.
_Avoid_: technician, agent, executive

**Zonal Manager**:
Operations owner of one **Zone**. **Monitors and overrides** system-dispatched SE assignments (no pre-approval gate — Decisions §7) and resolves readiness conflicts within their zone. Holds full own-zone operational authority: set SE availability, approve leave, confirm/edit/resume **Vehicle Unavailability**, create **Install Tickets** for own-zone Plants (Decisions §11), and **view (read-only) Component Requests** raised by SEs for Tickets/devices in their zone (see *Component Request*). A Zonal Manager may **not** approve warehouse stock movement unless explicitly authorized — warehouse approval belongs to the Warehouse Manager. All powerful actions are audited.
_Avoid_: Zone Head (used inconsistently in the PRD — canonical term is **Zonal Manager**); describing the ZM as "approving" normal batch assignments (those auto-dispatch; the ZM overrides post-hoc).

**Central Service Manager**:
Cross-zone operational layer between Zonal Manager and Operations Head. Normal authority: cross-zone reporting visibility, routine cross-zone SE-deployment approvals, escalations not strategic enough for Operations Head. **Acting authority**: when a Zonal Manager is unavailable, Central Service Manager exercises full Zonal-Manager authority for that Zone — Day Plan override, readiness conflict resolution, Non-Op confirmation, SE Availability set. All such actions are audited as `acted_as_role = CENTRAL_SERVICE_MANAGER`. **Current-phase access:** complete access across all modules and all zones (the same fleet-wide breadth as Operations Head for this phase), including Install Ticket creation within scope; all powerful actions audited.

**Operations Head / Company Manager**:
Cross-zone strategic owner; handles fleet-wide reporting, strategic cross-zone escalations, and acts as second-line backup when *both* the Zonal Manager and Central Service Manager are unavailable. Also the **system configurator** — owns zone/plant setup, SE mappings, SLA rules, priority rules, company tier overrides, and user account management. No separate "Admin" persona exists. **Current-phase access:** complete access across all modules and all zones; all powerful actions audited.
_Avoid_: Admin (PRD term — maps to Operations Head in this system)

**Warehouse Manager**:
Owner of physical inventory — spare parts (cables, SIMs, antennas, fuses), new GPS devices, and replacement units. Approves or rejects SE component requests, tracks GPS and SIM serial numbers, verifies component usage against Tickets, handles inventory rollback when a Ticket fails GPS verification, and reconciles the Shadow Use Queue when two SEs physically worked the same Ticket.

### SE coverage types

**Dedicated SE**:
SE mapped 1:1 to a single **Plant**. All open devices at that Plant route to this SE first.

**Multi-Plant SE**:
SE mapped to 3–4 named **Plants**. Devices route among their mapped Plants.

**Floating SE**:
SE mapped to a **Territory** rather than specific Plants. Acts as fallback/fill capacity when a Dedicated or Multi-Plant SE is unavailable, or when a Plant has no plant-mapped SE at all.

**Coverage**:
The set of Plants (for Dedicated/Multi-Plant SEs) or Regions/Districts (for Floating SEs) an SE is responsible for.
_Avoid_: "mapping" alone — mapping is the underlying record, **coverage** is the responsibility.

### Geography

**Plant**:
A physical company site (logistics yard, depot, factory) housing vehicles fitted with GPS devices. Primary unit of **plant clustering**. One Plant may have vehicles from multiple **Transporters**.

**Transporter**:
The logistics or trucking company that operates vehicles at a Plant. Distinct from the **Customer** — the Customer holds the GPS contract and pays for the service; the Transporter's driver operates the vehicle. One Plant may have multiple Transporters. The SE contacts the Transporter (not the Customer) to coordinate vehicle access for repair — Transporter name appears on Tickets for SE field use. Transporter is not a billing or contracting entity in FSM; it is a coordination and vehicle-ownership reference.
_Avoid_: fleet owner (the Company may or may not own the fleet; Transporter operates it)

**Zone**:
Coarse rollup of Plants (e.g., NORTH / SOUTH / EAST / WEST). Unit of **Zonal Manager** authority.

**Region / District**:
Finer geographic units beneath Zone. **District** is a standard Indian administrative unit (~700 nationwide). **Region** is an admin-defined named cluster of Districts used for human-readable territory descriptions.

**Territory**:
A Floating SE's coverage area, defined by **hierarchical coverage** (a set of State / Region / District identifiers) **and/or** **polygon coverage** (a lat-long polygon over a map). A Plant is in an SE's Territory if it falls inside any covered District *or* any covered polygon — membership is the union of the two.

### Work objects

**Device**:
A single GPS unit, identified by `device_id`, mapped to one **Vehicle** at a time. One Vehicle may carry multiple Devices in different `device_role`s (PRIMARY, SECONDARY, BACKUP, COMPANY_SPECIFIC, TEMPORARY, UNKNOWN).

**Device Role**:
The `device_role` on a Vehicle↔Device mapping. Describes why a Device is fitted — not a quality tier. Auto-verification tracks the **specific `device_id`** named in the Ticket (the failed device, or its replacement `new_device_id`). A BACKUP Device waking up does not close a PRIMARY Device's Ticket — they are different `device_id` values and verification is per-device-id, not per-vehicle.
_Avoid_: using role names as priority levels — PRIMARY is a position label, not a quality rank

**Inactive Device**:
A Device whose `latest_gps_datetime` is older than the inactivity threshold (default 24h).

**Failure Cycle**:
The audit record for one inactivity episode of one Device — opened on inactivity threshold, closed on verified GPS recovery. Immutable once closed. Parent of exactly one **Troubleshoot Ticket**; may carry **1+ form submissions** if the first submission stalled waiting on a component. Full state machine:
- `OPEN` — ticket created, awaiting SE troubleshooting
- `WAITING_COMPONENT` — SE submitted with `component_unavailable=true`; SLA paused; Component Request in flight (Decision §8)
- `SUBMITTED` — form submitted, awaiting auto-GPS verification
- `VERIFIED` — GPS auto-verification passed; device recovered; cycle immutable from here
- `FAILED` — auto-verification failed; device not recovered
- `REPEAT` — opened on a **new** Failure Cycle for the same device that re-failed within 24h of a prior `VERIFIED` closure; links back via `previous_failure_cycle_id`; old cycle stays `VERIFIED` and is never reopened
- `ESCALATED` — 3+ repeat cycles in 7 days, or other escalation criteria

**Waiting Component**:
A Failure Cycle state entered when the SE submits with `component_unavailable=true`. Holds the cycle while a **Component Request** runs through warehouse approval and delivery. 7-day timeout auto-escalates to the Zonal Manager. **This is the canonical signal for "stuck on a part"** — the PRD's `VERIFICATION_PENDING_COMPONENT` literal in §4.18.2 is dropped; the Ticket stays in `OPEN` state and the SE/manager UIs derive the "awaiting component" badge from the Failure Cycle state.

**Component Request**:
A formal request raised automatically when an SE submits a troubleshooting form with `component_unavailable=true`. Routes to the Warehouse Manager for approval and fulfilment. v1 lifecycle: `REQUESTED → APPROVED | REJECTED → SHIPPED → RECEIVED`. On `RECEIVED`, SE confirms receipt, SLA resumes, and the SE resubmits the troubleshooting form (new `client_submission_id`) on the same Ticket. If rejected, SE escalates to Zonal Manager or submits an alternative fix. If neither `RECEIVED` nor `REJECTED` within 7 days, Ticket auto-escalates to Zonal Manager. **Phase 2** expands to a 6-state model with courier tracking (`REQUESTED → PENDING_APPROVAL → APPROVED | REJECTED → IN_TRANSIT → DELIVERED → CONFIRMED`) — schema designed for this expansion.

**Zonal Manager visibility (read-only):** the Zonal Manager can see every Component Request for Tickets/devices in their zone, showing **requested component, Ticket/device, the SE who raised it, request status, Warehouse action/status, and age**. This is visibility only — the ZM does **not** approve or reject stock movement (the Warehouse Manager owns approval) unless explicitly authorized.
_Avoid_: spare request, parts request (use Component Request); a Zonal Manager approving warehouse stock movement without explicit authorization

**Resubmit Ownership**:
The rule that decides who gets the Ticket when a spare arrives. **Dedicated / Multi-Plant SE** keep soft ownership (re-suggested first). **Floating SE** ownership depends on the spare's delivery destination: SE_LOCATION → original SE; PLANT_WAREHOUSE → return to pool. All resubmits require Zonal Manager confirmation.

**Soft Ownership**:
A Recommender preference (not a lock) to re-suggest the original SE for a resubmit when context preservation is worth more than re-optimising assignment. Distinct from Formal Assignment and from soft states.

**Ticket**:
The unified actionable work item handled by SEs. Carries a `work_type` of **`TROUBLESHOOT`** or **`INSTALL`**; both share Recommender, Day Plan, manager approval flow, soft states, and SE capacity pool but have distinct lifecycle states and verification rules.

**Work Type**:
The `Ticket.work_type` discriminator. `TROUBLESHOOT` for inactive-device repair (always parented by a Failure Cycle). `INSTALL` for first-time device fitting (no Failure Cycle parent). `RECOVERY` for physical retrieval of a provider-owned Device after Non-Operational marking under a recurring deal. Set at creation, immutable thereafter.

**Troubleshoot Ticket**:
A Ticket with `work_type = TROUBLESHOOT`. Lifecycle: `OPEN → SUBMITTED → VERIFICATION_PENDING (PARTIAL_RECOVERY badge when 1–2 pings received) → CLOSED` (or `FAILED_VERIFICATION` / `ESCALATED` / `CLOSED_AUTO_RECOVERY`). Verified by **recovery pings** after the parent Failure Cycle's submission timestamp.

**Partial Recovery**:
A visible badge displayed on the Zonal Manager dashboard and SE mobile app when a Ticket in `VERIFICATION_PENDING` has received 1–2 GPS pings — enough to show the device is responding, but below the ≥3-ping threshold required for closure. The Ticket remains in `VERIFICATION_PENDING`; `PARTIAL_RECOVERY` is a sub-state badge, not a separate lifecycle state. Monitoring continues until either the full criteria are met (`CLOSED`) or the 24h escalation window expires.

**Auto-Recovery**:
A Troubleshoot Ticket closes as `CLOSED_AUTO_RECOVERY` when the Device resumes sending GPS pings that satisfy the verification criteria (≥3 pings, ≥15 min span, ≥1h stability) **without any SE troubleshooting form having been submitted**. Distinct from `CLOSED` (SE repaired and GPS-verified). No components are consumed; no SE effort is credited. Reports must separate auto-recoveries from genuine repairs to measure SE productivity and real component consumption accurately. SE cannot submit a form after auto-recovery — returns 409 Conflict.
_Avoid_: self-heal, auto-close (use auto-recovery)

**Install Ticket**:
A Ticket with `work_type = INSTALL`. Created manually (single-create UI or CSV bulk upload) by **Zonal Manager** (own zone), **Central Service Manager** (authority scope), or **Operations Head** (all zones); each Ticket records `created_by` + `created_by_role` and a full audit entry (Decisions §11). Lifecycle: `REQUESTED → SCHEDULED → ON_SITE → FITTED → ACTIVATED → CLOSED` (or `FAILED_ACTIVATION`). Verified by **first valid GPS ping** post-fitment. `ACTIVATED` timestamp anchors warranty start. The `device_serial` (new `device_id`) and `sim_serial` recorded by the SE at the `FITTED` stage become the canonical `device_id` that auto-verification tracks for pings — this is the same per-device-id verification rule from Decision §9. Verification follows that specific `device_id`, not the vehicle.

**Recovery Ticket**:
A Ticket with `work_type = RECOVERY`. Lifecycle: `REQUESTED → SCHEDULED → ON_SITE → COLLECTED → RECEIVED_AT_WAREHOUSE → CLOSED` (or `FAILED_RECOVERY`). Auto-created when a Non-Operational marking is `CONFIRMED` for a Device whose deal is recurring (asset belongs to the service provider) and the marking reason implies physical retrieval (vehicle scrapped/sold, company paused service, device replacement pending).

**Closure authority:**

_Normal closure path:_
1. SE marks `COLLECTED` after physically retrieving the device (mandatory: device serial confirmation, condition notes).
2. Warehouse Manager confirms `RECEIVED_AT_WAREHOUSE` after checking the physical device and serial number against the Ticket record.
3. On Warehouse Manager confirmation, the Ticket closes automatically — `closure_type = AUTO_CLOSED_ON_WAREHOUSE_RECEIPT`. No Zonal Manager approval required for this path.

_Manual closure (exception path):_
The following roles may manually close a Recovery Ticket when the normal path is not reachable. Manual closure must never silently bypass warehouse receipt — every manual close must record `closure_type`, `actor_id`, `actor_role`, `reason` (mandatory), `timestamp`, `previous_state`, and `device_serial` / expected device reference where available.

| Role | `closure_type` | Scope |
|---|---|---|
| Zonal Manager | `ZM_MANUAL_CLOSE` | Own zone only |
| Operations Head | `OPERATIONS_HEAD_OVERRIDE_CLOSE` | All zones |
| Central Service Manager | `CSM_ACTING_CLOSE` | Only when acting in ZM scope (Decision §15) |

_Failed recovery path:_
- SE marks "unable to collect" on mobile with a mandatory reason code (`COMPANY_REFUSED | VEHICLE_UNREACHABLE | DEVICE_MISSING | OTHER`). The Ticket enters a Zonal Manager decision queue.
- Zonal Manager can: **reschedule** (create a new SE assignment attempt on the same Ticket), **close as FAILED_RECOVERY** (`closure_type = FAILED_RECOVERY_CLOSE`, mandatory reason), or **escalate to Operations Head**.
- Operations Head can override-close with `closure_type = OPERATIONS_HEAD_OVERRIDE_CLOSE`.

**`closure_type` enum:** `AUTO_CLOSED_ON_WAREHOUSE_RECEIPT | ZM_MANUAL_CLOSE | OPERATIONS_HEAD_OVERRIDE_CLOSE | CSM_ACTING_CLOSE | FAILED_RECOVERY_CLOSE`

**Audit fields required on every closure:** `actor_id`, `actor_role`, `closure_type`, `reason` (mandatory for all manual and FAILED_RECOVERY closes; not required for AUTO_CLOSED_ON_WAREHOUSE_RECEIPT), `timestamp`, `previous_state`, `device_serial` (from COLLECTED stage data when available).

**Auto-escalation:** a Recovery Ticket with no state progression for a configurable window (default 14 days) surfaces in the ZM Action Required panel.
_Avoid_: silently closing a Recovery Ticket without recording `closure_type` and reason; treating `AUTO_CLOSED_ON_WAREHOUSE_RECEIPT` as requiring ZM approval; allowing a CSM to manually close outside their acting scope.

**Deal Type**:
The commercial arrangement under which a Device was deployed: `RECURRING` (subscription/lease — provider retains asset ownership) or `ONE_TIME` (sale — company owns asset). Derived from CRM/SAP contract data; falls back to Operations Head manual tagging when integration data is missing. Drives whether a Recovery Ticket is created on Non-Op confirmation.

**Installation**:
The real-world event a `work_type = INSTALL` Ticket represents — a first-time fitting of a Device on a Vehicle.

**Snapshot**:
A periodic read of the source GPS database (**AutoPlant DB**), capturing a point-in-time view of all device states — GPS timestamp, location, vehicle mapping, plant, and transporter. Processed in chunks; a failed chunk is retried without restarting the full run. Status values: `RUNNING | SUCCESS | FAILED | PARTIAL`. All manager dashboards show a **data-as-of timestamp** derived from the last successful Snapshot so Zonal Managers and Operations Head know how fresh their device data is. A `FAILED` or stuck Snapshot is an operational concern visible to both roles — stale data means inactive devices may not surface in time for SE dispatch.
_Avoid_: sync, refresh, pull (use Snapshot)

**Expense Voucher**:
An SE's claim for reimbursement of field-visit costs (travel, accommodation, parts, tools, meals, other). Submitted via mobile with at least one photo proof (receipt or item). Two-step approval: **Zonal Manager** reviews first — verifying (a) SE has an activity record at the claimed plant on the claimed date, (b) expense type is legitimate for the SE's role and territory, (c) amount is within configured per-category limits, and (d) photo proof is present and legible — then **Finance** processes reimbursement via **monthly Excel export** (no real-time FSM integration in v1; Finance runs its own reimbursement process). Statuses in FSM: `DRAFT → SUBMITTED → ZONAL_MANAGER_REVIEW → APPROVED | REJECTED | NEEDS_CLARIFICATION`. `PAID` status is set by Operations Head when Finance confirms the monthly batch was processed. Optionally linked to a Ticket and/or Vehicle for context. Supports offline draft with same `client_submission_id` dedup pattern as the troubleshooting form.
_Avoid_: expense claim, reimbursement request

**client_submission_id**:
A UUID generated by the mobile app when an SE creates a form draft locally — at **draft creation time, not at submit time** — so it survives app restarts, network failures, and offline queue retries. The uniqueness scope is `(se_id, submission_type, client_submission_id)`. Submission types: `TROUBLESHOOTING_FORM`, `EXPENSE_VOUCHER`, `COMPONENT_REQUEST`, `COMPONENT_RESUBMIT`.

**Idempotency rule:** if the server receives a request with a `client_submission_id` already recorded for the same `(se_id, submission_type)`, it must not create a second record, inventory transaction, or component request — it returns the already-created record or a `duplicate = true` response. This is an **idempotency duplicate** and is distinct from a **business 409 Conflict**.

**Business 409 Conflict:** a separate rejection used when the submission is not a retry but the Ticket or business object is no longer actionable — because another SE's submission already won or auto-recovery already closed the Ticket. The 409 Conflict path triggers **Shadow Use** recording if the rejected SE consumed components; the idempotency duplicate path does not.

Inventory transactions reference their parent mobile submission's `client_submission_id` rather than carrying their own, so duplicate retries do not produce duplicate inventory movement.
_Avoid_: generating the UUID at submit time (a retry after partial network failure would appear as a new submission); conflating idempotency duplicates with business 409 Conflicts

### Fleet metric

**Fleet Uptime %** (contractual master KPI):
Time-weighted fraction of the month a Device was online, averaged over **Eligible Devices** only. Calculated monthly; target ≥98%. Reported per fleet / zone / company / plant. The number that goes on company SLA reports.

**Eligible Device**:
A Device that counts toward the Fleet Uptime denominator for a given month — has had an active order / **PGI** within the last ~15 days *and* is not currently **Non-Operational**.

**PGI** (Post Goods Issue):
SAP term — the event when goods are dispatched against a sales order. Used here as the proof that a vehicle is in active commercial use and therefore its Device should count toward Fleet Uptime.

**Non-Operational Marking**:
A flag that excludes a specific Device from Fleet Uptime calculation for a defined window. Requires both **Zonal Manager confirmation** and **Customer confirmation** to take effect. Lifecycle: `REQUESTED → AWAITING_<OTHER_PARTY>_CONFIRMATION → CONFIRMED → ACTIVE → EXPIRED | UNMARKED`. Recorded in `NON_OPERATIONAL_MARKING`. While `CONFIRMED/ACTIVE`: new Failure Cycle creation is blocked, in-flight Tickets auto-close as `CLOSED_NON_OPERATIONAL`, and if the Device's Deal Type is `RECURRING` a Recovery Ticket is auto-created.

**Soft Inactive Count** (operational mode-switch signal):
Count of Eligible Devices currently silent >24h (canonical inactivity threshold). Recomputed **twice daily** (morning, afternoon). Drives the Recommender's switch between **deficit mode** and **preventive mode**. Same eligibility filter as Fleet Uptime % so both metrics agree on what counts.

**Deficit Mode / Preventive Mode**:
The Recommender's two operating modes. **Deficit Mode** is active when Soft Inactive Count exceeds a configured threshold (default `> 2% × eligible_device_count`) — the planner prioritises maximum devices-cleared-per-SE-day with plant clustering. **Preventive Mode** is active otherwise — the planner shifts to repeat-offenders, aged devices, and Install backlog.

### Assignment model

**Recommendation**:
A *system-generated* binding between one SE and one Ticket. System-generated batch Recommendations are **committed directly** into the SE's Day Plan as **Formal Assignments** — they do **not** wait for Zonal Manager approval; the Zonal Manager can override post-hoc. The **primary** construct that mediates between an open Ticket and an SE's day.
_Avoid_: describing a system-generated batch Recommendation as "awaiting approval" — the only Recommendations that wait for explicit human confirmation are urgent intra-day CRITICAL/HIGH_CRITICAL insertions (SE Acceptance, Decisions §16).

**Work Schedule**:
The primary scheduling entity for SE field work. A Work Schedule groups one or more **Plant-wise Batch Assignments** for an SE, covering a date or date range. Generated by the Recommender and **dispatched directly to the SE**; the Zonal Manager monitors and can override at a flexible **Schedule Cadence** — not locked to a fixed daily cycle, and not gated behind a pre-approval step. The SE sees their Work Schedule as their primary work view on mobile.

**Plant-wise Batch Assignment**:
A group of open inactive-device Tickets from a single Plant assigned as a unit to one SE mapped to that Plant. The fundamental building block of a **Work Schedule**. Assignment rules: Dedicated SE receives their mapped Plant first; Multi-Plant SE receives batches from their mapped Plants; Floating SE is fallback when no plant-mapped SE is available or plant-mapped SE is at capacity. Batch size is bounded by SE Daily Capacity. The system prefers assigning a whole plant batch to one SE to minimise travel and maximise plant clearance — the Zonal Manager may split a batch across SEs when needed.

**Schedule Cadence**:
The flexible frequency at which the Zonal Manager creates, reviews, or updates Work Schedules. Not fixed — may be daily, alternate day, 2–3 times per week, or weekly, according to operational need. The system may send a configurable reminder notification at a set time (e.g., 08:00 IST) to prompt ZM review, but this is a notification only — it is not a workflow gate that locks SE actions.

**Day Plan**:
The SE's primary mobile work view, showing their assigned Plant-wise Batch Assignments for the current and upcoming dates. Populated from the Work Schedule. First-class entity on the SE mobile home screen. The SE can act on assigned Tickets (apply Soft States, submit forms) as soon as a batch appears in their Day Plan — no approval gate blocks SE actions on normal scheduled work.
_Avoid_: treating Day Plan as synonymous with a single daily cycle approved at 08:00 — it reflects the current Work Schedule state, which may be updated at any cadence.

**Formal Assignment**:
A system-committed binding SE↔Ticket link, generated from Plant-wise Batch Assignments in the Work Schedule and appearing **directly** in the SE's Day Plan under "Assigned to Me" — **no Zonal Manager pre-approval is required**. The Zonal Manager can override, reassign, split, defer, or reorder it at any time (audited, reason-coded). Distinct from the urgent intra-day insertion path, which still requires SE Acceptance.

**SE cannot reject normal assigned work.** The SE gets **no Reject option** for normally assigned Tickets, Plant-wise Batch Assignments, or Work Schedules — those are committed and immediately actionable. The only affirmative-or-negative response an SE makes is **SE Acceptance / Decline on a system-triggered intra-day CRITICAL/HIGH_CRITICAL insertion** (see *SE Acceptance*) — this is the acceptance of an urgent same-day insertion, **not** rejection of normal assigned work, and must be kept distinct from it. An SE who cannot work an assigned Ticket in the field files a **Vehicle Unavailability Report** or marks incomplete/unable with a mandatory reason; they do not "reject" the assignment.
_Avoid_: a Reject action on normal assigned Tickets/Batches/Schedules; conflating intra-day CRITICAL Decline with rejecting normal work.

**Shared Pool**:
The set of open Tickets at an SE's **mapped/covered Plants** that the SE can see in the mobile app as **secondary / open work**, visible **regardless of Formal Assignment**. Formal Assignment / Assigned Work takes UI priority; the Shared Pool remains visible alongside it as additional pickable work for the SE's own Plants. An SE must **not** see Tickets outside their mapped/covered Plants unless **explicitly assigned by an authorized override**.
_Note_: **Day Plan / Work Schedule / Formal Assignment is primary** in the UI; Shared Pool is always-visible secondary work scoped to the SE's covered Plants.
_Avoid_: gating Shared Pool visibility on "SE has no Formal Assignments / cleared all work"; surfacing Tickets from Plants outside the SE's coverage.

**Override**:
The Zonal Manager (or acting role) post-hoc adjustment of a system-dispatched Work Schedule or Plant-wise Batch Assignment — change the assigned SE, split a batch across SEs, remove specific Tickets, defer Tickets, or reorder work, before or after the SE has started. There is **no Approve gate**: system-generated batches are already live in the SE's Day Plan when the ZM sees them. If an SE holds an ON_SITE Soft State on a Ticket in the batch, the dashboard surfaces a conflict warning before committing the override. All overrides are audited with mandatory reason codes.
_Avoid_: an "Approve before actionable" step on normal system-generated batches — that gate is removed.

**SE Acceptance**:
The explicit affirmative response an SE gives to an **urgent same-day dispatch** — a system-triggered intra-day CRITICAL/HIGH_CRITICAL insertion or a Zonal Manager manual same-day assignment that requires explicit SE confirmation. SE Acceptance is **not required for normal Plant-wise Batch Assignments** — those appear directly in the SE's Day Plan and are immediately actionable. On acceptance of an urgent dispatch, a **WhatsApp Confirmation** is sent to the SE as a redundant detail message.

**Acceptance Timeout**:
The bounded interval (default 10 min) for the chosen SE to accept an Intra-day insertion. On timeout, the system auto-reroutes to the next-best SE per precedence and retries. After 3 unsuccessful retries, the insertion escalates to the acting Zonal Manager for explicit assignment.

**WhatsApp Confirmation**:
The detail message sent to an SE over WhatsApp once they've accepted an Intra-day insertion in-app. Carries ticket number, vehicle, plant, expected component (if any), and a deeplink back into the mobile app. Redundant against app notification — for situations where the SE later loses app context. **Always sent on SE Acceptance regardless of push notification success** — first-class channel for this event type, not a fallback.

**Notification Delivery**:
Two distinct delivery models coexist. **General notifications** (new ticket, SLA warning, failed verification, soft-state timeout, etc.) follow a fallback chain: mobile push → SMS → WhatsApp → email; in-app notification always fires. **SE Acceptance confirmation** always delivers WhatsApp Confirmation as a first-class channel in addition to the in-app push — not as fallback.
_Avoid_: treating WhatsApp as fallback-only; it is first-class for SE Acceptance events

### Recommender

**Recommender**:
The background service that produces Recommendations. Runs in two cadences (see *Decisions* §2).

**Morning Batch**:
A Recommender run that produces a set of **Plant-wise Batch Assignments** for one or more SEs and **dispatches them directly to the SE Day Plan** as Formal Assignments. The trigger is not a fixed 06:30 IST cron — the ZM runs or schedules it at the cadence that suits their **Schedule Cadence** (daily, alternate day, weekly, or on-demand). The system may send a configurable reminder notification (e.g., 08:00 IST) to prompt the ZM to review the dispatched batch, but this notification is advisory — it is not a workflow gate and the batch is already live for the SE. Reads **SE Planner** entries as a bias signal when scoring. Planner entries automatically surface in the resulting Day Plan; Zonal Manager can override at any time.

**SE Planner**:
A plant-visit scheduling tool used by the Zonal Manager — separate from the Day Plan. Shows a plant-vs-date grid for the week (or multi-day range); manager manually assigns which SE visits which plant on which date. Plant-level intent, not ticket-level. Acts as a **bias signal** to the Morning Batch Recommender (not a hard constraint — Recommender can deviate if scoring demands it). Planner assignments automatically appear in the corresponding Day Plan, where the Zonal Manager can override before approval.
_Avoid_: confusing SE Planner (plant visit intent, manager-authored) with Day Plan (ticket list, Recommender-generated)

**Intra-day Re-plan**:
A re-run triggered only by a **Qualifying Event**, never on a fixed cron. Two sub-types:
- **System-triggered CRITICAL insertion**: fired automatically when a new Ticket enters CRITICAL or HIGH_CRITICAL bucket; follows SE Acceptance flow (Decisions §16).
- **Zonal Manager manual same-day update**: ZM can add, remove, or reorder Tickets in an SE's current Day Plan at any time during the shift. No SE Acceptance is required for a manual ZM-initiated same-day update; the updated plan appears in the SE's Day Plan immediately. If the SE holds an ON_SITE Soft State on a Ticket being removed, the dashboard surfaces a conflict warning before committing.

**Qualifying Event**:
A condition that justifies disturbing the current Work Schedule mid-shift. Today's working set: a new Ticket entering CRITICAL or HIGH_CRITICAL bucket, an SE completing their Day Plan with capacity remaining, an SE going offline / shift cut, or a **Zonal Manager manual same-day schedule update**.

### Scoring

**Hard Filter**:
A condition that drops a `(SE, Device)` candidate before scoring. Today's set: vehicle readiness is `ON_TRIP` (actively on a trip — unreachable, derived from LR Date / Next Trip + current system time), SE over Daily Capacity, SE not `AVAILABLE`, **Common Kit incomplete on the SE**, **any known `expected_component` unavailable in van + Zone Warehouse**. `UPCOMING_TRIP`, `STALE`, and `UNKNOWN` readiness do **not** hard-drop a candidate — `UPCOMING_TRIP` is a colour hint (the Recommender may prioritise a vehicle likely to leave soon), and `STALE`/`UNKNOWN` surface as a Zonal Manager **readiness-conflict** signal resolved in the field via ON_SITE capture or a **Vehicle Unavailability Report**, not a per-Ticket confirmation gate.

**Common Kit**:
The baseline set of parts every SE is expected to carry on every visit (cables, SIM, antenna, fuse — configurable by Operations Head). Missing any kit item effectively grounds the SE for Recommender purposes until restock. Distinct from per-ticket `expected_component`.

### Inventory

**Mother Warehouse**:
The central national or regional stock facility. Ships components down to Zone Warehouses. Owned by a Warehouse Manager. Physical location with a physical stock count.

**Zone Warehouse**:
One physical stock point per Zone (NORTH / SOUTH / EAST / WEST). Receives stock from Mother Warehouse; issues to SEs or ships directly to Plants. An SE can pick up an Expected Component here as a planned morning-detour stop in their Day Plan (ADR-0012).

**Van Stock**:
The components physically carried by an SE in their van or field bag. Moves with the SE. Tracked per SE in `SE_VAN_STOCK`. Source of Common Kit inventory and on-site component consumption during repairs.
_Avoid_: Service Engineer Stock (PRD term — canonical name is Van Stock)

**Ticket Consumption**:
An accounting category (not a physical place) recording components consumed on a specific repair — linked to a Ticket. Creates `INVENTORY_TRANSACTION` rows that decrement Van Stock and eventually Zone/Mother Warehouse counts.

**Faulty Return**:
An accounting category (not a physical place) recording broken or defective components sent back from an SE toward the Zone or Mother Warehouse for inspection, disposal, or repair. Creates `INVENTORY_TRANSACTION` rows with `type = FAULTY_COMPONENT_RETURNED`.

**Expected Component**:
A component the system *predicts* a Ticket will need at scheduling time. Populated by: repeat-failure detection (carries forward the part used last time), prior partial diagnosis, Install setup (device serial + SIM), or WAITING_COMPONENT resubmit (the awaited part). First-time troubleshoot Tickets typically have none.

**Component-Blocked Queue**:
The Zonal Manager dashboard view of Tickets dropped from Day Plans because Common Kit is incomplete or `expected_component` is OOS. Each row shows the missing part and the Warehouse Manager action status — making the filter operational rather than a silent UX.

**Shadow Use**:
An `INVENTORY_TRANSACTION` status that records components physically consumed by an SE whose Ticket submission was rejected with 409 Conflict (because another SE submitted first). The components are decremented from van stock; the row surfaces on the **Shadow Use Queue** for Warehouse Manager reconciliation.

**Shadow Use Queue**:
The Warehouse Manager dashboard view of unreconciled `SHADOW_USE` inventory rows. Manager marks each `RECONCILED` (genuine duplicate effort) or `DISPUTED` (mismatch with the winning SE's report — escalates to Zonal Manager).

**SLA Bucket**:
The inactivity-age band of a Device. Full set in descending severity order: `LONG_PENDING` (7d+) › `VERY_SEVERE` (5–7d) › `SEVERE` (3–5d) › `HIGH_CRITICAL` (48–72h) › `CRITICAL` (24–48h) › `RISK` (12–24h) › `EARLY_RISK` (8–12h) › `WARNING` (4–8h). Devices in the 0–4h band are `ACTIVE` — not an SLA bucket, no ticket needed. Used as a strict **tier gate** in scoring — any candidate in CRITICAL+ is ranked before any candidate in a lower bucket (Decisions §17).
_Avoid_: confusing "bucket" (age) with "priority" (score); using `AGED_CRITICAL` — canonical name is `LONG_PENDING`.

**Priority Score**:
The per-Device urgency value combining `company_priority_rank` (A/B/C…), repeat-failure history, device dispatch urgency, and `device_role`. Used **within** a Company Tier × Device Bucket cell of the canonical sort (Decisions §17), never across cells.

**Company Master**:
The reference table of all companies (`COMPANY_MASTER`). Each row carries `company_id`, `company_tier` (Platinum / Gold / Silver), `company_priority_rank` (A / B / C / …), and standard contact/contract fields. Sourced from CRM/SAP; Operations Head can override per-company.
_Avoid_: Customer Master, CUSTOMER_MASTER (PRD table name — canonical table name is COMPANY_MASTER)

**Company Tier**:
The premium-service classification on `COMPANY_MASTER.company_tier` — `PLATINUM | GOLD | SILVER`. The **top-level gate** in the canonical sort: a Platinum company's Ticket is processed before any Gold's, a Gold before any Silver's, regardless of device bucket. Priority order: **Platinum > Gold > Silver**; Company Priority Rank breaks ties within the same tier.
_Avoid_: Customer Tier

**Company Priority Rank**:
The finer company-importance code on `COMPANY_MASTER.company_priority_rank` (A, B, C, …). Used **within** Company Tier × Device Bucket cells to break ties between companies of the same tier.
_Avoid_: Customer Priority Rank

**Plant Cluster Multiplier**:
A score boost applied to additional Devices at a Plant already present in an SE's Day Plan — the mechanism that makes an SE clear a Plant in one visit instead of one device per visit.

**Daily Capacity**:
The ceiling on the number of Tickets an SE can be planned for in one day. Hard filter input. _(Per-SE value, configured by Admin.)_

**SE Availability**:
The stored planning-level flag in `SE_AVAILABILITY`: `AVAILABLE | ON_LEAVE | OFF_SHIFT | WEEKLY_OFF | SOFT_UNAVAILABLE | OFFLINE`. Only `AVAILABLE` lets the Recommender include the SE in candidate scoring. **Zonal Manager** and the **SE** are the only roles that can write records; Operations Head has no role in availability tracking.

**Soft State**:
A temporary SE progress signal set on a Ticket to communicate real-time field activity. Distinct from a **Ticket lifecycle state** — a Soft State never advances the Ticket through its state machine and is stored in a separate record, not in the Ticket's status field. Three values, with different lifecycle rules:

**`VIEWED`** — SE has opened the Ticket detail.
- Has a **configurable timeout** (default 1.5 h; Operations Head can change this in Settings).
- On expiry: clears from active display and the ZM dashboard. Remains in the audit trail.

**`ON_SITE`** — SE is physically at the vehicle location.
- **How it is set:** ON_SITE can **auto-update** when a deliberate SE app action captures a location inside the Plant/vehicle **geofence** (`onsite_source = AUTO_GEOFENCE`) — event-driven on app actions, **not** continuous background tracking. If phone location is OFF, capture fails, or the SE is outside the geofence, the Home/Ticket page shows a prompt and the SE can **manually tap ON_SITE** (`onsite_source = MANUAL`, audited). There is no separate "I am physically at this vehicle" confirmation screen — see **Presence (multi-signal)**.
- **Does not expire automatically by time.** Remains active until one of these explicit resolution events occurs:
  - SE advances to the next action on the Ticket (TROUBLESHOOT_STARTED, form submission, or marks incomplete/unable with a mandatory reason).
  - The Ticket closes through valid system rules (auto-verification, auto-recovery, 409 Conflict, Non-Op close).
  - SE's shift ends — the state is **not** silently cleared; a warning surfaces on the ZM dashboard: *"[SE Name]'s shift ended while ON_SITE at [Plant]."* Zonal Manager must explicitly resolve, force-close, or reassign with a mandatory reason and audit trail entry.
  - Zonal Manager force-overrides with mandatory reason and audit trail.
- A **stale-work warning** fires to the Zonal Manager when ON_SITE has been held longer than the configured warning threshold. The warning does **not** clear the state — it is an attention signal only.

**`TROUBLESHOOT_STARTED`** — SE has opened and is actively working the troubleshooting form.
- **Does not expire automatically by time.** Remains active until one of these explicit resolution events occurs:
  - SE submits the Troubleshooting / Install / Recovery form.
  - SE marks incomplete / unable to complete with a mandatory reason (audit row created).
  - Zonal Manager force-resolves with mandatory reason and audit trail.
  - Ticket closes through valid system rules (auto-verification, auto-recovery, 409 Conflict, Non-Op close).
- A **stale-work warning** fires to the Zonal Manager when TROUBLESHOOT_STARTED has been held longer than the configured warning threshold. The warning does **not** clear the state.

**Stale-work warning thresholds** for ON_SITE and TROUBLESHOOT_STARTED are configurable globally by Operations Head in Settings. Default values are implementation-defined. These thresholds replace the prior concept of auto-expiry for these two states.

**SE Activity Pings** (see SE Mobile App → SE Activity Ping) must not auto-clear any Soft State. An absence of recent activity pings means the system has not received a signal from the SE's app — it does not mean the SE has left the vehicle or stopped working. The SE may be working offline or in a no-network area.

Multiple SEs may hold Soft States on the same Ticket simultaneously — this overlapping activity is visible on the Zonal Manager dashboard and is the primary input to **SE Activity Status** derivation. **Shadow Use is not triggered by overlapping Soft States** — it is triggered only when a later SE's form submission is rejected with 409 Conflict because the Ticket was already submitted and closed by another SE, and the rejected SE had physically consumed components.
_Avoid_: treating Soft States as Ticket lifecycle states (e.g., OPEN, SUBMITTED, CLOSED) or as exclusive locks; auto-clearing ON_SITE or TROUBLESHOOT_STARTED based on time — a timer-based expiry discards valid active field work; confusing SE Activity Pings with Device GPS Pings (see both entries).

**SE Activity Status**:
A **derived display label** shown on the Zonal Manager dashboard — never stored as a separate field. Computed at query time from `SE_AVAILABILITY.status` + active Ticket soft states + `last_activity_at` + shift schedule. Values: `AVAILABLE` (no active soft state), `ON_SITE` (holds VIEWED or ON_SITE soft state on a Ticket), `BUSY` (holds TROUBLESHOOT_STARTED soft state), `SHIFT_ENDING` (within 1h of shift end), `OFFLINE` (`last_activity_at < now − 1 h` — means app not recently used; SE may be working offline). Distinct from SE Availability.
_Avoid_: treating Activity Status as a stored field or conflating it with SE Availability; interpreting `OFFLINE` as "SE is not working" — it means the app has not sent a recent activity ping, which may simply reflect offline field conditions.

### Vehicle availability

**Readiness**:
Confidence-scored state of whether a Vehicle is physically reachable for repair: `AT_PLANT`, `UPCOMING_TRIP`, `ON_TRIP`, `STALE`, `UNKNOWN`, `WAITING_CONFIRMATION`, `AVAILABLE_FOR_REPAIR`. `EXPECTED_BACK` is **removed** as a main readiness state (superseded by the LR Date / Next Trip signal model below). `WAITING_CONFIRMATION` is retained only for manager/customer confirmation flows — it is **not** an SE assignment blocker. `AVAILABLE_FOR_REPAIR` is retained only where already canonical; no further states are added.

State meanings:
- **`AT_PLANT`** — vehicle confirmed present and reachable. **Confirmed only by SE field action** — set when the SE reaches the Plant and captures ON_SITE / a deliberate location action. **AT_PLANT is never inferred from LR Date alone.**
- **`UPCOMING_TRIP`** — derived from the external **LR Date / Next Trip** signal: the vehicle has an upcoming planned trip. **Not a hard assignment blocker.** Surfaced as a colour hint / warning on the ZM dashboard and the SE Ticket Detail. The Recommender *may* prioritise such a vehicle (per SLA / company tier) if it is likely to leave the Plant soon.
- **`ON_TRIP`** — derived from the LR Date / Next Trip signal **plus current system time**: the vehicle is currently on an active trip / unreachable. **`ON_TRIP` blocks normal SE assignment** (Hard Filter). The Ticket is still created and visible to the ZM / Ticket Pool; manager override remains possible with reason + audit.
- **`UNKNOWN` / `STALE`** — no reliable fresh availability signal. **Never blocks assignment** and **never requires SE Confirmation before assignment.** Shown as a colour hint / readiness-conflict warning only. The Recommender assigns normally using Company Tier, SLA Bucket, Company Priority Rank, oldest-inactive, plant clustering, SE coverage, SE availability, Daily Capacity, and Common Kit / Expected Component availability.

Canonical wording: *"UNKNOWN / STALE readiness is a colour-coded warning only, not an assignment blocker. The Recommender still assigns using SLA, company tier, SE coverage, capacity, and component rules. AT_PLANT is confirmed only by SE field action. UPCOMING_TRIP comes from LR Date. ON_TRIP is derived from LR Date plus current system time and blocks normal assignment."*
_Avoid_: `EXPECTED_BACK` (removed); inferring `AT_PLANT` from LR Date alone; treating `UNKNOWN`/`STALE` as an assignment blocker or as requiring per-Ticket SE Confirmation; pausing SLA from LR Date / readiness alone (see §SLA, §Vehicle Unavailability Report).

**LR Date / Next Trip signal**:
A planning signal for vehicle availability received from an **external application** (not AutoPlant DB telemetry). It supplies a vehicle's loading-receipt (LR) date / next planned trip. The system stores it under vehicle availability signals and uses it to **derive `UPCOMING_TRIP`** (an upcoming planned trip) and, combined with current system time, **`ON_TRIP`** (currently on trip). It is a planning hint only: it **must not become the only source of truth**, **must not directly pause SLA**, and **must not by itself confirm `AT_PLANT`**. Field reality (SE ON_SITE) and the Vehicle Unavailability Report always take precedence over the LR signal.
_Avoid_: treating LR Date as a contractual SLA-pause trigger; letting LR Date override an SE field confirmation.

**SLA**:
Time targets enforced on each inactive-device Ticket: `submit_within_minutes` (SE must submit troubleshooting form), `verify_within_minutes` (GPS recovery must confirm), `escalate_after_minutes` (escalate to Zonal Manager if neither happened). Clock starts when the Failure Cycle opens. The **primary (contractual / SE-facing) SLA clock pauses** for exactly two documented reasons, each carrying a recorded `pause_reason` + `pause_source`:
- **`WAITING_COMPONENT`** — SE submitted with `component_unavailable=true`; a warehouse-approval-trailed part blocker.
- **`VEHICLE_UNAVAILABLE`** — the SE filed a **Vehicle Unavailability Report** (a documented human signal: SE physically at the Plant, contacted the Transporter, recorded reason + expected-availability window). See that entry.

**Raw readiness alone (`ON_TRIP`, `STALE`, `UNKNOWN`) must never auto-pause SLA** — readiness is often unconfirmed and can only *suggest or validate* a pause, never freeze the clock by itself. Whenever the primary clock is paused, the **Secondary SLA Clock** keeps running (see entry) so managers retain a true-elapsed view. SLA resumes per the resume conditions defined on each pause reason.
_Avoid_: SLA breach (use SLA escalation — the system escalates, not formally "breaches" unless reported); auto-pausing SLA from readiness state without a documented Vehicle Unavailability Report.

**Vehicle Unavailability Report**:
A documented field signal the SE files from the mobile app when they physically reach the Plant and find the vehicle not available to work. It is the **only** trigger that pauses SLA with `pause_reason = VEHICLE_UNAVAILABLE`. To support it, Ticket Detail must surface the **Transporter name and contact number** (the SE contacts the Transporter directly from the Ticket). The SE records: `reason_code` (`VEHICLE_ON_TRIP | VEHICLE_NOT_AT_PLANT | DRIVER_NOT_AVAILABLE | CUSTOMER_REFUSED | OTHER`), `transporter_contacted` (yes/no), the transporter name/number used, `expected_available_from` and `expected_available_to` (expected return date/time), optional notes, and SE GPS/location if available. On submit, the primary SLA clock pauses and the Ticket displays *"Vehicle unavailable — expected back on [date/time]"*. The Zonal Manager can edit/confirm the expected-availability window. When the expected-availability date arrives, the system **resurfaces the Ticket** for scheduling/reassignment. SLA **resumes** when any of: (1) the expected-availability date arrives and a manager/system marks it available, (2) the SE reaches ON_SITE / access is confirmed, (3) the Zonal Manager manually resumes it, or (4) fresh AutoPlant DB readiness data confirms availability where business rules trust it. Raw readiness alone never resumes-by-itself without one of these documented events.
_Avoid_: pausing SLA on readiness state without this report; treating it as the same pause as `WAITING_COMPONENT` — the two are distinct `pause_reason` values.

**Secondary SLA Clock**:
A parallel, **manager-only** elapsed-time clock that **never pauses**, running alongside the primary SLA clock for the full life of the Ticket. It exists so that a paused primary clock (component or vehicle-unavailability) cannot hide true elapsed time from oversight. Visible **only** to **Zonal Manager, Central Service Manager, and Operations Head** — never surfaced to the SE or used for contractual SLA reporting. The primary clock drives SE-facing SLA, escalation timers, and contract reports; the Secondary SLA Clock drives manager situational awareness and aging.
_Avoid_: showing the Secondary SLA Clock to the SE; using it as the contractual SLA figure.

**Presence (multi-signal)**:
How the system establishes that an SE is physically at the vehicle, **without a dedicated "I am at the vehicle" confirmation screen** (removed). Presence is derived from whichever signals exist, recorded as `presence_source` on the relevant action: `GEOFENCE_AUTO` (ON_SITE auto-set from a geofenced location capture), `MANUAL_ONSITE` (SE tapped ON_SITE as a fallback, audited), `FORM_GPS` (GPS auto-captured at form submission), or `NONE` (no location available). The Phase-1 verification anchor (Decisions §9) uses the form-submission GPS, or the ON_SITE geofence capture when present; with `presence_source = NONE` the Phase-1 geo-check is skipped (no fraud flag), not blocked.
_Avoid_: a fixed `trust_score = 0.85` confirmation value (removed); forcing the SE to confirm presence per Ticket/device.

## SE Mobile App

The SE mobile app is the field-facing product consumed by Service Engineers. Domain concepts specific to the mobile experience are captured here. All underlying domain entities (Ticket, Failure Cycle, Soft State, SE Availability, etc.) are shared with the web dashboard.

**Tech stack:** React Native + Expo (SDK 54) + Expo Router. Android-first; iOS-compatible. Offline-first local storage (WatermelonDB or equivalent SQLite). Push notifications via FCM (Android) / APNs (iOS). GPS and camera access required. Secure token storage via react-native-keychain.

**Offline Queue**:
The local FIFO queue of pending SE submissions on a device, persisted in SQLite (WatermelonDB). Each queued item holds its `client_submission_id`, `submission_type`, `payload`, `queued_at`, `retry_count`, `last_attempt_at`, and `status` (`PENDING | RETRYING | DELIVERED | FAILED`). Auto-syncs on connectivity restore in FIFO order with exponential backoff up to a configurable max retry count.

**Server response handling:**
- Idempotency duplicate → mark `DELIVERED`; no duplicate record created.
- 409 Conflict (Ticket already closed) → mark `FAILED`; SE sees the 409 Conflict screen; Shadow Use path fires if components were consumed.
- 5xx / network error → retry with exponential backoff.

**Storage constraints — optimised for low-end Android devices:**
- Store only pending form/action metadata and compact JSON payloads. Do not store full Ticket history, large raw telemetry history, or zone-wide Ticket lists locally.
- Cache only the assigned/current Tickets needed for the SE's active field work.
- Queue table must be indexed by `status`, `queued_at`, `ticket_id`, and `submission_type` for performant lookups on low-spec devices.
- Sync in small batches — never flush the entire queue in one request.

**Photo and attachment handling:**
- Photos must be compressed before storing or uploading. Store local file references (file paths) in the queue, not binary blobs inside SQLite.
- Per-submission photo limits apply per Troubleshooting Form and Expense Voucher rules.
- On successful photo upload, remove the local temporary photo copy unless the submission is still an unsynced draft.
- Expense Voucher and form attachments must be cleaned up from local storage after successful sync.
- Display a low-storage warning to the SE when device storage drops below a configured threshold.

**Retention and cleanup:**
- `DELIVERED` items must be removed or compacted after successful sync — do not accumulate acknowledged items indefinitely.
- `FAILED` items remain until the SE explicitly acknowledges, retries, or resolves them. `FAILED` items must not be silently deleted.
- Cached Tickets that are completed (closed, verified, or no longer in the SE's active plan) are cleared after a configurable retention window (default 7–15 days).
- The app must provide a safe cleanup path that removes expired/delivered items without touching any pending unsynced submissions.

**Queue limits:**
- Maximum pending queued items per device is configurable (default 500).
- When the queue approaches the limit, warn the SE and prioritise sync.
- Pending unsynced submissions must never be automatically deleted without an explicit SE acknowledgement and a clear warning.

**Multi-device rule:** The Offline Queue is per-device. `client_submission_id` is generated at draft creation time on the specific device and must not be shared or copied across devices. If the same SE creates a draft for the same Ticket on two different devices, they produce different UUIDs; the second submission to arrive at the server follows the standard 409 Conflict path — no special inter-device coordination is needed.
_Avoid_: storing photo blobs directly in SQLite; caching the full zone Ticket list locally; syncing the full queue in one large batch; auto-deleting pending unsynced items without SE acknowledgement.

**SE Activity Ping**:
A backend signal recorded when the SE performs any deliberate action in the mobile app. Updates `ENGINEER_MASTER.last_activity_at`. Triggered by: opening a Ticket, tapping VIEWED / ON_SITE / TROUBLESHOOT_STARTED, submitting a form, confirming component receipt, scanning a QR code, refreshing the app, or syncing queued offline actions. Background processes (offline queue auto-sync, push notification receipt) do **not** trigger an activity ping.

**Purpose: dashboard visibility and audit only.** The timestamp answers "when did this SE last interact with the app?" It must not gate Soft States, must not auto-clear ON_SITE or TROUBLESHOOT_STARTED, and must not be treated as proof the SE is present or absent. An SE may be working offline or in a no-network area; an absent ping means the system has not received a signal — not that the SE has stopped working.

**`last_activity_at` is visibility and audit only — it never gates scoring or assignment.** It must **not** exclude an SE from Morning Batch, Day Plan, Formal Assignment, intra-day Re-plan/update, or CRITICAL insertion, even when stale. An unreachable SE offered an urgent intra-day insertion is handled by the **Acceptance Timeout + reroute** (Decisions §16), not by a pre-emptive ping filter. *(This supersedes the earlier 15-min Recommender Hard Filter and ADR-0024 on that point; ADR-0024 is historical.)*

Drives one threshold:
- **1-hour threshold (SE Activity Status):** if `last_activity_at < now − 1 h`, the SE's derived **SE Activity Status** label flips to `OFFLINE` on the Zonal Manager dashboard — meaning "app not recently used", not "SE is not working." This is a display label only; it does not affect candidate scoring.

Activity-ping-derived `OFFLINE` rows in `SE_AVAILABILITY` are short-lived, tagged as activity-sourced, and must not appear as leave in reports or be treated as approved absence for batch scheduling purposes.
_Avoid_: implementing as a continuous background timer; using `last_activity_at` to auto-clear Soft States; **using `last_activity_at` to gate Recommender scoring, candidate filtering, or assignment (Morning Batch, Day Plan, intra-day, CRITICAL insertion)**; treating a missing ping as absence; confusing SE Activity Pings with **Device GPS Pings** (separate concept — see below).

**Device GPS Ping**:
A location and status packet transmitted by a GPS device to the **AutoPlant DB** platform and captured in the Snapshot. Used for auto-verification (checking device recovery pings after SE form submission), auto-recovery detection, and Technical Hints telemetry. Entirely separate from SE Activity Pings — a Device GPS Ping carries no information about SE reachability or field activity.
_Avoid_: treating Device GPS Pings as SE reachability signals; substituting Device GPS Pings for SE Activity Pings or vice versa — they come from different sources and serve entirely different purposes.

**QR Scanner**:
An entry shortcut on the SE mobile Home screen that resolves a scanned code to an active eligible Ticket, allowing the SE to open Ticket Detail without manual search. Accepts three input types: vehicle QR code, device QR code, or device serial barcode. Resolution rule: backend searches active eligible Tickets by `vehicle_no` or `device_id` matching the scanned value.

**Domain access rules:**
- The scanner is a **read-only navigation shortcut** — it opens Ticket Detail only. It does not create, assign, claim, apply a Soft State, submit, or close Tickets. Any state change requires explicit SE action inside Ticket Detail.
- **Scope-limited to the caller's coverage.** QR resolution is two-step — the scanned value resolves to a `device_id`/`vehicle_id`, then to active eligible Tickets for that key — and the result set is constrained to what the caller may already see: an **SE** resolves only Tickets at their mapped/covered Plants **or** Tickets assigned to them (formal or authorized override); **Zonal Manager / Central Service Manager / Operations Head** resolve under their own zone/fleet scope. The scanner is never a path to a Ticket outside the caller's coverage.
- Resolves to the active eligible Ticket for the scanned identifier. If a vehicle carries multiple active Tickets (multiple devices), a disambiguation list is shown before opening Ticket Detail.
- **Online:** backend search returns match or "no active ticket" response.
- **Offline — cached Ticket:** opens cached Ticket Detail in read-only mode.
- **Offline — uncached:** returns "Cannot search ticket while offline."
- Manual text entry of `vehicle_no` or `device_id` is a required fallback for damaged or missing QR labels.
_Avoid_: using the scanner to perform any Ticket action — it is a navigation entry point only; using the scanner to reach Tickets outside the caller's coverage.

**Leave Request**:
An SE-initiated submission from the mobile app requesting a planned absence window. Fields: leave type (`ON_LEAVE` or `WEEKLY_OFF`), start date, end date, optional reason. Routed to the Zonal Manager (or acting role) for approval.

- **On approval:** the system writes a time-windowed `SE_AVAILABILITY` row for the requested dates; the Morning Batch Hard Filter excludes the SE from candidate scoring for the entire approved window.
- **On rejection:** the SE is notified with a reason and may revise and resubmit.
- **SE cannot self-approve:** an SE cannot directly write `ON_LEAVE` or `WEEKLY_OFF` to their own `SE_AVAILABILITY` — only the Zonal Manager or acting role can commit those statuses, whether via approving a Leave Request or by directly setting availability (the latter requires a proper audit trail entry with `set_by_role`).

**Critical distinction — Leave Request vs activity-ping-derived absence:**
A Leave Request is a deliberate, approved planned absence. An `OFFLINE` SE Activity Status derived from a stale `last_activity_at` is not a Leave Request, must not be written to `SE_AVAILABILITY` as `ON_LEAVE` or `WEEKLY_OFF`, and must not be treated as approved absence for batch scheduling purposes. Activity-ping-derived offline rows are short-lived operational signals tagged separately.
_Avoid_: treating a Leave Request as self-approved; treating a stale activity ping as leave; confusing SE-submitted Leave Request with the Zonal Manager directly setting availability — both paths write `SE_AVAILABILITY`, but the authority, approval status, and audit fields differ.

**Technical Hint**:
An advisory diagnostic signal derived at display time from raw **AutoPlant DB** snapshot telemetry fields for a Device (power status, supply voltage, GPS validity, GPS mode, GSM/GPRS registration, signal strength, ignition state, speed, coordinates, and connection details). Shown on SE mobile Ticket Cards (most critical anomaly only) and in Ticket Detail (all anomalies plus full raw field values).

**Hard constraint:** a Technical Hint is purely informational — it does **not** affect Ticket lifecycle state, SLA clock, Recommender scoring, assignment, auto-verification result, escalation trigger, or any other domain rule. No hint creates, advances, or closes a Ticket.

Technical Hints are sourced from the most recent **Snapshot** for the Device and carry the same data-as-of timestamp. If no snapshot data is available for a Device, the hints section shows "Telemetry unavailable" rather than showing nothing — so the SE can distinguish a healthy device from a data gap.
_Avoid_: treating Technical Hints as a verification input, a scoring signal, or a lifecycle gate — they are SE-facing diagnostic aids only.

## Web Dashboard

The admin web dashboard (`fsm-admin-dashboard`) is the primary UI layer that consumes this domain model. All domain terms, state machines, and rules described in this document are implemented in the dashboard as display and interaction logic; no server state is mutated without a backend round-trip.

**Tech stack:** React + TypeScript + Vite, Tailwind CSS, shadcn/ui component primitives. No SSR. Static mock data in `src/admin/data/` until API integration.

**Shell:** `AdminShell` (`src/admin/components/AdminShell.tsx`) provides the sidebar and top-bar frame. `ZoneDashboardHome` (`src/admin/pages/ZoneDashboardHome.tsx`) dispatches to page components via the `AdminPage` union in `App.tsx`.

**Key UI rules derived from domain decisions:**

- *SE Activity Status* is always computed at render time from `SE_AVAILABILITY.status` + active Ticket soft states + heartbeat age. It is never fetched from a stored status field (see §SE Activity Status).
- *Snapshot freshness banner* appears on every page showing the last successful Snapshot timestamp. A `FAILED` or stuck Snapshot renders a red alert — stale data must never be mistaken for a real fleet health improvement.
- *SLA bucket colour coding* maps severity to colour, highest severity first: LONG_PENDING (deep red) › VERY_SEVERE › SEVERE › HIGH_CRITICAL › CRITICAL › RISK › EARLY_RISK › WARNING (green). ACTIVE (0–4h) never appears in Ticket queues.
- *"Acting as Zonal Manager for [Zone]"* banner displays across the top of every page when a Central Service Manager is acting in a Zonal Manager's scope (Decision §15). All API calls in that session carry `acted_as_role = CENTRAL_SERVICE_MANAGER`.
- *WhatsApp Confirmation* is displayed as "sent" (not "attempted") — it is a first-class delivery channel for SE Acceptance events, not a push-notification fallback.
- *SLA pause indicator* is shown for two documented pause reasons — `WAITING_COMPONENT` and `VEHICLE_UNAVAILABLE` (the latter requires a filed **Vehicle Unavailability Report**, never raw readiness). Raw readiness (`ON_TRIP`, `STALE`, `UNKNOWN`) alone must not show a pause indicator. The **Secondary SLA Clock** (true elapsed, never pauses) is rendered only for Zonal Manager, Central Service Manager, and Operations Head — never for the SE.
- *Fleet Uptime denominator* shown in reports is always Eligible Devices only (active PGI within ~15 days AND not Non-Operational), never raw installed-device count.

**Full page inventory and per-workflow UI flows:** see `docs/PRD-fsm-admin-dashboard.md` §Page Inventory and §Page Flows.

---

## Analytics, Reporting & Data Lifecycle

These concepts are served from **summary tables / materialized views**, not raw telemetry or multi-year row scans (see *Data Layers* below).

**ZM Performance Scorecard**:
A scorecard that measures the **quality and impact of a Zonal Manager's decisions** on SE assignments, SLA outcomes, and zone operations. **Visible to the Operations Head / Operations Manager only — it is NOT a ZM planning view shown to the ZM, and is not a self-score page.** Calculated entirely from assignment history, audit logs, ticket events, SLA outcomes, and override records — the ZM never manually enters scores. Metrics include: system-generated assignments reviewed, ZM overrides, override rate, override-after-ON_SITE count, reassignment count, split-batch count, deferred ticket count, manual assignment count, average time from system assignment to ZM intervention, SLA impact of overrides, tickets improved vs delayed after intervention, SE overload events caused/reduced, long-pending-ticket reduction after planning, component-blocked tickets escalated/resolved, vehicle-unavailable tickets followed up/resolved, repeat-failure and recovery-no-progress escalations handled, zone SLA compliance under that ZM, SE utilization balance, and manual-intervention rate vs auto-assignment success. Displayed on the Operations Head / Operations Manager dashboard with ZM-wise comparison, zone-wise drill-down, and weekly/monthly trend. **Not shown on SE mobile.**
_Avoid_: showing the scorecard to the ZM as a planning tool; letting a ZM enter their own scores.

**Device Downtime History**:
The lifetime record of every inactivity episode for a single Device, shown on the **Device Detail** page. Every device that enters the FSM system has a lifetime downtime history. Each Failure Cycle row shows: downtime start/end timestamps, total downtime duration, SLA bucket reached, assigned SE, Plant, Company, root cause, component used, vehicle-unavailable impact, component-blocked impact, verification outcome, closure type, auto-recovery flag, and repeat-failure flag. **Recent detailed history** is read from hot operational records (`failure_cycles`, `tickets`, `ticket_events`, `troubleshooting_submissions`, `verification_runs`); the **lifetime trend** is read from summary tables / materialized views — never a multi-year raw scan.

**Device Lifetime Downtime Trend**:
Trend views on Device Detail derived from monthly summaries: downtime cycles over lifetime, downtime hours by month, repeat-failure trend, average time to recover, longest downtime episode, auto-recovery vs SE-repaired split, component-related downtime trend, and root-cause trend.

**Root Cause Analytics**:
The percentage distribution of device-inactivity root causes (e.g., `POWER_ISSUE`, `SIM_NETWORK_ISSUE`, `GPS_ANTENNA_ISSUE`, `WIRING_ISSUE`, `DEVICE_HARDWARE_FAULT`, `UNKNOWN`), filterable by Fleet, Zone, Company, Plant, device type, SE, and time period. Served from a root-cause summary aggregate, not free-text scans. It depends on the **Troubleshooting Form capturing structured root cause data** — not relying only on free-text `diagnosis_notes`.

**Root Cause Category**:
The structured `root_cause_category` enum captured on each Troubleshooting Form submission. Canonical set: `POWER_ISSUE | SIM_NETWORK_ISSUE | GPS_ANTENNA_ISSUE | DEVICE_HARDWARE_FAULT | WIRING_ISSUE | CONFIGURATION_ISSUE | VEHICLE_ACCESS_ISSUE | INSTALLATION_ISSUE | CUSTOMER_SIDE_ISSUE | UNKNOWN`. The form also captures `root_cause_subcategory`, `root_cause_notes`, `action_taken_category`, `action_taken_notes`, `component_used`, `component_unavailable`, and `photo_refs`.
_Avoid_: relying only on free-text `diagnosis_notes` for root-cause analytics.

**System Efficiency Report**:
End-to-end operational-performance reporting that measures whether the FSM system improves operations and reduces downtime. Metrics: total inactive devices detected, Failure Cycles created, tickets auto-created, auto-assignment success rate, manual assignment rate, ZM override rate, detection-to-ticket time, ticket-to-assignment time, assignment-to-ON_SITE time, ON_SITE-to-submission time, submission-to-verification time, total downtime hours, average downtime per device, SLA compliance %, primary-SLA pause count, secondary-SLA aging count, component-blocked aging, vehicle-unavailable aging, repeat-failure rate, first-time-fix rate, failed-verification rate, auto-recovery rate, warehouse component fulfilment time, and recovery-ticket closure time. Filterable by Fleet, Zone, Company, Plant, device type, SE, and time period. Served from summary tables for long time ranges.

**Data Layers** (operational vs historical vs cold archive):
The system carries ~40,000 devices and ~15,000 downtime/inactive events per month, so the design uses three layers to keep operational APIs fast while supporting long-term analytics:
- **Layer 1 — Hot operational tables:** current active state and active work (`device_states`, `vehicle_readiness_state`, open tickets, active `failure_cycles`, current `work_schedules`, active `component_requests`, pending `verification_runs`). Powers the live dashboard, SE mobile, Recommender, and current operations.
- **Layer 2 — Historical business records:** audit/analytics history (`failure_cycles`, `tickets`, `ticket_events`, `troubleshooting_submissions`, `verification_runs`, `vehicle_unavailability_reports`, `component_requests`, `inventory_transactions`, `audit_logs`). High-volume append-only tables use monthly partitioning and indexes on common filters (`device_id`, `month`, `zone_id`, `company_id`, `plant_id`, `se_id`, `root_cause_category`).
- **Layer 3 — Cold archive:** old raw telemetry and detailed event/audit logs are archived to compressed cold storage (S3 / Parquet / archive DB); summaries stay in PostgreSQL for fast reports.

**Retention policy:** `raw_device_snapshots` — 3 months hot then archive; `audit_logs` — 12–24 months hot then archive; `ticket_events` — 12–24 months hot then archive; closed `tickets` / closed `failure_cycles` — 24 months hot then archive details; monthly/daily summary tables — kept permanently in PostgreSQL.

**Analytics summary tables / materialized views:** `device_downtime_summary_monthly`, `root_cause_summary_monthly`, `system_efficiency_summary_daily`, `zm_performance_summary_monthly`, `se_troubleshooting_summary_monthly`. Rule: **dashboards and scorecards must never scan raw telemetry or multi-year `ticket_events` on every request** — nightly/monthly workers aggregate history into these tables, and reports/scorecards read the summaries.
_Avoid_: serving Device lifetime trend, Root Cause %, System Efficiency, or the ZM Performance Scorecard from raw multi-year scans on every request.

---

## Relationships

- A **Vehicle** carries 1+ **Devices**; each Device has one active mapping at a time.
- A **Device** opens at most one active **Failure Cycle**; closing it requires verified GPS recovery.
- A **Failure Cycle** spawns exactly one open **Troubleshoot Ticket**.
- An **Install Ticket** has no Failure Cycle parent; on `ACTIVATED` it creates the Device's first active mapping to a Vehicle.
- The **Recommender** produces **Recommendations** that bind one Ticket (either work_type) to one SE.
- The **Recommender** auto-dispatches Recommendations into a **Day Plan** of **Formal Assignments**; the **Zonal Manager** monitors and overrides post-hoc (no approval gate).
- A **Dedicated SE** has 1 **Plant** in coverage; **Multi-Plant SE** has 3–4 Plants; **Floating SE** covers 1+ **Regions/Districts**.
- A **Plant** belongs to one **Zone**; a **Zone** is owned by one **Zonal Manager**.
- An SE↔Ticket candidate must pass **Hard Filters** → wins on **SLA Bucket** tier → then on **Priority Score + Plant Cluster Multiplier** within the tier.
- Both **work_type** values share one SE **Daily Capacity** pool; SLA tier lets a CRITICAL Troubleshoot pre-empt a routine Install in the same Day Plan.

## Example dialogue

> **Engineering:** "An inactive device shows up at Plant P in Region R. Plant P's Dedicated SE is on leave today. Who does the Recommender suggest?"
>
> **Operations:** "Strict precedence — Dedicated first, but they're `ON_LEAVE`, so the fallback kicks in. If a Multi-Plant SE also covers P, suggest them. Otherwise it goes to a Floating SE whose Territory includes Plant P."
>
> **Engineering:** "Same Plant P, same SE on leave, but the device entered CRITICAL bucket at 14:00 — mid-shift. Does it wait for tomorrow's Morning Batch?"
>
> **Operations:** "No — a new CRITICAL Ticket is a **Qualifying Event**, so an Intra-day Re-plan fires. The system sends an in-app notification to the nearest AVAILABLE SE asking them to **Accept**. If they don't accept within 10 minutes (Acceptance Timeout), it auto-reroutes to the next-best SE. On acceptance a **WhatsApp Confirmation** is sent. The Zonal Manager sees the assignment as it's accepted and can still override."
>
> **Engineering:** "What if the SE is already at Daily Capacity?"
>
> **Operations:** "That's a **Hard Filter** — the candidate is dropped before scoring. Either another eligible SE picks it up, or it rolls to tomorrow's Morning Batch."

---

# Decisions & Rationale

Architectural decisions resolved during the PRD grill, ordered by when they were made. Each entry is the decision, the reasoning vs alternatives, and the downstream consequences.

## 1. SE-to-device routing uses strict precedence with capacity fallback

**Decision.** When a Device goes inactive, the Recommender offers it to the **Dedicated SE** first, then to any **Multi-Plant SE** covering that Plant, then to a **Floating SE** whose Territory includes the Plant. A Floating SE is engaged early only when the primary is `ON_LEAVE`, `OFF_SHIFT`, at daily capacity, or the Plant has no plant-mapped SE at all. The Zonal Manager can override the precedence per Ticket at approval time.

**Why this and not the alternative.** Rejected an open-pool model (every eligible SE is a candidate each cycle) because at 50k devices / 40 SEs / pan-India, predictable routing matters more than locally-optimal routing. Dedicated SEs build plant relationships that speed diagnosis; Floating SE travel time is expensive and should be spent on real gaps; SEs need a stable plan they can build a week around. The open pool would also make plant-clustering — the largest efficiency lever — fight against itself.

**Consequences.** The Recommender must know each SE's coverage type (`DEDICATED | MULTI_PLANT | FLOATING`). A new `ENGINEER_TERRITORY_COVERAGE` construct is required for Floating SEs (see §6 below). "Primary SE unavailable" is defined precisely via the SE_AVAILABILITY model (§10).

---

## 2. Recommender cadence is hybrid: flexible batch plan + event re-plan

**Decision.** The Recommender runs in two modes. A **Morning Batch** produces **Plant-wise Batch Assignments** per SE at a **flexible Schedule Cadence** — daily, alternate day, 2–3 times per week, or weekly — and **dispatches them directly to the SE Day Plan** as Formal Assignments; the Zonal Manager monitors and can override at a time that suits their operational rhythm. There is **no pre-approval gate** on normal system-generated batches. The system may send a configurable reminder notification (e.g., 08:00 IST) when a new batch has been dispatched, but this is advisory-only — it is not a workflow gate, and the SE can act on assigned Tickets immediately. An **Intra-day Re-plan** fires only on Qualifying Events (a new Ticket entering CRITICAL or HIGH_CRITICAL bucket, an SE completing their Day Plan with capacity remaining, an SE going offline or shift-cut, or a Zonal Manager manual same-day schedule update). Unassigned Tickets roll into the next batch run whenever that is.

**Why this and not the alternative.** Rejected a fixed daily 08:00 cycle because the ground reality is that Zonal Heads update work lists alternate day, weekly, or 2–3 times a week via Excel/WhatsApp — digitising the workflow means encoding *that* natural cadence, not imposing a rigid daily gate. Rejected a periodic cron (every 15–60 min) because constant re-shuffling destroys plant-clustering and gives SEs a moving target. Rejected a pure event-driven system because the batch gives the ZM deliberate control over work distribution. Kept the intra-day path because CRITICAL devices appearing mid-shift cannot wait for the next scheduled batch — that is exactly when SLA-deficit emergencies happen.

**Consequences.** "Today's Plan / Work Schedule" is a first-class entity in the mobile home screen, not a derived view. The SE can act on assigned Tickets as soon as the batch is dispatched — there is no "pending-but-visible" pre-approval lock and no Approve gate for normal batch work; ZM control is exercised through post-hoc override. The Recommender needs an explicit list of Qualifying Events. A new CRITICAL Ticket at 23:50 rolls into the next batch run rather than firing a 23:51 re-plan to an off-shift SE. The system must support multi-day batch windows (an alternate-day batch may cover two or three days of tickets for one SE).

---

## 3. Scoring uses a Company-Tier-first, Device-Bucket-second tier structure with weighted score within each cell

**Decision.** The Recommender ranks candidate `(SE, Device)` pairs in four layers. First, **Hard Filters** drop ineligible candidates (vehicle readiness `ON_TRIP`; required component unavailable; SE over daily capacity; SE not `AVAILABLE`; SE missing Common Kit per Decisions §12). `STALE`/`UNKNOWN` readiness is a ZM readiness-conflict signal, not a hard drop. **SE activity-ping staleness is *not* a Hard Filter** — `last_activity_at` is visibility/audit only and never removes a candidate (Decisions §16, §SE Activity Ping). Second, **Company Tier is the top-level gate** — every Ticket for a Platinum company is processed before any Gold customer's Ticket, which precedes any Silver's. Third, **Device Bucket is the secondary tier inside each Company Tier** — within Platinum, CRITICAL+ Tickets come before lower buckets; same inside Gold; same inside Silver. Fourth, **within each (Company Tier × Device Bucket) cell**, a weighted score combines `company_priority_rank` (A/B/C…), vehicle dispatch urgency, repeat-failure penalty, and (for Floating SE) distance-from-previous-stop. **Plant clustering** is applied as a multiplier on top — once an SE has Plant P in their plan, every additional Plant P Ticket gets a cluster boost.

**Why this and not the alternative.** Rejected pure-device-bucket-first because the operations team's premium-service contracts make customer tier the dominant business reality — a Platinum company's expectation is fundamentally different from a Silver's. Rejected pure-customer-tier-first (no device-bucket tier inside) because it would let a Platinum WARNING device starve a Platinum CRITICAL device — within a customer's portfolio, the device most urgently needed for *that customer's* uptime should still come first. The two-level gate captures both forces: customer tier across customers, device urgency within a customer.

**Consequences.** The Recommender persists a per-candidate score breakdown (Company Tier, Device Bucket, weighted components, applied multipliers) so the manager UI can answer "why was this suggested?" The Company Tier gate can starve all Silver-customer work behind Platinum/Gold backlogs — visible on the manager dashboard as "X Silver-tier Tickets skipped today by Company Tier gate". This makes the trade-off honest rather than hidden, and triggers Operations Head review when the starve depth crosses a threshold. Weights inside each cell are configurable by Admin via Settings; each Morning Batch run captures the active weight set in audit. Candidates must be processed in the canonical order from Decisions §17 for reproducible plans.

---

## 4. Installs and Troubleshoots share one Ticket entity, distinguished by `work_type`

**Decision.** Both new-device installations and inactive-device troubleshooting are the same `Ticket` entity carrying a `work_type` discriminator (`INSTALL | TROUBLESHOOT`). The Recommender, Day Plan, Zonal Manager approval flow, SE mobile UX, soft states, audit log, and SE capacity pool are all **shared**. Lifecycle states and verification rules are **sub-type specific**: a Troubleshoot Ticket runs `OPEN → SUBMITTED → VERIFICATION_PENDING → CLOSED`; an Install Ticket runs `REQUESTED → SCHEDULED → ON_SITE → FITTED → ACTIVATED → CLOSED`. Sub-type fields live in `INSTALL_DETAILS` / `TROUBLESHOOT_DETAILS` 1:1 child tables.

**Why this and not the alternative.** Rejected separate `Installation` and `Ticket` entities because 40 SEs is too small a workforce to split — a hard "10 installs / 30 repairs" allocation breaks the day an install backlog spikes or a critical-device wave hits. With one pool, the SLA tier gate naturally lets a CRITICAL inactive Device pre-empt routine installs, and quiet days let the same SEs clear install backlog. Rejected one-entity-no-sub-type because reports, verification, and warranty semantics genuinely differ — erasing the distinction loses governance value.

**Consequences.** Auto-verification branches on `work_type`: install verification needs the **first** valid GPS ping post-fitment; troubleshoot verification needs **recovery** pings after a known Failure Cycle. Warranty start = `Ticket.activated_at` for installs. Reports must always group/filter by `work_type`. A Troubleshoot cannot transition into an Install — sub-type is immutable.

---

## 5. Fleet Uptime is monthly time-weighted with eligibility gating; Soft Inactive Count drives the Recommender

**Decision.** **Fleet Uptime %** (the contractual master KPI) is the **time-weighted fraction of the month a Device was online**, calculated only over **Eligible Devices**. A Device is eligible for the month if it had an active order / PGI within the last ~15 days *and* is not currently marked **Non-Operational**. Denominator = `eligible_device_count`, not raw installed count. Target ≥98%. Window = 1 calendar month. Reported per fleet / zone / company / plant.

A monthly metric is too lagging to drive intraday operations, so the Recommender keys its **deficit-mode vs preventive-mode switch** off a parallel **Soft Inactive Count** — the count of Eligible Devices currently silent for more than the canonical inactivity threshold (24h). Soft Inactive Count is recomputed **twice daily** (morning before the batch; afternoon before the next re-plan window). Same eligibility filter as Fleet Uptime % so both metrics agree on what counts.

**Why this and not the alternative.** Rejected instant-snapshot uptime because company SLA is contractual and must be derivable from time-series data, not "the moment we looked". Rejected finer-grained signals (4h/8h) for the recommender because operations treats 24h as the canonical inactivity threshold everywhere else — one inactivity definition keeps mental models aligned and dashboards consistent.

**Consequences.** A new `DEVICE_ELIGIBILITY` view tracks `eligible_for_uptime` per Device per day, derived from `PGI_HISTORY` and `NON_OPERATIONAL_MARKING`. A `NON_OPERATIONAL_MARKING` table records who excluded which Device, when, why; entries have effective windows. Monthly uptime is a batch job. Recommender threshold for switching to deficit mode is configurable (default `> 2% × eligible_device_count`). Reports show both numbers side by side so management sees operational deficit (Soft) and contractual SLA (monthly) as related but distinct stories.

---

## 6. Floating SE coverage combines hierarchical geography with polygon overlay

**Decision.** A Floating SE's **Territory** is described by two complementary mechanisms, either or both populated per SE. **Hierarchical coverage** is a set of State / Region / District identifiers — readable, admin-friendly, the way operations actually describes an SE's patch. **Polygon coverage** is a lat-long polygon (or set of polygons) on top, used when hierarchical units are too coarse (metro Mumbai but not rural Maharashtra). Membership is the **union**: a Plant is in an SE's Territory if it falls inside any covered District *or* any covered polygon.

**Why this and not the alternative.** Rejected pure district lists (too verbose for pan-India; ~700 districts means admin nightmare). Rejected pure polygons (too engineering-heavy; no clean reporting boundary). Rejected pure hierarchy (cannot express sub-district splits that real Floating-SE patches have). Hybrid gives reporting and admin a humane front-end; the polygon gives precision where needed.

**Consequences.** The backend stack must support geospatial primitives — **PostGIS** (or equivalent) is now a hard dependency for `ST_Contains` / `ST_Within` lookups. A precomputed materialised view `plant_eligible_floating_se(plant_id, engineer_id)` refreshed nightly and on coverage edits keeps the hot path an index lookup. `Plant.location` must carry both `district_id` and `lat/lon`. Admin UX should let the user start hierarchical (tick districts) and then optionally draw a polygon. Two Floating SEs whose Territories overlap tie-break in the Recommender by (a) capacity, (b) distance-from-previous-stop, (c) hierarchy_match preferred over polygon_match.

---

## 7. Plant-wise Batch Assignment is auto-dispatched (no approval gate); the Zonal Manager overrides post-hoc; intra-day urgent dispatches require SE Acceptance (see Decisions §16)

**Decision.** System-generated **Plant-wise Batch Assignments** are **dispatched directly to the SE Day Plan** as Formal Assignments — there is **no Zonal Manager approval gate** for normal system-generated assignment. The Zonal Manager (or acting role per Decisions §15) sees the dispatched assignments and can **override post-hoc** at a **Schedule Cadence** that suits operational need (daily, alternate day, 2–3 times per week, or weekly): swap SE, split batch across SEs, remove specific Tickets, defer Tickets, reorder work, or reassign — before or after the SE has started. Batch status is **`AUTO_ASSIGNED`** on dispatch and **`OVERRIDDEN`** after any ZM change; there is no `PENDING_REVIEW` gate and no "approve before actionable" step. The SE can act on assigned Tickets the moment they appear — there is no pre-approval pending-but-visible lock on normal batch work.

**Intra-day urgent dispatches** (system-triggered CRITICAL/HIGH_CRITICAL insertions or ZM manual same-day urgent assignments) follow the separate SE-acceptance flow detailed in Decisions §16 — those require explicit SE confirmation because they land on an SE who is already mid-route.

**Why this and not the alternative.** An earlier design imposed a strict daily 08:00 IST approval gate with a "pending-but-visible" state; a later revision relaxed it to a flexible-cadence per-SE one-click Approve. This revision removes the approval gate entirely for normal system-generated batches: at ~40 SEs / pan-India, requiring the ZM to approve every batch before the SE can act is manual overhead with no operational justification — the Recommender's plant-clustered output is good enough to action directly, and the ZM's real lever is correcting the occasional bad assignment, which post-hoc override already provides. Rejected keeping the Approve gate (slows every SE's day waiting on a manager, and contradicts how Zonal Heads actually manage field work). Rejected an optional per-SE "review-first hold" (extra state and UI for a case the override path already covers). The Manager Revert Window concept remains **removed** — manager override happens through the normal override UI at any time, with the dashboard surfacing conflict warnings when an SE holds an ON_SITE Soft State on a Ticket being overridden. Urgent intra-day insertions are the exception — they land on an SE mid-route and still require explicit SE Acceptance (Decisions §16).

**Consequences.** No `PENDING_REVIEW` / `pending-but-visible` state exists for normal batch assignments — the concepts are removed. Batch status is `AUTO_ASSIGNED → OVERRIDDEN`. The 08:00 IST gate, the one-click Approve action, and any auto-approve trigger are all removed from the batch flow. A configurable **Schedule Cadence reminder** notification may still fire to prompt the ZM to *review* the dispatched batch, but it is advisory only — it locks nothing and the SE's Day Plan already reflects the live assignments. The `RECOMMENDATION_HISTORY` immutable rows track `Recommendation → AutoAssigned → (Overridden?) → OnSite → Closed` for the batch path, and `Recommendation → SEAccepted (or retried) → OnSite → Closed` for the intra-day CRITICAL path. Override of an in-progress batch (SE already ON_SITE on a Ticket in the batch) surfaces a dashboard conflict warning requiring explicit confirmation, with the override audited and reason-coded. The ZM dashboard shows a "recently dispatched / unreviewed" indicator — informational only; it does not gate SE actions.

---

## 8. Failure-cycle resubmit after component wait: state, cardinality, and ownership

**Decision.** When an SE submits a Troubleshoot form with `component_unavailable=true`, the Ticket enters Failure Cycle state **`WAITING_COMPONENT`** and a Component Request is opened. The PRD's prior "one cycle → one ticket → one form" rule is replaced with **"one cycle → one ticket → 1+ submissions"** — each submission carries its own `client_submission_id`; inventory transactions are tracked per submission and finalise together on auto-verification. A `WAITING_COMPONENT` cycle exceeding **7 days** auto-escalates to the Zonal Manager (close-deferred / extend / escalate further).

When the spare arrives, resubmit ownership depends on SE type and delivery destination:
- **Dedicated SE / Multi-Plant SE** — soft ownership; original SE re-suggested first; pool fallback only if unavailable.
- **Floating SE** — geography-dependent. Spare delivered to **SE's current location** → original SE re-suggested. Spare delivered to **Plant warehouse** → Ticket returns to open Recommendation pool.
- **All cases require Zonal Manager confirmation** before the resubmit binding is committed.

**Why this and not the alternative.** A uniform "return to pool" rule wastes plant-mapped SEs' diagnosis context (they'll be back at the plant anyway). "Always re-route to original SE" is wrong for Floating SEs — they may have moved hundreds of km in 3 days. Anchoring Floating-SE re-routing to spare delivery destination matches operational reality: the spare's location is the gravitational centre for the second visit.

**Consequences.** `FAILURE_CYCLE` state machine gains `WAITING_COMPONENT`. `TROUBLESHOOTING_FORM_SUBMISSION` becomes a 1-to-many child of `TICKET`. `INVENTORY_TRANSACTION` rows are tagged with `submission_id`. `COMPONENT_REQUEST` gains `delivery_destination = SE_LOCATION | PLANT_WAREHOUSE`. SLA paused at `WAITING_COMPONENT` entry; resumed at manager-confirmation, not at delivery.

---

## 9. Auto-GPS verification is three-phase; ±500m applies only to the first post-submission ping

**Decision.** Auto-verification runs in three phases. **Phase 1 (Recovery Confirmation, 15–30 min after form submission)** requires ≥3 valid pings, span ≥15 min, no gap >30 min; the **first** valid ping must fall within ±500m of the SE's **form-submission GPS** (or the ON_SITE geofence-capture location when present) *or* inside the Plant geofence. When `presence_source = NONE` (no SE location captured), the Phase-1 geo-check is **skipped** — the ping-count/span criteria still apply, but no fraud flag is raised for lack of an anchor. **Phase 2 (Stability, 1h after Phase 1's first ping)** requires the device to keep pinging with no gap >30 min — **movement is welcome and expected**. **Phase 3** transitions the Ticket to `CLOSED` once Phase 2 passes; no further geographic constraint is applied. For device replacements, verification follows the **new** `device_id`'s pings.

**Why this and not the alternative.** Replaced the PRD's blanket "every ping within ±500m" rule because it produced false `FAILED_VERIFICATION` whenever a vehicle moved after the 1h stability wait — which is exactly what a freshly-repaired GPS-equipped vehicle does. The original rule conflated proof-of-repair (device works) with proof-of-co-location (device is where it was last seen). The Phase-1-only rule keeps the useful part (free fraud-detection at the moment of submission) and drops the part that breaks the moment a vehicle leaves.

**Consequences.** Coverage gaps >30 min during Phase 2 do **not** flip to FAILED — they leave the Ticket in `VERIFICATION_PENDING` and continue monitoring. Only the 24h overall escalation flips state. The auto-verification service persists `se_gps_lat/lon` from `TROUBLESHOOTING_FORM_SUBMISSION` for the Phase-1 check. A device pinging from a wildly-wrong Phase-1 location (e.g., 100km off) raises a fraud-investigation flag visible to the Zonal Manager. Reports distinguish "FAILED_VERIFICATION (no pings)" from "FAILED_VERIFICATION (fraud flag)".

---

## 10. SE availability is one time-windowed table; Zonal Manager and SE are the only setters

**Decision.** SE availability is modelled as a single `SE_AVAILABILITY` table of time-windowed rows: `(engineer_id, from_ts, to_ts, status, reason_code, set_by, set_by_role, notes, created_at, updated_at)`. The `status` enum is `AVAILABLE | ON_LEAVE | OFF_SHIFT | WEEKLY_OFF | SOFT_UNAVAILABLE | OFFLINE`. The Recommender's Hard Filter checks "is SE-X `AVAILABLE` at planning timestamp" via a single index intersection.

Authority is restricted to **Zonal Manager** (sets/approves availability for SEs in their zone — planned leave, shift exceptions, weekly-off, phone-in-sick) and the **SE** themselves (request leave, post real-time soft-unavailable flags from mobile). **Admin has no role in availability tracking.**

**Why this and not the alternative.** Rejected separate per-dimension tables (multiple joins for the Recommender's per-tick query). Rejected materialised-view-over-source-tables (refresh complexity not worth it at this scale). Rejected tiered Admin/Manager/SE authority because at 40 SEs across 4 zones (~10/zone), the Zonal Manager *is* the operational owner of their SEs' schedules. Admin owns *system configuration* (zones, plants, mappings, rules), not *operational state* — conflating obscures accountability.

**Consequences.** `SE_AVAILABILITY` enforces non-overlap per `engineer_id` per status family. The mobile app's "I'm unavailable for 2h" action writes a `SOFT_UNAVAILABLE` row, auto-resolves at `to_ts`. Heartbeat-derived `OFFLINE` rows are short-lived and tagged so they don't show as "leave" in reports. A Zonal Manager cannot set availability for an SE outside their zone — cross-zone changes route through Operations Head. Reason codes are enumerated: `SICK | VACATION | HOLIDAY | DOCTOR | TRAINING | PERSONAL | NETWORK_OUT | OTHER`.

---

## 11. Install Tickets are created by Zonal Manager / Central Service Manager / Operations Head (scoped) in v1; External Order Webhook deferred to v2

**Decision.** For v1, an `Install Ticket` is created **manually by one of three roles, scoped to their authority** — **Zonal Manager** (own zone), **Central Service Manager** (within authority scope), or **Operations Head** (all zones) — through the FSM web UI (single create) or **CSV bulk upload**, each scoped to the creator's zone authority. No auto-creation from SAP PGI events. Every Install Ticket records `install_trigger_source = MANUAL_OPERATIONS` (the channel) plus `created_by` and `created_by_role` (the actor), and a full audit entry. In v2 (roadmap), an **External Order Webhook** from another application will be added, with `install_trigger_source = EXTERNAL_API` distinguishing the path. Auto-PGI-driven install creation remains explicitly **out of scope** — PGI is the eligibility signal for Fleet Uptime, not an install trigger.

**Why this and not the alternative.** The earlier v1 design made Operations Head the sole creator for single-point accountability over the install backlog. Operationally that bottlenecks install creation: a Zonal Manager who knows a Plant needs a new fitment had to route every request through Operations Head. Distributing creation to ZM (own zone), CSM (scope), and Operations Head (all zones) — with mandatory `created_by_role` and audit on every Ticket — keeps accountability traceable without the bottleneck. Rejected keeping Ops-Head-only (a bottleneck with no governance benefit now that every creation is attributed and audited). Rejected auto-PGI-primary because the auto-PGI integration confidence is not yet high enough to gate creation of customer-billable install work — a misfire would create phantom Install Tickets that consume SE Day Plan capacity. Rejected external webhook as v1's primary path because the upstream integration owner isn't ready.

**Consequences.** `Ticket` carries `install_trigger_source` (enum: `MANUAL_OPERATIONS` for v1; `EXTERNAL_API` reserved for v2) plus `created_by` (user id) and `created_by_role` (`ZONAL_MANAGER | CENTRAL_SERVICE_MANAGER | OPERATIONS_HEAD`). Creation is **scope-enforced**: a Zonal Manager can only create for Plants in their own zone; CSM within their authority scope; Operations Head across all zones. The single-create UI and the CSV bulk upload are both available to all three roles within scope. The CSV upload schema must validate Vehicle existence, absence of an active Device mapping, Plant existence, company-account context, **and that every row's Plant is inside the creator's zone authority** before creating any Tickets — bad rows reject with line-number errors, not partial-import. Reports break out Install volumes by trigger source and by `created_by_role` so the v2 webhook rollout has a clean before/after comparison. Demo/replacement/pre-order/retro-fit cases are all served by the same MANUAL_OPERATIONS path; sub-typing within the trigger source is unnecessary at this scale.

---

## 12. Component availability is a layered Hard Filter: Common Kit (always) + Expected Component (when known)

**Decision.** A Ticket passes the component Hard Filter only if **both** conditions hold. **(i) Common Kit:** the SE must carry the full configurable baseline kit (cables, SIM, antenna, fuse — Admin-defined list). A missing kit item grounds the SE for Recommender purposes — no Tickets are assignable to them until restock. **(ii) Expected Component:** when a Ticket has one or more known `expected_component` rows (from repeat failure, prior partial diagnosis, Install setup, or WAITING_COMPONENT resubmit), every expected component must be available in the SE's **van stock** or in the SE's home **Zone Warehouse** (pickable as a morning detour). First-time Troubleshoot Tickets with no signal carry no expected component and so this leg is a no-op.

Tickets failing either leg do **not disappear** — they enter a **Component-Blocked Queue** on the Zonal Manager dashboard, with the missing part(s) and the Warehouse Manager action visibly tracked. This makes the filter operational rather than silent.

**Why this and not the alternative.** Rejected a no-filter status quo because at 40 SEs / pan-India, a wasted plant visit is a real cost the system can prevent for the cases where prediction is reliable. Rejected pure `expected_component`-only because it underestimates the cost of an SE arriving with a depleted van — even with the right specialty part, a missing fuse or SIM blocks the day. Rejected pure common-kit-only because it ignores the obvious predictive signals from repeat-failure history and prior diagnosis. The layered model captures both the *baseline-readiness* invariant and the *per-ticket-need* signal without conflating them.

**Consequences.** A new `COMMON_KIT_DEFINITION` table (Admin) lists the kit items; a new `SE_VAN_STOCK` table tracks per-SE current quantities. `Ticket.expected_component` becomes a multi-row child table populated by the named triggers. The Recommender's morning batch can plan a Zone Warehouse pickup as the SE's first stop if an expected component is in the warehouse but not the van; the pickup is a regular Day Plan entry. A "van missing kit item" condition raises a notification to both the SE and the Warehouse Manager — Common Kit completeness is shared accountability. The Component-Blocked Queue on the manager dashboard shows the OOS component-to-ticket mapping so warehouse purchasing has direct visibility into what's costing field productivity.

---

## 13. Rejected-on-409 SE's physical component use is auto-recorded as Shadow Use

**Decision.** When two SEs both physically work the same Ticket and the second submission is rejected with 409 Conflict, the server inspects the rejected `TROUBLESHOOTING_FORM_SUBMISSION.component_used` rows and writes a parallel `INVENTORY_TRANSACTION` for each component with `status = SHADOW_USE`, `rejection_reason = DUPLICATE_SUBMISSION`, linked to the original Ticket and the rejected `submission_id`. The components **are** decremented from `SE_VAN_STOCK` — they're physically gone, and pretending otherwise corrupts the next day's Common Kit Hard Filter (Decisions §12). The mobile app surfaces the rejection with: *"This Ticket was already closed by [SE name]. Your components have been logged for warehouse reconciliation."* A **Shadow Use Queue** on the Warehouse Manager dashboard collects pending reconciliations; the manager marks each `RECONCILED` (genuine duplicate effort) or `DISPUTED` (mismatch with winning SE's report — escalates to Zonal Manager).

**Why this and not the alternative.** Rejected requiring the SE to file a manual physical-use claim because the friction predicts skipped filings — and a skipped filing returns the original inventory leak with worse audit trail. Rejected soft-locking at ON_SITE because it breaks the shared-pool fallback flexibility the system deliberately keeps (Decisions §1, §3). Rejected accepting the leak because at 40 SEs × pan-India travel cost, untracked component drift compounds quickly and silently breaks Common Kit checks downstream.

**Consequences.** `INVENTORY_TRANSACTION.status` enum gains `SHADOW_USE`; the row carries both the original `ticket_id` and the rejected `submission_id` for forensics. `SE_VAN_STOCK` decrements regardless of submission acceptance. Per-SE shadow-use frequency becomes a surfaced metric — repeat patterns (same SE shadow-claiming weekly) trigger Operations Head review for potential fraud or coordination failure. Disputed rows flow to the Zonal Manager via the same notification channel as readiness conflicts. The 409 conflict response now carries `shadow_use_recorded = true` so the mobile app can confirm the SE's parts won't disappear from accounting.

---

## 14. Non-Operational marking requires dual confirmation; recurring-deal Devices trigger a Recovery Ticket

**Decision.** A Non-Operational marking is a multi-step workflow, not an immediate flag. Whoever initiates (Zonal Manager, Operations Head, or Customer via portal/API) creates the row in state `REQUESTED`. The system then routes for the **other party's confirmation**: Manager-initiated marks await Customer confirmation (email link or portal acknowledgement); Customer-initiated marks await Zonal Manager confirmation. If the other party doesn't respond within 7 days, Operations Head can override-confirm with an explicit audit reason. Only when state reaches `CONFIRMED` does the marking *take effect*:

- New Failure Cycle creation for this Device is **blocked** (hard pause).
- Any **in-flight** Ticket auto-closes as `CLOSED_NON_OPERATIONAL` with a back-reference to the marking row.
- If the Device's **Deal Type is `RECURRING`** (provider-owned asset) **and** the reason ∈ `{VEHICLE_SCRAPPED, VEHICLE_SOLD, COMPANY_PAUSED, DEVICE_REPLACEMENT_PENDING}`, a **Recovery Ticket** (`work_type = RECOVERY`) is auto-created and enters the Recommender like any other Ticket — SE collects the physical device, returns it to the Zone Warehouse, ticket closes.
- The Device is excluded from the Fleet Uptime Eligible denominator (Decisions §5) for the duration of `CONFIRMED/ACTIVE`.

Reason codes are enumerated: `VEHICLE_SCRAPPED | VEHICLE_SOLD | VEHICLE_ACCIDENT | COMPANY_PAUSED | DEVICE_REPLACEMENT_PENDING | COMPLIANCE_HOLD | OTHER` (OTHER requires free-text). Effective window is bounded: default 90 days, with `VEHICLE_SCRAPPED` / `VEHICLE_SOLD` defaulting to 365 days. Setter must renew before expiry or the marking auto-lifts to `EXPIRED` and the Device re-enters eligibility.

**Why this and not the alternative.** Rejected single-party marking (Manager-only or Customer-only) because the Device is provider-owned in recurring deals — a unilateral customer mark would lose the asset; a unilateral manager mark would alienate customers whose vehicles are being silently delisted. Rejected eligibility-only exclusion (with Tickets still flowing) because at 40 SEs across pan-India, an SE driving to "fix" a scrapped vehicle is a real expensive mistake. Rejected manager-confirmed close per in-flight Ticket because once both parties agree the Device is out, there's no value in a third confirmation step.

**Consequences.** `Device.deal_type` is sourced from CRM/SAP contract integration; missing data falls back to Operations Head manual tagging via the Settings page (acceptable v1 gap). `NON_OPERATIONAL_MARKING` carries: `initiated_by_role`, `initiated_at`, `awaiting_role`, `confirmed_by_role`, `confirmed_at`, `effective_from`, `effective_to`, `reason_code`, `notes`, `state`. Customer confirmation is captured via a one-time tokenised email link in v1; a richer customer portal is v2 roadmap. Operations Head override-confirms are flagged in reports so audit can spot patterns of bypassed customer confirmation. `RECOVERY` Tickets are filtered out of Fleet Uptime KPIs but show up in SE workload reports, since they consume Day Plan capacity. The `CLOSED_NON_OPERATIONAL` Ticket close reason is a distinct value (not `CLOSED` or `FAILED_VERIFICATION`) so reports don't conflate marking-related closures with normal repair success.

---

## 18. Cross-zone help is auto-asked only for Platinum companys; Gold/Silver require manual Zonal Manager escalation

**Decision.** When a Ticket can't be assigned within its home Zone (the Recommender has exhausted eligible local SEs through retries and Hard Filters per Decisions §1, §3, §16), the next step depends on the Ticket's `company_tier`:

- **Platinum company** → system **auto-pings the Central Service Manager** with: *"This Platinum Ticket cannot be covered locally in [Zone] — please authorise cross-zone capacity."* The auto-trigger fires when the Ticket has been unassigned for **1 hour** in CRITICAL bucket *or* has not reached `SUBMITTED` within **4 hours** of opening. Central Service Manager approves or denies in their cross-zone dashboard within the same session-style queue used for other CSM duties.
- **Gold and Silver companies** → Ticket sits in a **"Couldn't Assign" queue** on the home Zonal Manager's dashboard. The manager decides whether to escalate to Central Service Manager (one-click action), wait for local capacity, or defer. **No auto-trigger.**

The Zonal Manager can manually flag any Ticket (any tier) for cross-zone escalation at any time before the auto-trigger fires — auto-trigger is a safety net for Platinum, not a usurpation of manager judgment.

**Why this and not the alternative.** Rejected the broader "auto-ask for everyone when local is exhausted" rule because Operations preferred to keep cross-zone capacity as a deliberate decision for non-premium customers — moving an EAST Floating SE into SOUTH zone has a real cost (travel time, mileage, fatigue) that's only worth paying automatically for the highest-value customers. Rejected the strict "no auto-ask, 24h wait" rule because a Platinum CRITICAL sitting unassigned for 24 hours is a contract-level service failure the system shouldn't let happen quietly. Rejected the broad "Zonal Manager flags manually for everyone" rule because Platinum companys' SLA commitments are tight enough that "manager forgot to escalate" cannot be an explanation we give the customer.

**Consequences.** A new `CROSS_ZONE_ESCALATION` table records the trigger (auto vs manual), trigger reason (no local capacity, SLA-window risk, manual override), home Zone, target Zone, requesting role, approving role, decision (approved/denied/deferred), decision timestamp. Reports surface per-Zone "auto-escalations triggered this month" — a Zone hitting many auto-triggers is a capacity-planning signal for Operations Head. The "Couldn't Assign" queue on Zonal Manager dashboards aggregates Gold/Silver stuck Tickets so the manager can decide them in batch rather than one-by-one. A Platinum auto-escalation that the Central Service Manager *denies* falls back into the home Zonal Manager's queue with a denial reason — they can manually re-escalate to Operations Head if they disagree.

---

## 17. Canonical candidate processing order: Company Tier → Device Bucket → Company Priority Rank → Oldest Inactive → Device ID

**Decision.** The Recommender processes candidate `(SE, Device)` pairs in a strict, deterministic order so the same input always produces the same Day Plan and the Plant Cluster Multiplier (Decisions §3) behaves reproducibly. The order is:

1. **Company Tier** descending (`PLATINUM > GOLD > SILVER`).
2. **Device Bucket** descending within the same Company Tier (`LONG_PENDING > VERY_SEVERE > SEVERE > HIGH_CRITICAL > CRITICAL > RISK > EARLY_RISK > WARNING`).
3. **Company Priority Rank** ascending (`A` before `B` before `C` …).
4. **Oldest Inactive** ascending (smaller `latest_gps_datetime` = older = processed first).
5. **Device ID** ascending — final absolute tie-breaker.

The first candidate processed at any given Plant is the *seed* of that Plant's cluster — it carries no cluster boost. Subsequent same-Plant candidates picked up later in the run receive the Plant Cluster Multiplier (Decisions §3) so they're more likely to land in the same SE's Day Plan and produce a one-visit-many-fixes route.

**Why this and not the alternative.** Rejected a Plant-ID-first order because it would group clusters early but ignore the Customer-Tier-then-Device-Bucket precedence from Decisions §3 — a CRITICAL device at Plant Q would lose to a WARNING device at Plant P just because P sorts earlier. Rejected a hash-based random-with-seed order because the cluster effect becomes operationally unexplainable. Rejected dropping Device Bucket from the sort (folding it into the weighted score only) because that would let Platinum WARNINGs starve Platinum CRITICALs inside the same Company Tier — the very risk Decisions §3 just defended against.

**Consequences.** The order is enforced as a stable SQL `ORDER BY` over the candidate set; tests pin the order with a fixture-based assertion so future refactors can't silently break it. `RECOMMENDATION_HISTORY` carries the processing rank of each suggestion so the audit can answer "what position in the queue was this Ticket?" Reports show the breakdown of skipped-by-gate Tickets at each tier level (Company Tier, Device Bucket) so managers see where the queue is being shaped by gates vs by score.

---

## 16. Intra-day CRITICAL insertions require SE Acceptance + WhatsApp Confirmation; offline SEs auto-reroute on Acceptance Timeout

**Decision.** When an Intra-day Re-plan (Decisions §2) selects an SE for a new CRITICAL insertion, the system sends an **in-app notification** asking the SE to **accept** the assignment. The assignment is **not committed** until the SE taps Accept in the mobile app. On acceptance, a **WhatsApp Confirmation** message is sent to the SE with ticket detail and a deeplink — redundant context for when the SE later opens WhatsApp instead of the app. If the SE does not respond within the **Acceptance Timeout** (default 10 minutes), the system auto-reroutes the insertion to the next-best SE per the strict-precedence rule (Decisions §1) and the cycle repeats. After 3 unsuccessful retries (no SE accepts), the insertion escalates to the acting Zonal Manager for explicit assignment.

Offline-SE handling is layered on top:
- **No pre-emptive activity-ping filter.** An SE is never silently excluded from intra-day candidate scoring on the basis of a stale `last_activity_at` — activity pings are visibility/audit only (§SE Activity Ping). An unreachable SE who is offered an insertion simply doesn't tap Accept, so the **Acceptance Timeout (default 10 min) auto-reroutes** to the next-best SE; after 3 retries it escalates to the acting ZM. The timeout *is* the unreachability handler.
- An SE who regains network *after* the insertion was re-routed sees on sync: *"Ticket-XXXXX was offered to you at HH:MM and routed to [SE name] at HH:MM because you didn't respond in time. No action needed."* — avoids "ghost insertion" confusion.

**Why this and not the alternative.** Rejected pure auto-approve + Manager Revert (the previous shape of Decisions §7) because mid-day insertions land on SEs who are already mid-route — making the SE the commit authority respects field reality and prevents wasted dispatches to an SE who's hours away from the inserted Plant. Rejected "hold the Ticket until an online SE is found" because at 50k devices a CRITICAL silent device can't wait an indefinite poll. Rejected "insert + propose to backup concurrently" because it creates duplicate-claim race conditions and fights the strict-precedence model. Acceptance-with-timeout-and-reroute keeps the system responsive *and* respects SE agency.

**Consequences.** `ENGINEER_MASTER.last_activity_at` updated on any SE-initiated app action (not a fixed-interval timer — see ADR-0024, historical). It drives **only** the 1h `OFFLINE` Activity Status display label; it is **not** a Recommender Hard Filter and never removes an SE from intra-day candidate scoring (the prior 15-min freshness filter is removed — unreachability is handled by the Acceptance Timeout + reroute above). `RECOMMENDATION_HISTORY` for intra-day insertions carries the full retry chain — `[ {se: A, offered_at, timed_out}, {se: B, offered_at, accepted_at} ]` — so audit answers "why did this end up where it did?" The WhatsApp integration is now an explicit v1 dependency (was previously optional/fallback). Decline-by-SE is a first-class action distinct from timeout; an SE who declines must record a reason code (`AT_CAPACITY | TRAVEL_TOO_FAR | VEHICLE_TROUBLE | OTHER`) so patterns surface in reports. The Manager Revert Window concept from the prior Decisions §7 is **removed** as obsolete — manager override of an accepted assignment happens through normal override UI before SE departs for the Plant.

---

## 15. Role hierarchy is Operations Head → Central Service Manager → Zonal Manager; backup cascades up the chain

**Decision.** The system models three operational role layers: **Operations Head** at the top (fleet-wide strategic, cross-zone escalations), **Central Service Manager** in the middle (cross-zone operational oversight, routine cross-zone SE-deployment approvals), and **Zonal Manager** at the per-zone day-to-day. There are **no peer deputies** among Zonal Managers; the backup line cascades strictly **up** the hierarchy:

1. **Zonal Manager unavailable** → **Central Service Manager** acts with full Zonal-Manager authority for that Zone.
2. **Both Zonal Manager and Central Service Manager unavailable** → **Operations Head** acts directly.
3. Operations Head is always the last line.

Activation triggers (same for each layer): the role-holder sets their own planned-leave window in a `ROLE_UNAVAILABILITY` table; *or* a higher role marks them unavailable; *or* heartbeat absence >24h auto-activates with notification to the next layer up. While activated, all higher-layer actions in the substituted scope carry `acted_by_engineer_id` plus `acted_as_role` (e.g., `CENTRAL_SERVICE_MANAGER` acting in Zonal Manager scope) so every audit row identifies both the actor and the role they exercised.

**Why this and not the alternative.** Rejected peer-Zonal-Manager deputy models (Operations-Head-designates, self-nominate, round-robin) because the org already has a layer above Zonal Manager — modelling peer cover would invent governance that doesn't exist on the ground and would create cross-zone deputisation politics. Rejected Operations-Head-as-direct-primary-backup because that bypasses Central Service Manager's normal role (cross-zone visibility) and turns the Operations Head into a daily approver — neither tier is set up for that.

**Consequences.** A new `ROLE_UNAVAILABILITY` table (separate from `SE_AVAILABILITY` because the routing semantics differ — *all of this role's queued actions* re-route, not just Recommender candidate scoring). Notifications on activation: down-layer ("you're out") + up-layer ("you're acting in [Scope]"). Reports surface "% of [Zone] approvals this month performed by Central Service Manager" so Operations Head can see when a Zonal Manager is leaning heavily on backup — possible burnout or org gap. Cross-zone escalations from §4.13 now have an explicit recipient: routine cross-zone → Central Service Manager; strategic cross-zone or both-layers-unavailable → Operations Head. The Manager-revert action on auto-approved CRITICAL insertions (Decisions §7) is exercised by whoever is currently acting in the Zonal Manager scope.

---

# Flagged ambiguities

- ~~PRD uses "Zone Head" and "Zone Manager" interchangeably~~ → resolved: canonical term is **Zonal Manager**.
- ~~PRD frames Shared Pool as the primary work view~~ → resolved (revised): **Day Plan / Formal Assignment is primary** in the UI; Shared Pool is **always-visible secondary work scoped to the SE's mapped/covered Plants** (no longer gated on "cleared all work"); SEs never see Tickets outside their coverage except by authorized override (Decisions §1–3, §7).
- ~~Installation is absent from the PRD~~ → resolved: modelled as `Ticket` with `work_type = INSTALL` (Decisions §4).
- ~~Fleet Uptime % is not in the PRD's KPI list~~ → resolved: monthly time-weighted with eligibility gating; Soft Inactive Count drives intraday recommender (Decisions §5).
- ~~PRD's `ENGINEER_PLANT_COVERAGE` only models plant-bound SEs~~ → resolved: new `ENGINEER_TERRITORY_COVERAGE` combines hierarchical and polygon coverage (Decisions §6).
- ~~No SE leave/availability model in PRD~~ → resolved: single `SE_AVAILABILITY` table with Zonal Manager + SE authority (Decisions §10).
- ~~PRD's ±500m verification rule breaks when vehicles move~~ → resolved: three-phase verification, ±500m only Phase 1 (Decisions §9).
- ~~Failure-cycle resubmit after component wait undefined~~ → resolved: `WAITING_COMPONENT` state, 1+ submissions per cycle, ownership rules per SE type (Decisions §8).
- **"Critical / Severe / High"** appear both as **SLA Bucket** names (age-based) and as priority labels (urgency-based). Treat **buckets** as age; **priority** as score. Never mix.
- ~~Install Ticket trigger source undefined~~ → resolved (revised): manual creation by **Zonal Manager (own zone) / Central Service Manager (scope) / Operations Head (all zones)**, single-create or CSV, each scope-enforced; records `created_by` + `created_by_role`; External Order Webhook on the v2 roadmap (Decisions §11).
- ~~Component pre-filter on Day Plan undefined~~ → resolved: layered Hard Filter — Common Kit + Expected Component; blocked Tickets surface on Component-Blocked Queue (Decisions §12).
- ~~First-wins inventory leak when two SEs both physically use parts~~ → resolved: Shadow Use auto-record + Warehouse reconciliation queue (Decisions §13).
- ~~Non-Operational marking workflow undefined~~ → resolved: dual-confirmation lifecycle, hard pause on `CONFIRMED`, Recovery Ticket auto-creation for recurring-deal Devices (Decisions §14).
- ~~Zonal Manager single point of failure / no deputy~~ → resolved: backup cascades up the hierarchy (Operations Head → Central Service Manager → Zonal Manager); no peer deputies (Decisions §15).
- ~~Offline-SE intra-day re-plan delivery undefined~~ → resolved: SE Acceptance flow + WhatsApp Confirmation + retry-then-escalate via **Acceptance Timeout** (Decisions §16, supersedes earlier §7 auto-approve model). *(Revised 2026-06-09: the 15-min `last_activity_at` candidate Hard Filter is removed — activity pings are visibility/audit only and never gate scoring; unreachability is handled by the Acceptance Timeout + reroute.)*
- ~~VERIFICATION_PENDING_COMPONENT undeclared in §4.8 lifecycle~~ → resolved: literal dropped; Failure Cycle's `WAITING_COMPONENT` is the canonical signal (Decisions §8).
- ~~Plant-cluster non-determinism would make plans irreproducible~~ → resolved: canonical sort order Company Tier → Device Bucket → Customer Priority → Oldest → Device ID (Decisions §17). Also re-shaped Decisions §3's top-level gate from Device Bucket to Company Tier.
- ~~Cross-zone escalation trigger conditions undefined~~ → resolved: Platinum auto-escalation (1h unassigned in CRITICAL, or 4h to SUBMITTED) to Central Service Manager; Gold/Silver via manual Zonal Manager flag (Decisions §18).
- ~~Day Plan approval SLA undefined~~ → resolved (revised): **no approval gate at all** — system-generated Plant-wise Batch Assignments **auto-dispatch** directly to the SE Day Plan as Formal Assignments (`AUTO_ASSIGNED`); the ZM monitors and **overrides post-hoc** (`OVERRIDDEN`); no 08:00 IST gate, no Approve action, no `PENDING_REVIEW`/pending-but-visible lock; urgent same-day dispatches still use SE Acceptance (Decisions §2, §7, §16).
- ~~PRD defines "Admin" as a separate persona~~ → resolved: no separate Admin role; Operations Head IS the system configurator (zone/plant setup, SE mappings, SLA rules, priority rules, user accounts).
- ~~PRD §4.8 lists `REVIEW_PENDING` as a ticket state for uncertain-readiness submissions~~ → resolved: **dropped**. No Zonal Manager review gate on uncertain-readiness submissions; presence is established by **multi-signal Presence** (ON_SITE geofence auto-capture / manual ON_SITE / form-submission GPS), not a dedicated SE Confirmation screen (removed) (Decisions §9).
- ~~SLA never pauses for vehicle unavailability~~ → resolved (revised): a documented **Vehicle Unavailability Report** now pauses the primary SLA with `pause_reason = VEHICLE_UNAVAILABLE`; raw readiness still never auto-pauses; a manager-only **Secondary SLA Clock** keeps true elapsed time (glossary §Vehicle availability; supersedes ADR-0020).
- ~~SE Confirmation screen / `trust_score = 0.85`~~ → resolved: **removed**; presence is multi-signal (`presence_source = GEOFENCE_AUTO | MANUAL_ONSITE | FORM_GPS | NONE`); ON_SITE auto-updates from geofenced app actions with manual fallback; `STALE`-without-SE-confirmation Hard Filter dropped (Decisions §9).
- ~~Readiness state `EXPECTED_BACK`~~ → resolved (2026-06-09): **removed** as a main readiness state. Readiness enum is now `AT_PLANT | UPCOMING_TRIP | ON_TRIP | STALE | UNKNOWN | WAITING_CONFIRMATION | AVAILABLE_FOR_REPAIR`. An external **LR Date / Next Trip** signal feeds `UPCOMING_TRIP` (planned trip, colour hint, not a blocker) and, with current system time, `ON_TRIP` (on trip now, blocks normal assignment). `AT_PLANT` is confirmed only by SE field action; LR Date alone never confirms `AT_PLANT` and never pauses SLA. `UNKNOWN`/`STALE` are colour warnings, never assignment blockers and never require SE Confirmation (glossary §Vehicle availability, §Readiness, §LR Date / Next Trip signal).
- ~~SE could reject normal assigned work~~ → resolved (2026-06-09): SE has **no Reject option** for normal assigned Tickets / Plant-wise Batch Assignments / Work Schedules. The only accept/decline gate is **SE Acceptance** on a system-triggered intra-day CRITICAL/HIGH_CRITICAL insertion — kept distinct from rejecting normal work (glossary §Formal Assignment, §SE Acceptance).
- ~~No ZM performance measurement for Operations Head~~ → resolved (2026-06-09): **ZM Performance Scorecard** added for Operations Head / Operations Manager only (not a ZM self-score), computed from assignment history / audit / SLA outcomes / overrides; served from `zm_performance_summary_monthly` (glossary §Analytics, Reporting & Data Lifecycle).
- ~~No per-device lifetime downtime view, root-cause %, or end-to-end efficiency reporting~~ → resolved (2026-06-09): **Device Downtime History / Lifetime Trend**, **Root Cause Analytics** (from structured `root_cause_category` on the Troubleshooting Form), and **System Efficiency Report** added — all served from summary tables / materialized views, never multi-year raw scans (glossary §Analytics, Reporting & Data Lifecycle).
- ~~Long-term data growth would slow operational APIs~~ → resolved (2026-06-09): three **Data Layers** (hot operational / historical business / cold archive) + retention policy + analytics summary tables, with nightly/monthly aggregation workers (glossary §Analytics, Reporting & Data Lifecycle).
- ~~Data source named NG/Drishti~~ → resolved: **AutoPlant DB** is the Snapshot ingestion source everywhere except historical references.
- ~~PRD §4.25 lists ON_SITE / BUSY / SHIFT_ENDING as "SE statuses"~~ → resolved: these are derived **SE Activity Status** display labels, not stored states. Canonical stored model is `SE_AVAILABILITY.status` from CONTEXT.md (Decisions §10).
- ~~PRD §4.5 names final bucket `LONG_PENDING / AGED_CRITICAL`~~ → resolved: **`LONG_PENDING` is canonical**. `AGED_CRITICAL` dropped from codebase and PRD.
- ~~PRD Failure Cycle state machine missing `WAITING_COMPONENT`~~ → resolved: full state machine now in CONTEXT.md; `REPEAT` lives on the **new** cycle, old `VERIFIED` cycle is immutable.
- ~~Repeat-failure 3+ escalation trigger~~ → resolved: repeat detection (repeat_failure=true) is event-driven at Failure Cycle creation; 3+ escalation fires via daily batch job (once/day scan, up to 24h lag). ADR-0021 updated.
- ~~Install CSV-upload schema~~ → resolved: mandatory (vehicle_no, plant_id, company_id, device_type, device_id); optional (sim_id, target_date, notes). ADR-0011 updated.
- ~~Finance voucher access model~~ → resolved: monthly Excel export only in v1; Finance runs own reimbursement process outside FSM; no Finance login or webhook integration in v1.
- ~~Inventory locations~~ → resolved: Mother Warehouse, Zone Warehouse, Van Stock are physical; Ticket Consumption and Faulty Return are accounting categories (transaction types). Added to glossary.
- ~~Component Request lifecycle~~ → resolved: v1 = REQUESTED → APPROVED|REJECTED → SHIPPED → RECEIVED; Phase 2 expands to 6-state courier-tracked model. Added to glossary.
- ~~Company vs Customer hierarchy distinction~~ → resolved: same entity; **Company is canonical everywhere**. "Customer", "Customer Master", "customer_tier", "customer_priority_rank", "CUSTOMER_PAUSED", "CUSTOMER_SPECIFIC" all replaced. CONTEXT.md and ADRs 0003, 0005, 0011, 0014, 0017, 0018 updated.
- ~~Data Quality Error Queue owner~~ → resolved: engineering-owned, handled silently. Not a domain concept; Operations Head never sees it. Not added to CONTEXT.md glossary.
- **Still parked**: Recovery Ticket closure authority (user deferred three times — revisit when recovery workflow is being built).
- **Medium/Low PRD punch-list items still open**: repeat-failure detection cadence (event-driven at cycle creation resolved; escalation trigger parked). *Grilling continues one item at a time.*
