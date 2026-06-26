import type { ReactNode } from 'react';
import { SectionCard } from '../ui/Card';

/** Card wrapper for a chart — a `SectionCard` with a caps title and chart body. */
export function ChartCard({
  title,
  action,
  children,
  className,
}: {
  title?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <SectionCard title={title} action={action} className={className}>
      {children}
    </SectionCard>
  );
}
