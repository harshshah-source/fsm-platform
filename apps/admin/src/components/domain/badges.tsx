import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { BUCKET_CLASS, BUCKET_LABEL, type SlaBucket } from '../../lib/slaBucket';
import { Badge, type BadgeTone } from '../ui/Badge';

/**
 * Colour-coded SLA bucket pill. Single source of colour/label is `lib/slaBucket`. Keeps the historical
 * `data-testid="bucket-<BUCKET>"` so existing ticket tests stay green. Null bucket (ACTIVE) renders nothing.
 */
export function SLABadge({ bucket, className }: { bucket: string | null; className?: string }) {
  if (!bucket) return null;
  const b = bucket as SlaBucket;
  return (
    <span
      data-testid={`bucket-${bucket}`}
      className={cn(
        'inline-block rounded-full px-2 py-0.5 text-xs font-medium',
        BUCKET_CLASS[b] ?? 'bg-neutral-bg text-neutral',
        className,
      )}
    >
      {BUCKET_LABEL[b] ?? bucket}
    </span>
  );
}

// Status vocabulary → semantic tone. Covers ticket, component-request, recovery, non-op, and
// intra-day acceptance statuses so one pill serves every queue.
const STATUS_TONE: Record<string, BadgeTone> = {
  // ticket lifecycle
  OPEN: 'info',
  SUBMITTED: 'info',
  VERIFICATION_PENDING: 'verified',
  VERIFYING: 'verified',
  CLOSED: 'success',
  CLOSED_AUTO_RECOVERY: 'neutral',
  FAILED_VERIFICATION: 'critical',
  ESCALATED: 'critical',
  CLOSED_NON_OPERATIONAL: 'neutral',
  // component request
  REQUESTED: 'warning',
  APPROVED: 'info',
  SHIPPED: 'verified',
  RECEIVED: 'success',
  REJECTED: 'critical',
  // recovery legs
  SCHEDULED: 'info',
  ON_SITE: 'info',
  COLLECTED: 'verified',
  RECEIVED_AT_WAREHOUSE: 'success',
  FAILED_RECOVERY: 'critical',
  // install legs
  FITTED: 'verified',
  ACTIVATED: 'success',
  FAILED_ACTIVATION: 'critical',
  // intra-day acceptance
  PENDING: 'warning',
  PENDING_ACCEPTANCE: 'info',
  TIMED_OUT: 'warning',
  DECLINED: 'critical',
  ESCALATION_REQUIRED: 'critical',
  // assignment
  UNASSIGNED: 'neutral',
  FORMALLY_ASSIGNED: 'info',
};

function humanize(s: string): string {
  return s
    .toLowerCase()
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Canonical status chip — maps any backend status enum to its semantic tone + a humanized label. */
export function StatusPill({
  status,
  label,
  className,
}: {
  status: string;
  label?: ReactNode;
  className?: string;
}) {
  return (
    <Badge tone={STATUS_TONE[status] ?? 'neutral'} className={className}>
      {label ?? humanize(status)}
    </Badge>
  );
}

const TIER_CLASS: Record<string, string> = {
  PLATINUM: 'bg-verified-bg text-verified',
  GOLD: 'bg-warning-bg text-warning',
  SILVER: 'bg-neutral-bg text-neutral',
};

/** Company-tier chip (PLATINUM / GOLD / SILVER). */
export function TierBadge({ tier, className }: { tier: string; className?: string }) {
  return (
    <span
      className={cn(
        'inline-block rounded px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide',
        TIER_CLASS[tier] ?? 'bg-neutral-bg text-neutral',
        className,
      )}
    >
      {tier}
    </span>
  );
}

/** Age chip — severity tone deepens with age (3 / 7 / 14 day thresholds). */
export function AgeChip({ days, className }: { days: number; className?: string }) {
  const tone: BadgeTone = days > 14 ? 'critical' : days > 7 ? 'warning' : days > 3 ? 'info' : 'neutral';
  return (
    <Badge tone={tone} className={className}>
      {days}d
    </Badge>
  );
}

/** Small inset chip for an entity reference (device / plant / company / zone). */
export function EntityBadge({ value, className }: { value: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded bg-surface-sunken px-1.5 py-0.5 text-xs text-ink',
        className,
      )}
    >
      {value}
    </span>
  );
}
