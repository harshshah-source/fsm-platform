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

/** What `GET /api/me` returns — the caller's session as rendered by the admin shell. */
export interface SessionView {
  user_id: string;
  role: Role;
  zone_id: number | null;
  /** Set only when acting in another scope via the backup cascade; otherwise null. */
  acted_as_role: Role | null;
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
