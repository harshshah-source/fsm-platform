import { forwardRef, type SelectHTMLAttributes } from 'react';
import { cn } from '../../lib/cn';
import { IconChevronRight } from './icons';

/**
 * Canonical `<select>` — the sibling of `Input`, sharing its height, radius, border, hover and focus
 * treatment so a form row of mixed controls reads as one line rather than three different widgets.
 *
 * Stays a native select (keyboard, mobile pickers and assistive tech all come free); only the arrow is
 * ours, so the control looks identical across platforms. The wrapper is `display:block`, which keeps
 * implicit `<label>` association intact for callers that wrap the control in a label.
 */
export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  function Select({ className, children, ...rest }, ref) {
    return (
      <span className="relative block">
        <select
          ref={ref}
          className={cn(
            'h-10 w-full appearance-none rounded-md border border-line bg-surface-card px-3 pr-9 text-sm text-ink-strong shadow-sm transition-[background-color,border-color,box-shadow]',
            'hover:border-line-strong hover:bg-surface-raised focus-visible:border-brand-600 focus-ring',
            'disabled:cursor-not-allowed disabled:opacity-60',
            className,
          )}
          {...rest}
        >
          {children}
        </select>
        <IconChevronRight
          aria-hidden
          className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 rotate-90 text-ink-muted"
        />
      </span>
    );
  },
);
