/**
 * @fsm/shared — types shared by the backend and the admin/mobile clients.
 * The auth/session contract lives here so there is exactly one definition of Role and
 * the login/session DTOs. CONTEXT.md: five canonical roles, no ADMIN.
 */

/** The five canonical roles (CONTEXT.md "People"). Order is stable for display/iteration. */
export const ROLES = [
  'SERVICE_ENGINEER',
  'ZONAL_MANAGER',
  'CENTRAL_SERVICE_MANAGER',
  'OPERATIONS_HEAD',
  'WAREHOUSE_MANAGER',
] as const;

export type Role = (typeof ROLES)[number];

/** Runtime guard — narrows an unknown string to a canonical Role. */
export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

/**
 * The signed-in SE's own identity/coverage/reporting profile — #161's `/api/me` enrichment.
 * Populated on `SessionView.profile` only when `role === 'SERVICE_ENGINEER'`; every other role gets
 * no `profile` key at all (no extra joins on the session-hydration path for managers). Scoped to
 * exactly what `docs/ui/mobile/home-dashboard.png` (header) and `docs/ui/mobile/profile.png` render
 * — `coverageType`/`dailyCapacity`/shift window/the full covered-plants list do not appear on either
 * screen and are deliberately not part of this contract.
 */
export interface SeProfileView {
  name: string;
  phone: string;
  email: string;
  zoneName: string;
  coverageType: 'DEDICATED' | 'MULTI_PLANT' | 'FLOATING';
  /** The SE's single covered plant. Only ever populated for `DEDICATED` coverage (CONTEXT.md: "A
   *  Dedicated SE has 1 Plant in coverage") — `null` for MULTI_PLANT/FLOATING, which have no single
   *  "home" plant in the data model. That is a genuine, undecided product gap, not a bug: those
   *  coverage types were never given a "home" concept, and the reference image only depicts a
   *  Dedicated SE. */
  homePlant: { plantId: string; name: string } | null;
  /** The SE's Zonal Manager, resolved via `Zone.zonalManagerUserId`. `null` if the zone has no ZM
   *  assigned. */
  reportsTo: { name: string; role: Role; phone: string; email: string } | null;
}

/** What `GET /api/me` returns — the caller's session as rendered by the admin shell. */
export interface SessionView {
  user_id: string;
  role: Role;
  zone_id: number | null;
  /** Set only when acting in another scope via the backup cascade; otherwise null. */
  acted_as_role: Role | null;
  /** The caller's own SE profile — present only when `role === 'SERVICE_ENGINEER'`. */
  profile?: SeProfileView;
}

/** `POST /api/auth/login` request body. */
export interface LoginRequest {
  email: string;
  password: string;
}

/** `POST /api/auth/login` (and `/refresh`) response body. */
export interface LoginResponse {
  accessToken: string;
  refreshToken: string;
}

/** `GET /api/me/tickets` (#161 item 2, per #172 Decision 3) row shape — the merged SE day-plan +
 *  shared-pool read. The image's row glyph (V/P/W/✓) — naming vocabulary pinned under #169, semantics
 *  fixed by #172 Decision 3. VERIFY/IN_WORK are unambiguous (ticket status / active soft state); PLAN
 *  vs VISIT_NOW splits assigned-but-not-started day-plan work from open shared-pool work. */
export type MeTicketWorkState = 'VISIT_NOW' | 'PLAN' | 'IN_WORK' | 'VERIFY';

export interface MeTicketRow {
  ticketId: string;
  /** #161 D-4 — the `TCK-#####` display label's raw number (see `ticket-no.ts`). */
  ticketNo: number;
  /** Pre-formatted `TCK-#####` (zero-padded to 5) so the client never re-derives the padding rule. */
  ticketNoDisplay: string;
  assigned: boolean;
  workState: MeTicketWorkState;
  workType: string;
  status: string;
  plantId: string;
  plantName: string;
  companyName: string;
  companyTier: string;
  slaBucket: string | null;
  deviceId: string;
  vehicleId: string | null;
  /** The vehicle's registration number (`Vehicle.vehicleNo`) — `null` iff `vehicleId` is `null`.
   *  #56: the mobile Tickets card shows this, not the opaque id. */
  vehicleNo: string | null;
  activeSoftState: string | null;
  /** Serialized as ISO strings on the wire (backend assigns real `Date` objects; Express's JSON
   *  serializer stringifies them). Typed `Date` here to match the backend's own construction site —
   *  a client reading these two fields must parse them, same as any other JSON date. */
  createdAt: Date;
  lastStateChangedAt: Date;
  /** PRD:510 — "removed Ticket shows 'removed' label for one session". Non-null (ISO timestamp) only
   *  when this ticket was removed from the caller's *current* day-plan batch earlier **today**
   *  (`BatchAssignmentTicket.removedAt`, any override action — REMOVE_TICKET/DEFER_TICKET/REASSIGN/
   *  SPLIT_BATCH — scoped to the caller's live `WorkSchedule`). Without this the row would either
   *  silently vanish (a same-day defer to a future date drops out of both the assigned and pool
   *  branches) or reappear with no signal that anything changed (a plain removal that returns to the
   *  pool). The client renders the label and may forget it locally after showing it once — there is
   *  no server-side "already shown this session" state to key on. `null` for a normal row. */
  removedFromPlanAt: string | null;
  /** Set alongside `removedFromPlanAt` only for a DEFER_TICKET removal — the date the ticket returns
   *  to the pool. `null` for every other case, including a non-removed row. */
  deferredToDate: string | null;
  /** #84 AC #2 — "card source = the single highest-severity hint" from the device's latest
   *  `RawDeviceSnapshot`. `null` when no hint currently fires OR the device has no snapshot row at
   *  all — the list row has no separate "unavailable" signal, unlike the detail payload's
   *  `technicalHealth.available`. */
  topHint: TechnicalHint | null;
}

