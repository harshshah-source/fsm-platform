import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { SLABadge, StatusPill, TierBadge } from './badges';

/**
 * Dense ticket summary card (reference dashboards / critical queue). Composes the domain badges; used
 * by the Critical Work Queue and role dashboards in later FE slices.
 */
export function TicketCard({
  title,
  subtitle,
  bucket,
  status,
  tier,
  meta,
  actions,
  accent,
  onClick,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  bucket?: string | null;
  status?: string;
  tier?: string;
  meta?: ReactNode;
  actions?: ReactNode;
  accent?: string;
  onClick?: () => void;
}) {
  return (
    <div
      onClick={onClick}
      className={cn(
        'rounded-card border border-line bg-surface-card p-3 shadow-sm',
        accent && `border-l-2 ${accent}`,
        onClick && 'cursor-pointer hover:bg-surface-sunken/50',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-ink-strong">{title}</div>
          {subtitle && <div className="truncate text-xs text-ink-muted">{subtitle}</div>}
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-1">
          {tier && <TierBadge tier={tier} />}
          {bucket && <SLABadge bucket={bucket} />}
          {status && <StatusPill status={status} />}
        </div>
      </div>
      {(meta || actions) && (
        <div className="mt-2 flex items-center justify-between gap-2">
          <div className="text-xs text-ink-muted">{meta}</div>
          {actions && <div className="flex items-center gap-1">{actions}</div>}
        </div>
      )}
    </div>
  );
}
