import { useEffect, useId, useRef, useState } from 'react';
import { cn } from '../../lib/cn';
import { familyLabel, kpiDef } from '../../lib/kpiCatalog';
import { IconHelp } from '../ui/icons';

/**
 * The info affordance beside every KPI and every counted table column — the "what exactly is in this
 * number?" answer, in place.
 *
 * Content comes from `lib/kpiCatalog`, so the tooltip, the KPI reference page and
 * `docs/kpi-definitions.md` all state the same thing. Each panel gives: the business definition, what
 * is counted, what is EXCLUDED (the half an operator cannot infer from a label), the source table, the
 * refresh trigger, the formula, and — where one exists — the identity the figure reconciles into.
 *
 * Opens on hover and on focus, and latches open on click so the panel can be read (and its text
 * selected) without keeping the pointer still. Escape or an outside click closes a latched panel;
 * `aria-describedby` ties it to the trigger, so screen readers get it as the button's description
 * rather than as loose text. Built on plain state rather than a popover library to match the
 * zero-dependency house style of `components/ui/icons.tsx`.
 */
export function KpiInfo({
  kpi,
  className,
  /** Visual weight — `muted` on dark KPI cards where the default ink is too heavy. */
  tone = 'default',
}: {
  /** A key from `KPI_CATALOG`. An unknown key renders nothing rather than an empty tooltip. */
  kpi: string;
  className?: string;
  tone?: 'default' | 'muted';
}) {
  const def = kpiDef(kpi);
  const [hovered, setHovered] = useState(false);
  const [latched, setLatched] = useState(false);
  const panelId = useId();
  const wrapRef = useRef<HTMLSpanElement>(null);

  const open = hovered || latched;

  // A latched panel closes on Escape or on a click anywhere outside it — the same dismissal contract
  // as the app's other transient surfaces (ExportMenu, the notification tray).
  useEffect(() => {
    if (!latched) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setLatched(false);
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setLatched(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [latched]);

  if (!def) return null;

  return (
    <span ref={wrapRef} className={cn('relative inline-flex', className)}>
      <button
        type="button"
        data-testid={`kpi-info-${def.key}`}
        aria-label={`About ${def.name}`}
        aria-expanded={open}
        aria-describedby={open ? panelId : undefined}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onFocus={() => setHovered(true)}
        onBlur={() => setHovered(false)}
        onClick={(e) => {
          e.stopPropagation();
          setLatched((v) => !v);
        }}
        className={cn(
          'inline-flex items-center justify-center rounded-full transition-colors focus-ring',
          tone === 'muted' ? 'text-white/40 hover:text-white/80' : 'text-ink-muted hover:text-ink-strong',
        )}
      >
        <IconHelp className="h-3.5 w-3.5" />
      </button>

      {open && (
        <span
          id={panelId}
          role="tooltip"
          // Left-anchored and clamped to the viewport width on small screens; z-50 clears the sticky
          // table headers and the hero's glass cards.
          className="absolute left-0 top-full z-50 mt-1.5 block w-[min(22rem,calc(100vw-2rem))] cursor-default rounded-card border border-line bg-surface-card p-3 text-left shadow-card-hover"
          onClick={(e) => e.stopPropagation()}
        >
          <span className="block text-[13px] font-bold text-ink-strong">{def.name}</span>
          <span className="mt-0.5 block text-[10px] font-semibold uppercase tracking-wider text-ink-caps">
            {familyLabel(def.family)}
          </span>
          <span className="mt-2 block text-xs leading-relaxed text-ink">{def.definition}</span>

          <Row label="Counts">{def.counts}</Row>

          <span className="mt-2 block">
            <span className="block text-[10px] font-semibold uppercase tracking-wider text-ink-caps">Excludes</span>
            <span className="mt-0.5 block space-y-0.5">
              {def.excludes.map((x) => (
                <span key={x} className="flex gap-1.5 text-xs leading-relaxed text-ink-muted">
                  <span aria-hidden>·</span>
                  <span>{x}</span>
                </span>
              ))}
            </span>
          </span>

          <Row label="Source">{def.source}</Row>
          <Row label="Refresh">{def.refresh}</Row>

          <span className="mt-2 block">
            <span className="block text-[10px] font-semibold uppercase tracking-wider text-ink-caps">Formula</span>
            <code className="mt-0.5 block break-words rounded bg-surface-sunken px-1.5 py-1 font-mono text-[11px] leading-relaxed text-ink">
              {def.formula}
            </code>
          </span>

          {def.reconciles && <Row label="Reconciles with">{def.reconciles}</Row>}
        </span>
      )}
    </span>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <span className="mt-2 block">
      <span className="block text-[10px] font-semibold uppercase tracking-wider text-ink-caps">{label}</span>
      <span className="mt-0.5 block text-xs leading-relaxed text-ink-muted">{children}</span>
    </span>
  );
}

/**
 * A table column header with its KPI definition attached — the column-level equivalent of the KPI
 * card's info button. Kept here so a header and a card describing the same figure are guaranteed to
 * cite the same catalog entry.
 *
 * `min-w-0` + `break-words` on the label let it shrink and wrap inside a narrow `table-fixed` column
 * instead of forcing its natural (unbreakable) width — without them a flex child never shrinks below
 * its longest word, so a multi-word label like "Inactive Operational" overflowed its cell and visually
 * overlapped the info icon sitting beside it (the bug reported on the Company/Plant Overview table).
 *
 * `stacked` puts the icon on its own line below the label instead of beside it, for columns narrow
 * enough that even a wrapped label leaves no safe row for the icon to share (the dense Company/Plant
 * Overview table, which packs 12+ columns into the viewport). This makes horizontal overlap impossible
 * regardless of column width, since the icon is never on the same line as the text.
 */
export function ColumnHeader({
  label,
  kpi,
  align = 'right',
  stacked = false,
}: {
  label: string;
  kpi: string;
  align?: 'left' | 'right';
  stacked?: boolean;
}) {
  return (
    <span
      className={cn(
        'inline-flex min-w-0 gap-1',
        stacked
          // Column: the main axis is vertical, so alignment is cross-axis (`items-*`).
          ? ['flex-col', align === 'right' ? 'items-end' : 'items-start']
          // Row: the main axis is horizontal, so alignment is main-axis (`justify-*`); vertically
          // centered against the icon.
          : ['items-center', align === 'right' && 'justify-end'],
      )}
    >
      <span className="min-w-0 break-words">{label}</span>
      <KpiInfo kpi={kpi} />
    </span>
  );
}