/** #84 — Technical Hints (derived telemetry signals), PRD §641 Flow 14. Frozen vocabulary (#169 owns
 *  freezing this contract further; do not rename without updating there) — eight `code`s, one per
 *  §641 condition. Mirrors `apps/backend/src/me-tickets/technical-hints.ts`'s `TechnicalHint`. */
export type TechnicalHintCode =
  | 'NO_MAIN_POWER'
  | 'NOT_ON_NETWORK'
  | 'GPS_INVALID'
  | 'NO_GPS_FIX'
  | 'LOW_VOLTAGE'
  | 'WEAK_GSM'
  | 'IGNITION_OFF'
  | 'VEHICLE_IN_MOTION';

export interface TechnicalHint {
  code: TechnicalHintCode;
  severity: number;
  label: string;
}

export interface MeTicketsView {
  items: MeTicketRow[];
  cursor: null;
}

// ---------------------------------------------------------------------------------------------
// #175 — GET /api/me/work-history (the Home "Assigned vs Completed" chart).
// Mirrors apps/backend/src/me-tickets/me-work-history.service.ts.
// ---------------------------------------------------------------------------------------------

/**
 * One bar-pair in the Home chart (`docs/ui/mobile/home-dashboard.png`), for one **IST calendar day**
 * (CONTEXT §19 — the operating day; see the backend's `common/ist-day.ts`).
 *
 * `completed` is a strict subset of `assigned`: a day's assigned set is what the SE's schedules put in
 * front of them, and a ticket counts as completed on the day it *closed*, only if it was in that same
 * day's assigned set. That is what makes the image's `4/6`-style label read as a fraction and keeps a
 * bar from ever overflowing its track.
 */
export interface MeWorkHistoryDay {
  /** `YYYY-MM-DD`, the IST calendar date. */
  date: string;
  assigned: number;
  completed: number;
}

/** `GET /api/me/work-history?days=N` → a dense series, oldest day first. Days on which the SE had no
 *  schedule are present with zeroes, never omitted — the chart always renders N bars. */
export interface MeWorkHistoryView {
  days: MeWorkHistoryDay[];
}

/**
 * SLA bucket enum (CONTEXT "SLA Bucket" / LLD §9). A device's inactivity-age band, severity ascending
 * WARNING → LONG_PENDING. Deliberately omits ACTIVE — the 0–4h band is the *absence* of a bucket
 * (stored as NULL, never queued).
 */
export type SlaBucket =
  | 'WARNING'
  | 'EARLY_RISK'
  | 'RISK'
  | 'CRITICAL'
  | 'HIGH_CRITICAL'
  | 'SEVERE'
  | 'VERY_SEVERE'
  | 'LONG_PENDING';

/**
 * Closed-lower inactivity-hour boundaries per SLA bucket, highest band first (the first bound ≤ hours
 * wins). THE single source of truth for bucket ranges: the backend classifier
 * (`device-state/sla-bucket`) resolves a device's bucket from these bounds, and the admin Settings
 * legend derives its displayed ranges from the same array — so the two can never drift. Editing a
 * threshold here updates both classification and the UI legend together. The 0–4h ACTIVE band is the
 * absence of a bucket and is intentionally not listed.
 */
export const SLA_BANDS: ReadonlyArray<readonly [number, SlaBucket]> = [
  [168, 'LONG_PENDING'], // 7d+
  [120, 'VERY_SEVERE'], // 5–7d
  [72, 'SEVERE'], // 3–5d
  [48, 'HIGH_CRITICAL'], // 48–72h
  [24, 'CRITICAL'], // 24–48h
  [12, 'RISK'], // 12–24h
  [8, 'EARLY_RISK'], // 8–12h
  [4, 'WARNING'], // 4–8h
];

// ---------------------------------------------------------------------------------------------
// #57 — GET /api/me/tickets/:id (Ticket Detail), GET /api/tickets/:id/verification, POST
// /api/tickets/:id/soft-state. Mirrors apps/backend/src/me-tickets/me-ticket-detail.service.ts,
// verification/verification-query.service.ts, soft-state/soft-state.controller.ts.
// ---------------------------------------------------------------------------------------------

/** One entry in a ticket's Failure-Cycle chain, oldest toward the ticket's own cycle. Bounded (10
 *  entries) — the mobile Ticket Detail's "repeat failure history", not the manager Device Detail's
 *  unbounded lifetime list. */
export interface FailureCycleHistoryEntry {
  cycleId: string;
  openedAt: string;
  closedAt: string | null;
  repeatFailure: boolean;
}

/** One `ComponentRequest` raised against the ticket — actual request/approve/ship/receive history,
 *  not a catalog-driven "expected components" list (that derivation doesn't exist yet). `[]` when
 *  the ticket has none. */
export interface ComponentRequestEntry {
  requestId: string;
  componentId: string | null;
  componentName: string | null;
  status: string;
  requestedAt: string;
}

