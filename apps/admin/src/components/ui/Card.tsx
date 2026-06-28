import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '../../lib/cn';

/** White surface with subtle border + shadow — the base of every content block. */
export function Card({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('rounded-card border border-line bg-surface-card shadow-sm', className)}
      {...rest}
    />
  );
}

/** Card with a caps/section header row and optional right-aligned action. */
export function SectionCard({
  title,
  action,
  children,
  className,
  bodyClassName,
}: {
  title?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <Card className={className}>
      {(title || action) && (
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          {typeof title === 'string' ? (
            <h3 className="text-sm font-semibold text-ink-strong">{title}</h3>
          ) : (
            title
          )}
          {action}
        </div>
      )}
      <div className={cn('p-4', bodyClassName)}>{children}</div>
    </Card>
  );
}
