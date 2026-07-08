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
  info: 'bg-info-bg text-info ring-info/10',
  success: 'bg-success-bg text-success ring-success/10',
  verified: 'bg-verified-bg text-verified ring-verified/10',
  warning: 'bg-warning-bg text-warning ring-warning/10',
  critical: 'bg-critical-bg text-critical ring-critical/10',
  neutral: 'bg-neutral-bg text-neutral ring-neutral/10',
  brand: 'bg-brand-300 text-brand-700 ring-brand-600/10',
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
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ring-inset',
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

