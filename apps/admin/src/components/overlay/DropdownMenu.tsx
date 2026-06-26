import { useEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from '../../lib/cn';

export interface MenuItem {
  label: ReactNode;
  onSelect: () => void;
  tone?: 'default' | 'danger';
  disabled?: boolean;
}

/**
 * Hand-rolled dropdown menu (no Radix). `trigger` is rendered inside the menu button; outside click /
 * Escape closes. Emits menu + menuitem roles. Used for row actions and the user menu.
 */
export function DropdownMenu({
  trigger,
  items,
  align = 'right',
  className,
  'aria-label': ariaLabel,
}: {
  trigger: ReactNode;
  items: MenuItem[];
  align?: 'right' | 'left';
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

  return (
    <div ref={ref} className={cn('relative', className)}>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center rounded-md text-ink-muted hover:text-ink-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600/40"
      >
        {trigger}
      </button>
      {open && (
        <ul
          role="menu"
          className={cn(
            'absolute z-20 mt-1 min-w-44 rounded-md border border-line bg-surface-card py-1 shadow-md',
            align === 'right' ? 'right-0' : 'left-0',
          )}
        >
          {items.map((it, i) => (
            <li key={i} role="none">
              <button
                role="menuitem"
                type="button"
                disabled={it.disabled}
                onClick={() => {
                  it.onSelect();
                  setOpen(false);
                }}
                className={cn(
                  'flex w-full items-center px-3 py-1.5 text-left text-sm hover:bg-surface-sunken disabled:cursor-not-allowed disabled:opacity-50',
                  it.tone === 'danger' ? 'text-critical' : 'text-ink-strong',
                )}
              >
                {it.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
