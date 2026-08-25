import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';
import { cn } from '../../lib/cn';
import type { BadgeTone } from '../ui/Badge';

/** The tones a toast can carry — the notification-shaped subset of {@link BadgeTone}. */
export type ToastTone = Extract<
  BadgeTone,
  'info' | 'success' | 'verified' | 'warning' | 'critical' | 'neutral' | 'brand'
>;

interface ToastItem {
  id: number;
  tone: ToastTone;
  message: ReactNode;
}

interface ToastApi {
  push: (message: ReactNode, tone?: ToastTone) => void;
  success: (message: ReactNode) => void;
  error: (message: ReactNode) => void;
}

const ToastCtx = createContext<ToastApi | null>(null);

/**
 * A toast's tone is a **subset** of `BadgeTone`, and says so.
 *
 * #290 added `tierCross` — a chip meaning on the assign board — and a `Record<BadgeTone, …>` here
 * forced this file to invent a toast style for it. A tier crossing is never announced as a toast, so
 * the honest fix is to narrow the type rather than to fabricate an entry: every tone below is one a
 * toast can actually carry, and adding a chip meaning no longer drags a notification style behind it.
 */
const TONE_CLASS: Record<ToastTone, string> = {
  info: 'border-info/30 bg-info-bg text-info',
  success: 'border-success/30 bg-success-bg text-success',
  verified: 'border-verified/30 bg-verified-bg text-verified',
  warning: 'border-warning/30 bg-warning-bg text-warning',
  critical: 'border-critical/30 bg-critical-bg text-critical',
  neutral: 'border-line bg-surface-card text-ink-strong',
  brand: 'border-brand-600/30 bg-brand-300 text-brand-700',
};

/** App-level toast host. Mount once near the root; consume with `useToast`. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const remove = useCallback((id: number) => setItems((s) => s.filter((t) => t.id !== id)), []);

  const push = useCallback(
    (message: ReactNode, tone: ToastTone = 'neutral') => {
      const id = nextId.current++;
      setItems((s) => [...s, { id, tone, message }]);
      setTimeout(() => remove(id), 4000);
    },
    [remove],
  );

  const api: ToastApi = {
    push,
    success: (m) => push(m, 'success'),
    error: (m) => push(m, 'critical'),
  };

  return (
    <ToastCtx.Provider value={api}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex flex-col gap-2">
        {items.map((t) => (
          <div
            key={t.id}
            role="status"
            className={cn(
              'pointer-events-auto min-w-56 rounded-md border px-3 py-2 text-sm shadow-md',
              TONE_CLASS[t.tone],
            )}
          >
            {t.message}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastCtx);
  if (!ctx) {
    throw new Error('useToast must be used within a ToastProvider');
  }
  return ctx;
}

/**
 * Non-throwing toast accessor — returns `null` when no `ToastProvider` is mounted. For widgets that
 * should still function (and never crash their host page) when rendered without a toast host, e.g. in
 * isolation tests; the real app always mounts `ToastProvider` near the root.
 */
export function useToastOptional(): ToastApi | null {
  return useContext(ToastCtx);
}