/** The subset of `RawDeviceSnapshot` the Technical Health card renders. */
export interface RawTelemetry {
  gpsDatetime: string;
  lat: number | null;
  lon: number | null;
  mainsStatus: number | null;
  mainsVoltage: number | null;
  gpsValidity: string | null;
  gpsMode: string | null;
  ignitionStatus: string | null;
  speed: number | null;
  creg: string | null;
  cgreg: string | null;
  csq: number | null;
  ipAddress: string | null;
  portNo: number | null;
  simSubscriberName: string | null;
  unitNo: string | null;
  deviceType: string | null;
}

/** #84 — derived Technical Hints + raw telemetry, from the device's latest `RawDeviceSnapshot`.
 *  `available:false` when the device has no snapshot row at all, distinct from an individual raw
 *  field being genuinely null. Purely advisory. */
export interface TechnicalHealth {
  hints: TechnicalHint[];
  rawTelemetry: RawTelemetry | null;
  dataAsOf: string | null;
  available: boolean;
}

/**
 * `GET /api/me/tickets/:id` (#161 item 1 / #57) — the mobile Ticket Detail read. Covers
 * TROUBLESHOOT/RECOVERY/INSTALL uniformly. `companyTier` is stamped-at-creation, may diverge from
 * the live effective tier by design. `transporterContact` (#171) is a single, server-resolved
 * field — `null` renders an honest "no contact on file" state, never a dead tap-to-call button.
 * `readinessHint` is always `'UNKNOWN'` today (no per-ticket value persisted anywhere).
 */
export interface MeTicketDetailView {
  ticketId: string;
  ticketNo: number;
  ticketNoDisplay: string;
  deviceId: string;
  vehicleNo: string | null;
  plantName: string;
  companyName: string;
  companyTier: string;
  transporterName: string | null;
  transporterContact: string | null;
  slaBucket: string | null;
  workType: string;
  status: string;
  activeSoftState: string | null;
  createdAt: string;
  lastStateChangedAt: string;
  failureCycleHistory: FailureCycleHistoryEntry[];
  expectedComponents: ComponentRequestEntry[];
  componentRequestStatus: string | null;
  waitingComponentSince: string | null;
  readinessHint: 'READY' | 'ON_TRIP' | 'STALE' | 'UNKNOWN';
  technicalHealth: TechnicalHealth;
  /**
   * #246 — the IST calendar day this ticket is waiting for, or `null` when it is not waiting. Set by
   * a vehicle-unavailability filing (and re-derived when a manager decides the return date), so the
   * SE who filed can see the consequence on the ticket itself rather than only in the moment after
   * submitting the form.
   */
  deferredUntil: string | null;
}

/** Auto-verification phase (Decisions §9/§677). */
export type VerifyPhase = 'PENDING' | 'PHASE_1_PASS' | 'PHASE_2_PASS';

/** Auto-verification terminal outcome. */
export type VerifyOutcome = 'CLOSED' | 'FAILED_VERIFICATION' | 'PARTIAL_RECOVERY' | 'CLOSED_AUTO_RECOVERY' | 'FAILED_ACTIVATION';

/** What the mobile renders: the final outcome, or a PARTIAL_RECOVERY badge while 1-2 pings are in. */
export type VerificationBadge = VerifyOutcome | 'PARTIAL_RECOVERY' | null;

/** `GET /api/tickets/:id/verification` — 404 (`NO_VERIFICATION_RUN`) until a run exists, i.e. only
 *  meaningful once the ticket is `VERIFICATION_PENDING`. Don't call this for a ready-state ticket. */
/** One row in `VerificationView.checks` (#59 / #172 Decision 4's generic-checks shape — the
 *  algorithm stays free to change without a field break). #59 (2026-08-04): only the 3 checks with
 *  a real source in `verification-criteria.ts` ship — "Device mapping verified" and "Historical
 *  mapping checked" (from the reference image) have no defined signal yet and are deliberately
 *  omitted rather than guessed. */
export interface VerificationCheck {
  key: 'live_gps' | 'multiple_pings' | 'stability_window';
  label: string;
  state: 'PASS' | 'FAIL' | 'PENDING';
}

export interface VerificationView {
  ticketId: string;
  /** The device this verification run is anchored to — the Device Guard card ("GPS909 only —
   *  backup device cannot close this ticket"). */
  deviceId: string;
  phase: VerifyPhase;
  pingsReceivedCount: number;
  outcome: VerifyOutcome | null;
  fraudFlag: boolean;
  firstPingDistanceMeters: number | null;
  badge: VerificationBadge;
  checks: VerificationCheck[];
  startedAt: string;
  /** `startedAt` + 24h only while `badge === 'PARTIAL_RECOVERY'`; `null` otherwise (#172 Decision 4
   *  — the SE route previously omitted this entirely, see #59's own 2026-07-28 comment). */
  partialDeadline: string | null;
}

/** The VIEWED -> ON_SITE -> TROUBLESHOOT_STARTED chain (Issue 15 / CONTEXT §334-353). */
export type SoftStateType = 'VIEWED' | 'ON_SITE' | 'TROUBLESHOOT_STARTED';

/** `AUTO_GEOFENCE` when a captured ON_SITE location falls inside the plant's geofence (server-side
 *  decision, default 200m radius); `MANUAL` otherwise, incl. no location captured at all. */
