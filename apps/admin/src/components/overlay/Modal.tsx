import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../../lib/cn';

/**
 * Centered modal dialog (hand-rolled). role="dialog" + aria-modal, Escape + backdrop close. Replaces
 * `window.prompt`-style flows in later FE slices.
 *
 * **Portalled to `document.body`, and it has to be.** `position: fixed` resolves against the nearest
 * ancestor with a transform, not the viewport — and every page in this app is wrapped in
 * `.animate-page-in`, whose `page-in` keyframes end on a `translateY` that `animation-fill-mode: both`
 * leaves applied for good. So an in-tree overlay is sized and centred inside *the page*, not the
 * screen. On short pages the two are near enough to be indistinguishable, which is why this went
 * unnoticed; on the Scheduler Console, whose deck runs to ~4,800px, the dialog centred itself roughly
 * 2,100px below the fold — the exact off-screen failure the Console adopted a modal to escape. The
 * portal takes the overlay out from under every page transform there is.
 */
export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  className,
  bodyClassName,
}: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
  /**
   * Overrides the body's default padding. A caller whose content brings its own frame — a header row
   * and its own scroll region, say — passes `p-0` and lays the panel out itself.
   */
  bodyClassName?: string;
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

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-chrome-900/50 backdrop-blur-md" aria-hidden onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : undefined}
        className={cn(
          'premium-panel relative z-10 w-full max-w-md rounded-card border border-line shadow-floating',
          className,
        )}
      >
        {title && (
          <div className="border-b border-line bg-gradient-to-r from-surface-raised via-surface-card to-luxury-100/45 px-5 py-4 text-sm font-semibold text-ink-strong">
            {title}
          </div>
        )}
        <div className={cn('p-5 sm:p-6', bodyClassName)}>{children}</div>
        {footer && (
          <div className="flex justify-end gap-2 border-t border-line bg-surface-raised/80 px-5 py-4">{footer}</div>
        )}
      </div>
    </div>,
    document.body,
  );
}
