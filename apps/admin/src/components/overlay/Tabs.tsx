import { createContext, useContext, useId, type ReactNode } from 'react';
import { cn } from '../../lib/cn';

interface TabsCtx {
  value: string;
  setValue: (v: string) => void;
  idBase: string;
}
const Ctx = createContext<TabsCtx | null>(null);

function useTabs(): TabsCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('Tab/TabList/TabPanel must be used within <Tabs>');
  return c;
}

/** Controlled tab group. Hand-rolled (no Radix); emits the WAI-ARIA tab roles consumed by the tests. */
export function Tabs({
  value,
  onValueChange,
  children,
  className,
}: {
  value: string;
  onValueChange: (v: string) => void;
  children: ReactNode;
  className?: string;
}) {
  const idBase = useId();
  return (
    <Ctx.Provider value={{ value, setValue: onValueChange, idBase }}>
      <div className={className}>{children}</div>
    </Ctx.Provider>
  );
}

export function TabList({
  children,
  className,
  'aria-label': ariaLabel,
}: {
  children: ReactNode;
  className?: string;
  'aria-label'?: string;
}) {
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className={cn('flex flex-wrap gap-1 border-b border-line', className)}
    >
      {children}
    </div>
  );
}

export function Tab({ value, children }: { value: string; children: ReactNode }) {
  const ctx = useTabs();
  const selected = ctx.value === value;
  return (
    <button
      role="tab"
      type="button"
      id={`${ctx.idBase}-tab-${value}`}
      aria-selected={selected}
      aria-controls={`${ctx.idBase}-panel-${value}`}
      onClick={() => ctx.setValue(value)}
      className={cn(
        'px-3 py-1.5 text-sm transition-colors',
        selected
          ? 'border-b-2 border-brand-600 font-medium text-ink-strong'
          : 'border-b-2 border-transparent text-ink-muted hover:text-ink-strong',
      )}
    >
      {children}
    </button>
  );
}

export function TabPanel({
  value,
  children,
  className,
}: {
  value: string;
  children: ReactNode;
  className?: string;
}) {
  const ctx = useTabs();
  if (ctx.value !== value) return null;
  return (
    <div
      role="tabpanel"
      id={`${ctx.idBase}-panel-${value}`}
      aria-labelledby={`${ctx.idBase}-tab-${value}`}
      className={className}
    >
      {children}
    </div>
  );
}