export type OnsiteSource = 'AUTO_GEOFENCE' | 'MANUAL';

/** `POST /api/tickets/:id/soft-state` request body. `location` only applies to `target: 'ON_SITE'`
 *  — omit when capture failed or location is off; the server decides `onsiteSource`, never the
 *  client. */
export interface SetSoftStateRequest {
  target: SoftStateType;
  location?: { lat: number; lng: number };
}

/** One soft-state row as the wire serializes it (`soft-state.controller.ts`'s `serialize()`) —
 *  `softStateId` is a stringified bigint, the three dates are ISO strings (JSON has no `Date`). */
export interface SoftStateWireView {
  softStateId: string;
  ticketId: string;
  seId: string;
  type: SoftStateType;
  onsiteSource: OnsiteSource | null;
  setAt: string;
  timeoutAt: string | null;
  resolvedAt: string | null;
}

/** `POST /api/tickets/:id/soft-state` 200 response. `result: 'IDEMPOTENT'` on a re-tap of the
 *  already-current state (not an error). A transition the chain doesn't allow is a 409
 *  `INVALID_SOFT_STATE_TRANSITION` instead — see `SoftStateConflictBody`. */
export interface SetSoftStateResponse {
  result: 'OK' | 'IDEMPOTENT';
  softState: SoftStateWireView;
}

/** 409 body for an out-of-order soft-state transition. */
export interface SoftStateConflictBody {
  code: 'INVALID_SOFT_STATE_TRANSITION';
  from: SoftStateType | null;
  to: SoftStateType;
}

// ---------------------------------------------------------------------------------------------
// #58 — POST /api/tickets/:id/troubleshoot. Mirrors ticketing/troubleshoot.controller.ts /
// ticketing/troubleshoot-submission.service.ts.
// ---------------------------------------------------------------------------------------------

/** The real, validated server enum (`troubleshoot.controller.ts`'s `ROOT_CAUSE_CATEGORIES`) — the
 *  Issue-Found tile picker's choices come from here, not the reference image's mismatched labels
 *  (#172 Decision 8: "rootCauseCategory is a proper server enum"). */
export type RootCauseCategory =
  | 'POWER_ISSUE'
  | 'SIM_NETWORK_ISSUE'
  | 'GPS_ANTENNA_ISSUE'
  | 'DEVICE_HARDWARE_FAULT'
  | 'WIRING_ISSUE'
  | 'CONFIGURATION_ISSUE'
  | 'VEHICLE_ACCESS_ISSUE'
  | 'INSTALLATION_ISSUE'
  | 'CUSTOMER_SIDE_ISSUE'
  | 'UNKNOWN';

export const ROOT_CAUSE_CATEGORIES: RootCauseCategory[] = [
  'POWER_ISSUE',
  'SIM_NETWORK_ISSUE',
  'GPS_ANTENNA_ISSUE',
  'DEVICE_HARDWARE_FAULT',
  'WIRING_ISSUE',
  'CONFIGURATION_ISSUE',
  'VEHICLE_ACCESS_ISSUE',
  'INSTALLATION_ISSUE',
  'CUSTOMER_SIDE_ISSUE',
  'UNKNOWN',
];

/** One component the SE physically consumed on this visit (#352). `componentId` is a
 *  `component_master` id, stringified — JSON has no bigint, and these ids are `bigserial`.
 *  `qty` is a positive integer; the server rejects 0 or a fraction at the pipe. */
export interface ConsumedComponentInput {
  componentId: string;
  qty: number;
}

/** `POST /api/tickets/:id/troubleshoot` request body. `actionTakenCategory` is still an unvalidated
 *  free string server-side (#172 Decision 8: "becomes an enum" is #169/#174's still-open work) —
 *  the mobile tile picker sends the reference image's own literal labels as plain strings, the only
 *  vocabulary that exists anywhere for this field today. `photoRefs` is deliberately omitted here:
 *  photo capture is blocked on #81 (Media Upload API, unbuilt) and not sent by this build.
 *
 *  **Error vocabulary (#352).** Every refusal on this route answers `{ code }`, so a client renders
 *  a sentence rather than a validator's field message:
 *  - 400 `CLIENT_SUBMISSION_ID_REQUIRED`, 400 `ROOT_CAUSE_CATEGORY_REQUIRED`
 *  - 400 `COMPONENT_ITEM_REQUIRED` — `componentUnavailable: true` with no `componentUnavailableItem`
 *  - 400 `UNKNOWN_COMPONENT` (`{ componentIds }`) — an id naming no `component_master` row, on
 *    either field
 *  - 409 `INSUFFICIENT_VAN_STOCK` (`{ shortages }`) — the van does not carry what was consumed
 *  - 409 `TICKET_ALREADY_CLOSED` — the Business-409 conflict; see `TroubleshootConflictBody` */
