import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react';
import { cn } from '../../lib/cn';
import { IconSearch } from '../ui/icons';

/** Horizontal container for filter controls above a table. */
export function FilterBar({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('mb-4 flex flex-wrap items-center gap-2 rounded-card border border-line bg-surface-card p-2 shadow-card', className)}>{children}</div>;
}

/** Rounded search input with a leading icon. */
export function SearchInput({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div className="relative">
      <IconSearch className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-muted" />
      <input
        className={cn(
          'h-9 w-56 rounded-md border border-line bg-surface-card pl-9 pr-3 text-sm text-ink-strong shadow-sm transition-colors',
          'placeholder:text-ink-muted hover:border-line-strong focus-visible:border-brand-600 focus-ring',
          className,
        )}
        {...rest}
      />
    </div>
  );
}

/** Styled native select for filters. */
export function FilterSelect({ className, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cn(
        'h-9 rounded-md border border-line bg-surface-card px-2 text-sm text-ink-strong shadow-sm transition-colors',
        'hover:border-line-strong focus-visible:border-brand-600 focus-ring',
        className,
      )}
      {...rest}
    />
  );
}

