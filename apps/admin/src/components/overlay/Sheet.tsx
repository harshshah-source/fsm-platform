import { useEffect, type ReactNode } from 'react';
import { cn } from '../../lib/cn';

/**
 * Slide-over panel / drawer (hand-rolled). role="dialog" + aria-modal, Escape + backdrop close. The
 * Ticket Detail drawer (FE-09) is built on this.
 */
export function Sheet({
  open,
  onClose,
  title,
  children,
  footer,
  side = 'right',
  widthClass = 'w-[440px] max-w-[92vw]',
  ariaLabel,
}: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  side?: 'right' | 'left';
  widthClass?: string;
  ariaLabel?: string;
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
    <div className="fixed inset-0 z-40">
      <div className="absolute inset-0 bg-chrome-900/50 backdrop-blur-md" aria-hidden onClick={onClose} />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel ?? (typeof title === 'string' ? title : undefined)}
        className={cn(
          'absolute inset-y-0 flex flex-col border-line bg-surface-card shadow-floating ring-1 ring-line/80',
          side === 'right' ? 'right-0' : 'left-0',
          widthClass,
        )}
      >
        <div className="flex items-center justify-between border-b border-line bg-gradient-to-r from-surface-raised via-surface-card to-luxury-100/45 px-5 py-4">
          <h3 className="text-base font-semibold text-ink-strong">{title}</h3>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="rounded-md p-1.5 text-ink-muted hover:bg-luxury-100 hover:text-ink-strong focus-ring"
          >
            ✕
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-5 sm:p-6">{children}</div>
        {footer && <div className="border-t border-line bg-surface-raised/80 p-5">{footer}</div>}
      </aside>
    </div>
  );
}