export interface TroubleshootSubmitRequest {
  clientSubmissionId: string;
  rootCauseCategory: RootCauseCategory;
  rootCauseSubcategory?: string;
  rootCauseNotes?: string;
  actionTakenCategory?: string;
  actionTakenNotes?: string;
  /** Server-internal-only field (never rendered to the SE) — not sent by this build. */
  diagnosisNotes?: string;
  componentUnavailable?: boolean;
  /** A `component_master` id, stringified. **Required whenever `componentUnavailable` is true**
   *  (`ts_submissions_component_unavailable_item` is a CHECK constraint, not a nicety) — omitting it
   *  is a 400 `COMPONENT_ITEM_REQUIRED`, and an id that names no catalog row is a 400
   *  `UNKNOWN_COMPONENT`. Read the ids from `GET /api/components` (#352). */
  componentUnavailableItem?: string;
  /** Components physically consumed on this visit (#352). They decrement `se_van_stock` and enter
   *  the ledger as `TICKET_CONSUMPTION` / `PRE_VERIFICATION`, resolving to DEDUCTED or ROLLED_BACK on
   *  the verification outcome. On the Business-409 path they are still recorded — as SHADOW_USE
   *  against the losing SE's van, which is why `TroubleshootConflictBody.shadowUseRecorded` can now
   *  be true. Omitting the field is exactly today's behaviour: nothing moves. */
  consumedComponents?: ConsumedComponentInput[];
  /** Not sent by this build — photo capture is blocked on #81 (Media Upload API, unbuilt). */
  photoRefs?: string[];
  seGps?: { lat: number; lon: number };
}

/** `GET /api/components` row — the whole component catalog (`component_master`), readable by every
 *  authenticated role. The SE's component picker reads it to turn a part into the id that
 *  `componentUnavailableItem` / `consumedComponents[].componentId` require (#352, the catalog half
 *  of #173). There is no `active` column on `component_master`: the catalog is the catalog. */
export interface ComponentCatalogItem {
  componentId: string;
  name: string;
  category: string | null;
  serialTracked: boolean;
}

/** 409 `INSUFFICIENT_VAN_STOCK` body (#352) — one entry per component the van cannot cover, so the
 *  client can name the part and the number instead of "submission failed". */
export interface InsufficientVanStockBody {
  code: 'INSUFFICIENT_VAN_STOCK';
  shortages: { componentId: string; requested: number; available: number }[];
}

/** 400 `UNKNOWN_COMPONENT` body (#352) — the ids that name no `component_master` row. Almost always
 *  a stale picker cache: refetch `GET /api/components`. */
export interface UnknownComponentBody {
  code: 'UNKNOWN_COMPONENT';
  componentIds: string[];
}

export interface TroubleshootSubmissionView {
  submissionId: string;
  ticketId: string;
  seId: string;
  clientSubmissionId: string;
  rootCauseCategory: RootCauseCategory;
  componentUnavailable: boolean;
  presenceSource: string;
  seGpsLat: number | null;
  seGpsLon: number | null;
  submittedAt: string;
}

export interface TroubleshootSubmitResponse {
  result: 'OK' | 'DUPLICATE';
  duplicate: boolean;
  submission: TroubleshootSubmissionView;
}

/** Business 409 (CONTEXT §Business 409 Conflict) — another SE's submission already won, or
 *  auto-recovery closed the ticket (`status === 'CLOSED_AUTO_RECOVERY'` — no winning SE at all,
 *  `winnerSeId`/`winnerSeName`/`winnerAt` all null; render accordingly, never a lie like "closed
 *  by null"). Distinct from a `DUPLICATE`, which is a 200. `winnerSeName` resolves the winner's
 *  `User.name` server-side (#63) so the client never renders a bare UUID at a field engineer.
 *  `shadowUseRecorded` is true when the losing SE sent `consumedComponents` and the server booked
 *  them against their van as SHADOW_USE for warehouse reconciliation (#352 wired the field that
 *  used to make this permanently `false` over HTTP). The van is short either way — the SE fitted the
 *  part before learning they had lost the race — so the ledger records physical reality and the
 *  refusal is about the ticket, not the parts. */
export interface TroubleshootConflictBody {
  code: 'TICKET_ALREADY_CLOSED';
  status: string;
  winnerSeId: string | null;
  winnerSeName: string | null;
  winnerAt: string | null;
  shadowUseRecorded: boolean;
}

// ---------------------------------------------------------------------------------------------
// #60 — GET /api/me/van-stock, GET /api/me/component-requests, POST
// /api/component-requests/:id/confirm-receipt. Mirrors inventory/inventory.service.ts,
// component-request/component-request.service.ts.
// ---------------------------------------------------------------------------------------------

/** One component the SE currently carries (`se_van_stock`). No status/threshold field — LOW vs OK
 *  is derived client-side by cross-referencing `CommonKitStatus.missing` (see #60's
 *  `vanStockDisplay.ts`), not a column that exists here. */
export interface VanStockItem {
  componentId: string;
  name: string;
  qty: number;
}

export interface CommonKitMissing {
  componentId: string;
  name: string;
  shortBy: number;
}

/** Every active kit component carried at >= its `min_qty`. An SE with no van-stock records at all,
 *  or no active kit definition, is trivially `complete` (seam-default — don't ground an SE on a
 *  data gap). */
export interface CommonKitStatus {
  complete: boolean;
  missing: CommonKitMissing[];
}

export interface VanStockView {
  stock: VanStockItem[];
  commonKit: CommonKitStatus;
}

export type ComponentRequestStatus = 'REQUESTED' | 'APPROVED' | 'REJECTED' | 'SHIPPED' | 'RECEIVED';
export type DeliveryDestination = 'SE_LOCATION' | 'PLANT_WAREHOUSE';

/** `GET /api/me/component-requests` (#163 item 5) row — the SE-readable variant of the manager
 *  oversight read. */
