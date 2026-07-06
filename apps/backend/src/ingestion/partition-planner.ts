/**
 * Pure planning for the daily `raw_device_snapshots` partitions (R3 — real partitioning + retention).
 *
 * The telemetry table is `PARTITION BY RANGE (gps_datetime)` with one child partition per UTC day. This
 * module owns the two decisions the maintenance job makes each run — **which partitions to create ahead**
 * (so ingestion never falls back to the DEFAULT catch-all) and **which to drop** (retention) — as pure
 * functions of the existing partition names, `now`, and the configured retention window. Keeping the
 * decision pure makes it unit-testable with no DB; `PartitionMaintenanceService` is a thin SQL wrapper.
 *
 * Retention is an operational value read from `system_settings` (`telemetry_retention_days`), defaulting
 * to 7 days when unset — an implementation default, changeable by Ops at any time with no redeploy.
 */

const TABLE = 'raw_device_snapshots';
const NAME_RE = /^raw_device_snapshots_y(\d{4})m(\d{2})d(\d{2})$/;

/** Default telemetry retention when the setting is absent or invalid. */
export const DEFAULT_RETENTION_DAYS = 7;

/** The `system_settings` key Ops edits to change retention without a code change. */
export const TELEMETRY_RETENTION_DAYS_KEY = 'telemetry_retention_days';

const MS_PER_DAY = 86_400_000;

/** A partition to create: its name and the half-open UTC-midnight `[from, to)` range it covers. */
export interface PartitionSpec {
  name: string;
  /** Inclusive lower bound, e.g. `2026-07-16 00:00:00+00`. */
  fromIso: string;
  /** Exclusive upper bound (next UTC midnight). */
  toIso: string;
  /** The UTC day this partition covers (midnight). */
  day: Date;
}

export interface MaintenancePlan {
  toCreate: PartitionSpec[];
  toDrop: string[];
}

/**
 * Coerce a raw settings value into a positive whole-day retention window, falling back to the 7-day
 * default for unset / non-numeric / non-positive input. Fractional values floor to whole days.
 */
export function resolveRetentionDays(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_RETENTION_DAYS;
  return Math.floor(n);
}

const pad = (n: number, width: number): string => String(n).padStart(width, '0');

/** UTC midnight of a given instant. */
export function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** `raw_device_snapshots_yYYYYmMMdDD` for the UTC day of `day`. */
export function dailyPartitionName(day: Date): string {
  return `${TABLE}_y${day.getUTCFullYear()}m${pad(day.getUTCMonth() + 1, 2)}d${pad(day.getUTCDate(), 2)}`;
}

/** The UTC day a partition name encodes, or `null` for the default / any non-dated table name. */
export function parsePartitionDate(name: string): Date | null {
  const m = NAME_RE.exec(name);
  if (!m) return null;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}

const boundIso = (day: Date): string =>
  `${day.getUTCFullYear()}-${pad(day.getUTCMonth() + 1, 2)}-${pad(day.getUTCDate(), 2)} 00:00:00+00`;

function specForDay(day: Date): PartitionSpec {
  const next = new Date(day.getTime() + MS_PER_DAY);
  return { name: dailyPartitionName(day), fromIso: boundIso(day), toIso: boundIso(next), day };
}

/**
 * Plan the create-ahead + retention work.
 *
 * - **Create-ahead:** every UTC day in `[today, today + createAheadDays]` that has no partition yet.
 * - **Retention (drop):** every existing dated partition strictly before the cutoff day
 *   `today − retentionDays`. The cutoff day itself is kept, so a 7-day window retains today plus the
 *   prior 7 days. The DEFAULT partition and any unparseable name are never dropped.
 */
export function planPartitionMaintenance(args: {
  existing: readonly string[];
  now: Date;
  retentionDays: number;
  createAheadDays: number;
}): MaintenancePlan {
  const today = startOfUtcDay(args.now);
  const existing = new Set(args.existing);

  const toCreate: PartitionSpec[] = [];
  for (let i = 0; i <= args.createAheadDays; i++) {
    const day = new Date(today.getTime() + i * MS_PER_DAY);
    const spec = specForDay(day);
    if (!existing.has(spec.name)) toCreate.push(spec);
  }

  const cutoff = new Date(today.getTime() - args.retentionDays * MS_PER_DAY);
  const toDrop: string[] = [];
  for (const name of args.existing) {
    const day = parsePartitionDate(name);
    if (day && day.getTime() < cutoff.getTime()) toDrop.push(name);
  }

  return { toCreate, toDrop };
}
