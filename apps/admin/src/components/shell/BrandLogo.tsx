import { cn } from '../../lib/cn';

/**
 * AutoPlant wordmark, reproduced from the legacy reference (docs/ui/desktop/v1-legacy/01-dashboard.png):
 * red "autoplant Systems" lockup over a letter-spaced "FIELD MANAGEMENT SYSTEM" caption, on a white
 * band.
 *
 * Colour, casing, weight and proportions are pinned to the reference — do not restyle without a new
 * reference image.
 */
export function BrandLogo({ className }: { className?: string }) {
  return (
    <div className={cn('select-none overflow-hidden leading-none', className)}>
      <div className="whitespace-nowrap text-[1.0625rem] font-bold leading-none tracking-[-0.01em] text-brand-logo">
        autoplant Systems
      </div>
      <div className="mt-1 whitespace-nowrap text-[0.625rem] font-semibold uppercase leading-none tracking-[0.14em] text-ink-caps">
        Field Management System
      </div>
    </div>
  );
}