export interface ComponentRequestRow {
  requestId: string;
  ticketId: string;
  seId: string;
  componentId: string | null;
  componentName: string | null;
  status: ComponentRequestStatus;
  deliveryDestination: DeliveryDestination | null;
  trackingRef: string | null;
  rejectionReason: string | null;
  companyName: string;
  zoneName: string;
  ageDays: number;
  createdAt: string;
}

export interface MeComponentRequestsView {
  items: ComponentRequestRow[];
  cursor: null;
}

/** `POST /api/component-requests/:id/confirm-receipt` 200 response — marks `RECEIVED`, resumes the
 *  SLA clock server-side. 409 (`COMPONENT_REQUEST_INVALID_STATE`) when the request isn't currently
 *  `SHIPPED`; carries the real current `status` so the client can render *why*, not just that it
 *  failed. */
export interface ConfirmReceiptResponse {
  request: {
    requestId: string;
    ticketId: string;
    seId: string;
    componentId: string | null;
    status: ComponentRequestStatus;
    deliveryDestination: DeliveryDestination | null;
    trackingRef: string | null;
    rejectionReason: string | null;
    createdAt: string;
  };
}

export interface ConfirmReceiptConflictBody {
  code: 'COMPONENT_REQUEST_INVALID_STATE';
  status: ComponentRequestStatus;
}

// ---------------------------------------------------------------------------------------------
// #55 — GET /api/schedules/me (Day Plan). Mirrors scheduling/day-plan-query.service.ts.
// ---------------------------------------------------------------------------------------------

export interface DayPlanStopTicket {
  ticketId: string;
  sortOrder: number;
}

export interface DayPlanStop {
  batchId: string;
  stopSequence: number;
  plantId: string;
  plantName: string;
  deviceCount: number;
  tickets: DayPlanStopTicket[];
}

/** `dispatched: false` (pre-dispatch, no live schedule) renders the mobile Home "your plan is
 *  being prepared" empty state — `stops` is always `[]` in that case, never a stale prior day's
 *  plan (#147's date-filter fix). */
export interface DayPlanView {
  dispatched: boolean;
  scheduleId: string | null;
  dateFrom: string | null;
  dateTo: string | null;
  stops: DayPlanStop[];
}

// ---------------------------------------------------------------------------------------------
// #81 — POST /api/media/upload (D-12, #172 Decision 6). The photo-capture seam consumed by
// #58 (troubleshoot), #61 (vouchers), #71 (install). `photoRef` on those forms is the returned
// `mediaId`, an opaque string carrying no storage detail.
// ---------------------------------------------------------------------------------------------

export type MediaKind = 'TROUBLESHOOT' | 'VOUCHER' | 'INSTALL';
export type MediaSlot = 'BEFORE' | 'AFTER' | 'PART' | 'PLATE' | 'RECEIPT' | 'PHOTO' | 'BILL' | 'INSTALL_PHOTO';

/** The valid slot set per `MediaKind` — the #172 Decision 6 shape. Shared by the backend's upload
 *  validation and the mobile capture form so both sides read one definition. */
export const MEDIA_SLOTS_BY_KIND: Record<MediaKind, readonly MediaSlot[]> = {
  TROUBLESHOOT: ['BEFORE', 'AFTER', 'PART', 'PLATE'],
  VOUCHER: ['RECEIPT', 'PHOTO', 'BILL'],
  INSTALL: ['INSTALL_PHOTO'],
};

/** `POST /api/media/upload` (multipart: `file` + `kind` + `slot` fields) 201 response. */
export interface UploadMediaResponse {
  photoRef: string;
  kind: MediaKind;
  slot: MediaSlot;
}

// ---------------------------------------------------------------------------------------------
// #61 — Vouchers (mobile capture). `POST /api/vouchers` (Issue 38) + `GET /api/me/vouchers` (#163
// item 1). Mirrors vouchers/vouchers.controller.ts + vouchers/me-vouchers.service.ts.
// ---------------------------------------------------------------------------------------------

export type VoucherStatus =
  | 'DRAFT'
  | 'SUBMITTED'
  | 'ZONAL_MANAGER_REVIEW'
  | 'APPROVED'
  | 'REJECTED'
  | 'NEEDS_CLARIFICATION'
  | 'PAID';

export type ExpenseCategory = 'TRAVEL' | 'ACCOMMODATION' | 'PARTS' | 'TOOLS' | 'MEAL' | 'OTHER';

export const EXPENSE_CATEGORIES: readonly ExpenseCategory[] = [
  'TRAVEL',
  'ACCOMMODATION',
  'PARTS',
  'TOOLS',
  'MEAL',
  'OTHER',
];

export interface CreateVoucherItemRequest {
  category: ExpenseCategory;
  amount: number;
  merchantVendorName?: string | null;
  expenseDatetime?: string | null;
  photoRef?: string | null;
}

/** `POST /api/vouchers` body. `clientSubmissionId` makes a resubmit-after-network-drop idempotent —
 *  the server returns the existing voucher rather than creating a second one. */
export interface CreateVoucherRequest {
  clientSubmissionId: string;
  plantId?: number | string | null;
  ticketId?: string | null;
  vehicleId?: number | string | null;
  items: CreateVoucherItemRequest[];
}

export interface VoucherView {
  voucherId: string;
  seId: string;
  clientSubmissionId: string;
  status: VoucherStatus;
  totalAmount: number;
  submittedAt: string | null;
}

