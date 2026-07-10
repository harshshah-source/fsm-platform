import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '../../lib/cn';

/** White surface with subtle border + shadow — the base of every content block. */
export function Card({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('premium-panel rounded-card border border-line/90 transition-[box-shadow,transform,border-color] duration-200 hover:border-line-strong hover:shadow-card-hover', className)}
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
        <div className="flex items-center justify-between gap-3 border-b border-line bg-gradient-to-r from-surface-raised via-surface-card to-luxury-100/45 px-5 py-4">
          {typeof title === 'string' ? (
            <h3 className="text-[0.82rem] font-semibold text-ink-strong">{title}</h3>
          ) : (
            title
          )}
          {action}
        </div>
      )}
      <div className={cn('p-5 sm:p-6', bodyClassName)}>{children}</div>
    </Card>
  );
}
