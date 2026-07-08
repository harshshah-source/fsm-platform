import { useEffect, type ReactNode } from 'react';
import { cn } from '../../lib/cn';

/**
 * Centered modal dialog (hand-rolled). role="dialog" + aria-modal, Escape + backdrop close. Replaces
 * `window.prompt`-style flows in later FE slices.
 */
export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  className,
}: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-chrome-900/45 backdrop-blur-sm" aria-hidden onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : undefined}
        className={cn(
          'relative z-10 w-full max-w-md rounded-card border border-line bg-surface-card shadow-floating',
          className,
        )}
      >
        {title && (
          <div className="border-b border-line bg-surface-raised/70 px-5 py-3.5 text-sm font-semibold tracking-tight text-ink-strong">
            {title}
          </div>
        )}
        <div className="p-5">{children}</div>
        {footer && (
          <div className="flex justify-end gap-2 border-t border-line bg-surface-raised/70 px-5 py-3.5">{footer}</div>
        )}
      </div>
    </div>
  );
}