export interface CreateVoucherResponse {
  voucher: VoucherView;
  duplicate: boolean;
}

export interface MeVoucherItemView {
  itemId: string;
  category: ExpenseCategory;
  amount: number;
  merchantVendorName: string | null;
  expenseDatetime: string | null;
  photoRef: string | null;
  limit: number;
  overLimit: boolean;
}

export interface MeVoucherRow {
  voucherId: string;
  status: VoucherStatus;
  plantId: number | null;
  plantName: string | null;
  ticketId: string | null;
  vehicleId: number | null;
  totalAmount: number;
  submittedAt: string | null;
  reviewNotes: string | null;
  reviewerName: string | null;
  items: MeVoucherItemView[];
  createdAt: string;
}

export interface MeVouchersSummary {
  claimedTotal: number;
  pendingCount: number;
  approvedCount: number;
}

export interface MeVouchersView {
  items: MeVoucherRow[];
  cursor: null;
  summary: MeVouchersSummary;
}

// ---------------------------------------------------------------------------------------------
// #64 — Vehicle Unavailability Report (Issue 28's `POST /api/vehicle-unavailability`, SE leg).
// Filing pauses the primary SLA; the SE never sees the manager-only Secondary SLA Clock.
// ---------------------------------------------------------------------------------------------

export type VehicleUnavailReason =
  | 'VEHICLE_ON_TRIP'
  | 'VEHICLE_NOT_AT_PLANT'
  | 'DRIVER_NOT_AVAILABLE'
  | 'CUSTOMER_REFUSED'
  | 'OTHER';

export const VEHICLE_UNAVAIL_REASONS: readonly VehicleUnavailReason[] = [
  'VEHICLE_ON_TRIP',
  'VEHICLE_NOT_AT_PLANT',
  'DRIVER_NOT_AVAILABLE',
  'CUSTOMER_REFUSED',
  'OTHER',
];

/** `POST /api/vehicle-unavailability` body. `seId` is always the caller's own id for an SE —
 *  the server 403s (`VU_FORBIDDEN`) if it isn't. `transporterName`/`transporterContact` (#171) are
 *  the number the SE actually used, distinct from — and a correction signal for — the master
 *  `Transporter.contactPhone` shown on Ticket Detail. */
export interface FileVehicleUnavailabilityRequest {
  ticketId: string;
  seId: string;
  reasonCode: VehicleUnavailReason;
  transporterContacted?: boolean;
  transporterName?: string | null;
  transporterContact?: string | null;
  expectedFrom: string;
  expectedTo?: string | null;
  notes?: string | null;
  gpsLat?: number | null;
  gpsLng?: number | null;
}

export interface VehicleUnavailabilityResponse {
  result: 'OK';
  id: string;
  /**
   * #246 — the IST calendar day this ticket now waits for, or `null` when the vehicle is back today
   * and there is nothing to wait for. Returned rather than derived client-side because the same-day
   * rule (Decision 14) is the server's to apply: a client recomputing it from the date it just sent
   * would be a second implementation of the deferral semantics, and the two would drift.
   */
  deferredUntil: string | null;
}

// ---------------------------------------------------------------------------------------------
// #68 — SE mobile Recovery screens (Issue 36's `/api/recovery/:id/{on-site,collected,
// unable-to-collect}`, SE leg). Serial validation is server-authoritative; the client's own
// non-empty check is a pre-flight only.
// ---------------------------------------------------------------------------------------------

export type UnableToCollectReason = 'COMPANY_REFUSED' | 'VEHICLE_UNREACHABLE' | 'DEVICE_MISSING' | 'OTHER';

export const UNABLE_TO_COLLECT_REASONS: readonly UnableToCollectReason[] = [
  'COMPANY_REFUSED',
  'VEHICLE_UNREACHABLE',
  'DEVICE_MISSING',
  'OTHER',
];

/** `POST /api/recovery/:id/collected` body. */
export interface MarkRecoveryCollectedRequest {
  deviceSerial: string;
  conditionNotes: string;
}

/** `POST /api/recovery/:id/unable-to-collect` body. */
export interface MarkRecoveryUnableToCollectRequest {
  reasonCode: UnableToCollectReason;
}

/** JSON-safe (`deviceId` as `string`) shape of the recovery ticket returned by every
 *  `/api/recovery/:id/*` action — mirrors `RecoveryView` (`recovery.service.ts`). */
export interface RecoveryActionResponse {
  ticketId: string;
  status: string;
  deviceId: string;
  assignedSeId: string | null;
  collectedDeviceSerial: string | null;
  collectionConditionNotes: string | null;
  unableToCollectReason: UnableToCollectReason | null;
  closureType: string | null;
  closedAt: string | null;
}

// ---------------------------------------------------------------------------------------------
// #71 — SE mobile Install screens (Issue 34's `/api/install/:id/{on-site,fitted}`, SE leg).
// GPS device serial is server-validated against the ticket's device; SIM serial only needs to be
// non-empty. `GET /api/install/:id` is NOT SE-readable (WM/manager only) — the mobile app polls
// `GET /api/me/tickets/:id` (`MeTicketDetailView.status`) for the ACTIVATED -> CLOSED /
// FAILED_ACTIVATION activation outcome instead.
// ---------------------------------------------------------------------------------------------

