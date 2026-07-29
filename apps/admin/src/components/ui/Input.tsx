import { forwardRef, type InputHTMLAttributes, type ReactNode } from 'react';
import { cn } from '../../lib/cn';

/** Canonical text input. Pair with `Field` (or a bespoke label) for accessible labelling. */
export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...rest }, ref) {
    return (
      <input
        ref={ref}
        className={cn(
          'h-10 w-full rounded-md border border-line bg-surface-card px-3 text-sm text-ink-strong shadow-sm transition-[background-color,border-color,box-shadow]',
          'placeholder:text-ink-muted hover:border-line-strong hover:bg-surface-raised focus-visible:border-brand-600 focus-ring',
          'disabled:cursor-not-allowed disabled:opacity-60',
          className,
        )}
        {...rest}
      />
    );
  },
);

/** Label + control wrapper for form rows. */
export function Field({
  label,
  htmlFor,
  children,
  className,
}: {
  label: ReactNode;
  htmlFor?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <label htmlFor={htmlFor} className="text-xs font-semibold text-ink-muted">
        {label}
      </label>
      {children}
    </div>
  );
}
