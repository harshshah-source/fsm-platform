import { cn } from '../../lib/cn';

/**
 * AutoPlant wordmark: red "autoplant Systems" lockup over a letter-spaced "FIELD MANAGEMENT SYSTEM"
 * caption. Wordmark colour/casing/weight are pinned to the legacy lockup
 * (docs/ui/desktop/v1-legacy/01-dashboard.png); it now sits on the dark sidebar rail per the
 * 2026-07 reference (docs/ui/desktop/uiDashboardRef.jpg), so the caption uses the chrome-muted gray.
 */
export function BrandLogo({ className }: { className?: string }) {
  return (
    <div className={cn('select-none overflow-hidden leading-none', className)}>
      <div className="whitespace-nowrap text-[1.0625rem] font-bold leading-none tracking-[-0.01em] text-brand-logo">
        autoplant Systems
      </div>
      <div className="mt-1 whitespace-nowrap text-[0.625rem] font-semibold uppercase leading-none tracking-[0.14em] text-chrome-muted">
        Field Management System
      </div>
    </div>
  );
}
