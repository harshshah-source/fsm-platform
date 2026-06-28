import { useEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from '../../lib/cn';

export interface SelectOption {
  value: string;
  label: ReactNode;
}

/**
 * Hand-rolled combobox/listbox select (no Radix). Button toggles a listbox; click selects; outside
 * click / Escape closes. Emits combobox + listbox + option roles. For plain filter selects the styled
 * native `FilterSelect` is usually enough; use this where the trigger needs custom content.
 */
export function Select({
  value,
  onChange,
  options,
  placeholder = 'Select…',
  className,
  'aria-label': ariaLabel,
}: {
  value: string | null;
  onChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  className?: string;
  'aria-label'?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const current = options.find((o) => o.value === value);

  return (
    <div ref={ref} className={cn('relative', className)}>
      <button
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => setOpen((o) => !o)}
        className="flex h-9 min-w-40 items-center gap-2 rounded-md border border-line bg-surface-card px-3 text-sm text-ink-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600/40"
      >
        <span className={cn(!current && 'text-ink-muted')}>{current?.label ?? placeholder}</span>
        <span aria-hidden className="ml-auto text-ink-muted">
          ▾
        </span>
      </button>
      {open && (
        <ul
          role="listbox"
          className="absolute z-20 mt-1 max-h-60 min-w-full overflow-auto rounded-md border border-line bg-surface-card py-1 shadow-md"
        >
          {options.map((o) => (
            <li
              key={o.value}
              role="option"
              aria-selected={o.value === value}
              onClick={() => {
                onChange(o.value);
                setOpen(false);
              }}
              className={cn(
                'cursor-pointer px-3 py-1.5 text-sm hover:bg-surface-sunken',
                o.value === value && 'font-medium text-brand-700',
              )}
            >
              {o.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
