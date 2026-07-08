import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cn } from '../../lib/cn';
import { IconSpinner } from './icons';

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';
export type ButtonSize = 'sm' | 'md' | 'lg';

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-brand-600 text-white shadow-sm hover:bg-brand-700 hover:shadow-md',
  secondary: 'border border-line bg-surface-card text-ink-strong shadow-sm hover:border-line-strong hover:bg-surface-raised',
  danger: 'border border-critical/30 bg-critical-bg text-critical shadow-sm hover:bg-critical/10',
  ghost: 'text-ink hover:bg-surface-sunken hover:text-ink-strong',
};

const SIZES: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-xs',
  md: 'h-9 px-4 text-sm',
  lg: 'h-11 px-5 text-base',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
}

/** Canonical button — every CTA uses this; brand-red `primary` is the reference default. */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', size = 'md', loading = false, className, children, disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-md font-medium transition-colors',
        'focus-ring active:translate-y-px',
        'disabled:cursor-not-allowed disabled:opacity-60',
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...rest}
    >
      {loading && <IconSpinner className="h-4 w-4 animate-spin" />}
      {children}
    </button>
  );
});