/** `POST /api/install/:id/fitted` body. */
export interface MarkInstallFittedRequest {
  gpsDeviceSerial: string;
  simSerial: string;
  photoRef?: string | null;
}

/** JSON-safe (`deviceId` as `string`) shape of the install ticket returned by every
 *  `/api/install/:id/*` action — mirrors `InstallView` (`install-lifecycle.service.ts`). */
export interface InstallActionResponse {
  ticketId: string;
  status: string;
  deviceId: string;
  assignedSeId: string | null;
  fittedGpsSerial: string | null;
  fittedSimSerial: string | null;
  fittedPhotoRef: string | null;
  fittedAt: string | null;
  activatedAt: string | null;
  closedAt: string | null;
}

// ---------------------------------------------------------------------------------------------
// #77's SE mobile intra-day CRITICAL insertion Accept/Decline types (IntradayDeclineReasonCode,
// INTRADAY_DECLINE_REASON_CODES, IntradayInsertionOffer, MyIntradayOffersView,
// DeclineIntradayInsertionRequest, AcceptIntradayInsertionResponse, DeclineIntradayInsertionResponse)
// are retired by #268: SE Acceptance no longer exists on the CRITICAL path (#258 Q3), so there is no
// offer to accept/decline and no `GET /api/me/intraday-insertions` to view one from (#169 removal).
// ---------------------------------------------------------------------------------------------
// #77 — the generic in-app notification read (Issue 03's spine, `GET /api/notifications`), reused
// here for the one-time ghost-assignment toast (`type === 'INTRADAY_GHOST_ASSIGNMENT'`). Not gated
// behind #85's Notifications screen or #89's push delivery — this read endpoint already exists for
// any authenticated user.
// ---------------------------------------------------------------------------------------------

export interface NotificationListItem {
  id: string;
  type: string;
  title: string;
  body: string | null;
  entityType: string | null;
  entityId: string | null;
  metadata: unknown;
  read: boolean;
  readAt: string | null;
  createdAt: string;
}

export interface NotificationList {
  items: NotificationListItem[];
  unreadCount: number;
}

// ---------------------------------------------------------------------------------------------
// #86 — SE mobile Leave Request (Issue 26's `POST /api/leave-requests` + #163's SE-scoped
// `GET /api/me/leave-requests`). A rejected request is terminal — the SE revises and submits a new
// one, there is no edit-in-place or cancel/withdraw.
// ---------------------------------------------------------------------------------------------

export type LeaveRequestType = 'ON_LEAVE' | 'WEEKLY_OFF';

export const LEAVE_REQUEST_TYPES: readonly LeaveRequestType[] = ['ON_LEAVE', 'WEEKLY_OFF'];

/** Mirrors `LeaveRequestRow` (`leave-request.service.ts`) — already JSON-safe server-side. */
export interface LeaveRequestRow {
  id: string;
  seId: string;
  seName: string;
  type: LeaveRequestType;
  status: string;
  windowStart: string;
  windowEnd: string;
  reason: string | null;
  decisionReason: string | null;
  createdAt: string;
}

/** `GET /api/me/leave-requests` — every status (not just PENDING), so a past rejection's
 *  `decisionReason` stays visible. */
export interface MyLeaveRequestsView {
  items: LeaveRequestRow[];
  cursor: null;
}

/** `POST /api/leave-requests` body. `seId` is always the caller's own id for an SE — the server
 *  403s (`LEAVE_FORBIDDEN`) if it isn't. */
export interface SubmitLeaveRequestRequest {
  seId: string;
  type: LeaveRequestType;
  windowStart: string;
  windowEnd: string;
  reason?: string | null;
}

export interface SubmitLeaveRequestResponse {
  result: 'OK';
  id: string;
}

// ---------------------------------------------------------------------------------------------
// #87 — SE mobile Availability / SOFT_UNAVAILABLE (Issue 25's
// `POST /api/engineers/:seId/availability` + #163's SE-scoped `GET /api/me/availability`).
// `AVAILABLE` is settable only to clear the caller's own currently-active `SOFT_UNAVAILABLE`
// window early (#87/#162) — the mobile client only ever sends these two status values, never
// ON_LEAVE/OFF_SHIFT/WEEKLY_OFF (server-enforced ZM-only, would 403).
// ---------------------------------------------------------------------------------------------

export type SeSettableAvailabilityStatus = 'SOFT_UNAVAILABLE' | 'AVAILABLE';

/** Mirrors `AvailabilityRow` (`se-availability.service.ts`) — already JSON-safe server-side. */
export interface AvailabilityRow {
  status: string;
  windowStart: string;
  windowEnd: string | null;
  reason: string | null;
  setByRole: string | null;
}

/** `GET /api/me/availability` — the caller's own windows, most recent `windowStart` first (not
 *  filtered to "currently active" — the client derives that from `windowStart`/`windowEnd`). */
export interface MyAvailabilityView {
  items: AvailabilityRow[];
  cursor: null;
}

/** `POST /api/engineers/:seId/availability` body. `windowEnd` is mandatory for a self-set request
 *  (`WINDOW_END_REQUIRED` otherwise) — only a manager may leave it open-ended. */
export interface SetAvailabilityRequest {
  status: SeSettableAvailabilityStatus;
  windowStart: string;
  windowEnd: string;
  reason?: string | null;
}

export interface SetAvailabilityResponse {
  result: 'OK';
  id: string;
}
