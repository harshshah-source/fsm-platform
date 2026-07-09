import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { Button } from '../ui/Button';

/** Shimmer placeholder for loading states. */
export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded bg-gradient-to-r from-surface-sunken via-line to-surface-sunken', className)} />;
}

/**
 * Neutral empty-state block for tables/sections with no data. A supplied `icon` is centred in a tokened
 * `surface-sunken` circle so every empty state across the app reads as one premium pattern (icon → one
 * helpful line → optional action). Motion on the action respects the global reduced-motion rule.
 */
export function EmptyState({
  message = 'Nothing here yet.',
  icon,
  action,
}: {
  message?: ReactNode;
  icon?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-4 py-14 text-center">
      {icon && (
        <span
          aria-hidden
          className="flex h-11 w-11 items-center justify-center rounded-full bg-surface-sunken text-ink-muted ring-1 ring-inset ring-line [&>svg]:h-5 [&>svg]:w-5"
        >
          {icon}
        </span>
      )}
      <p className="max-w-md text-sm leading-6 text-ink-muted">{message}</p>
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}

/** Error block with an optional retry. Carries role="alert" for assistive tech. */
export function ErrorState({
  message = 'Something went wrong.',
  onRetry,
}: {
  message?: ReactNode;
  onRetry?: () => void;
}) {
  return (
    <div role="alert" className="flex flex-col items-center justify-center gap-3 px-4 py-12 text-center">
      <p className="max-w-md text-sm leading-6 text-critical">{message}</p>
      {onRetry && (
        <Button size="sm" variant="secondary" onClick={onRetry}>
          Retry
        </Button>
      )}
    </div>
  );
}

