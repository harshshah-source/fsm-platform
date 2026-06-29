import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

/**
 * Report section grid (FE-21) — the 2-up responsive layout that pairs report `ChartCard`s on the
 * Reports landing. Pure composition: it owns only the grid rhythm so report pages compose panels
 * without repeating the grid classes. Collapses to a single column below `lg`.
 */
export function ReportGrid({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('mb-5 grid gap-4 lg:grid-cols-2', className)}>{children}</div>;
}
