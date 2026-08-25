import type { HTMLAttributes } from 'react';
import { cn } from '../../lib/cn';

export type BadgeTone =
  | 'info'
  | 'success'
  | 'verified'
  | 'warning'
  | 'critical'
  | 'neutral'
  | 'brand'
  /**
   * #290 — "a human crossed a coverage tier", the violet in #272's non-negotiable grammar table.
   * Its own tone rather than a reuse of `warning`: amber means over capacity and crimson means
   * critical, and one colour for two meanings is what made the assign board unreadable.
   */
  | 'tierCross';

const TONES: Record<BadgeTone, string> = {
  info: 'bg-info-bg text-info ring-info/10',
  success: 'bg-success-bg text-success ring-success/10',
  verified: 'bg-verified-bg text-verified ring-verified/10',
  warning: 'bg-warning-bg text-warning ring-warning/10',
  critical: 'bg-critical-bg text-critical ring-critical/10',
  neutral: 'bg-neutral-bg text-neutral ring-neutral/10',
  brand: 'bg-brand-300 text-brand-700 ring-brand-600/10',
  tierCross: 'bg-tier-cross-bg text-tier-cross ring-tier-cross/10',
};

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
  dot?: boolean;
}

/**
 * Tinted status pill — the canonical chip for any status/label. Domain-specific badges
 * (SLABadge / StatusPill / TierBadge) build on this in FE-04.
 */
export function Badge({ tone = 'neutral', dot = false, className, children, ...rest }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex min-h-6 items-center gap-1 rounded-full px-2.5 py-0.5 text-[0.68rem] font-semibold uppercase tracking-wide ring-1 ring-inset',
        TONES[tone],
        className,
      )}
      {...rest}
    >
      {dot && <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-current" />}
      {children}
    </span>
  );
}
