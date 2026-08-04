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
