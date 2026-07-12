import { cn } from '../../lib/cn';
import { formatPlantDisplayName, resolvePlantName } from '../../lib/plantNames';

/**
 * Plant label — the single presentation of an AutoPlant plant identifier across the admin UI.
 * Renders the mapped full name with the original AutoPlant code kept visible (Operations / Support /
 * DB teams still need it); an unmapped or name-style identifier renders verbatim on one line. The
 * mapping + resolution live in `lib/plantNames` (one source of truth) — this component only styles.
 *
 * Display-only: `plantId` remains the key/filter/group/route everywhere; this never carries an id.
 *
 * - `variant="stacked"` (default): full name on line 1, code on a muted mono line below — the scan-
 *   friendly form for tables and cards. Reuses the existing ID convention (`font-mono text-xs
 *   text-ink-muted`, as used for ticket/request ids).
 * - `variant="inline"`: full name followed by the muted mono code on the same line — for tight
 *   inline contexts (a flex header row beside a badge) where a second line would break the layout.
 *
 * A native `title` tooltip always exposes `FULL NAME (CODE)` so both values are reachable even if the
 * line wraps or truncates. Long names wrap (no `whitespace-nowrap`); callers own their empty state.
 */
export function PlantName({
  code,
  variant = 'stacked',
  className,
}: {
  code: string | null | undefined;
  variant?: 'stacked' | 'inline';
  className?: string;
}) {
  const { full, id } = resolvePlantName(code);
  const title = formatPlantDisplayName(code) || undefined;

  // Unmapped or blank — the identifier is the only label we have; show it as-is (one line).
  if (!full) {
    return (
      <span className={className} title={title}>
        {id}
      </span>
    );
  }

  if (variant === 'inline') {
    return (
      <span className={className} title={title}>
        {full} <span className="font-mono font-normal text-ink-muted">{id}</span>
      </span>
    );
  }

  return (
    <span className={cn('block', className)} title={title}>
      <span className="block">{full}</span>
      <span className="mt-0.5 block font-mono text-xs font-normal text-ink-muted">{id}</span>
    </span>
  );
}
