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
