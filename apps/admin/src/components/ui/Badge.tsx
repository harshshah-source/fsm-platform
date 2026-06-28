import type { HTMLAttributes } from 'react';
import { cn } from '../../lib/cn';

export type BadgeTone =
  | 'info'
  | 'success'
  | 'verified'
  | 'warning'
  | 'critical'
  | 'neutral'
  | 'brand';

const TONES: Record<BadgeTone, string> = {
  info: 'bg-info-bg text-info',
  success: 'bg-success-bg text-success',
  verified: 'bg-verified-bg text-verified',
  warning: 'bg-warning-bg text-warning',
  critical: 'bg-critical-bg text-critical',
  neutral: 'bg-neutral-bg text-neutral',
  brand: 'bg-brand-300 text-brand-700',
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
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium',
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
