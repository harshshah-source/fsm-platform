import { useEffect, useId, useRef, useState } from 'react';
import { cn } from '../../lib/cn';
import { IconHelp } from '../../components/ui/icons';
import { Badge } from '../../components/ui';
import type { ExplorerColumn, SourceSystem } from '../../api/opsExplorer';

const SYSTEM_LABEL: Record<SourceSystem, string> = {
  FSM_POSTGRES: 'FSM · Postgres',
  AUTOPLANT_MYSQL: 'AutoPlant · MySQL',
  DERIVED: 'Derived',
};

const SYSTEM_TONE: Record<SourceSystem, 'brand' | 'info' | 'neutral'> = {
  FSM_POSTGRES: 'brand',
  AUTOPLANT_MYSQL: 'info',
  DERIVED: 'neutral',
};

/**
 * The per-column "where does this come from?" affordance in the explorer's table header.
 *
 * Modelled on `KpiInfo` — same hover-or-focus-to-open, click-to-latch, Escape-or-outside-click-to-close
 * contract, so the two info affordances in the product behave identically. It is a separate component
 * rather than a `KpiInfo` variant because the content is genuinely different: `KpiInfo` reads a
 * hand-written FE catalog keyed by KPI, while this renders whatever the *server's* registry says about
 * this column. That difference is the point of the feature — the answer comes from the same object the
 * query was built from, so it cannot drift from the number beside it.
 *
 * The developer half renders only when the server sent it (`lineage.developer` present, i.e. Developer
 * Mode). There is no client-side flag: if the field is absent, there is nothing to hide.
 */
export function ColumnSource({ column }: { column: ExplorerColumn }) {
  const [hovered, setHovered] = useState(false);
  const [latched, setLatched] = useState(false);
  const panelId = useId();
  const wrapRef = useRef<HTMLSpanElement>(null);
  const open = hovered || latched;
  const dev = column.lineage.developer;

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

  return (
    <span ref={wrapRef} className="relative inline-flex" data-export-skip="">
      <button
        type="button"
        aria-label={`Source of ${column.label}`}
        aria-describedby={open ? panelId : undefined}
        data-testid={`ops-explorer-source-${column.key}`}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onFocus={() => setHovered(true)}
        onBlur={() => setHovered(false)}
        onClick={(e) => {
          // Header cells toggle sort on click; the info button must not also re-sort the table.
          e.stopPropagation();
          setLatched((l) => !l);
        }}
        className="ml-1 inline-flex h-4 w-4 items-center justify-center rounded-full text-white/60 transition-colors hover:text-white focus-ring"
      >
        <IconHelp className="h-3.5 w-3.5" />
      </button>

      {open && (
        <span
          id={panelId}
          role="tooltip"
          onClick={(e) => e.stopPropagation()}
          className={cn(
            'absolute left-0 top-6 z-50 block w-[26rem] max-w-[80vw] cursor-auto space-y-2 rounded-card border border-line',
            'bg-surface-card p-3 text-left text-[11px] normal-case tracking-normal text-ink shadow-floating',
          )}
        >
          <span className="flex items-center gap-2">
            <strong className="text-xs font-semibold text-ink-strong">{column.label}</strong>
            <Badge tone={SYSTEM_TONE[column.lineage.system]}>{SYSTEM_LABEL[column.lineage.system]}</Badge>
          </span>

          <Row label="Means">{column.lineage.definition}</Row>
          <Row label="Source table">
            <code className="font-mono text-[10.5px]">{column.lineage.table}</code>
          </Row>
          <Row label="Refreshed by">{column.lineage.refreshTrigger}</Row>

          {column.lineage.excludes && column.lineage.excludes.length > 0 && (
            <Row label="Does NOT include">
              <span className="block space-y-1">
                {column.lineage.excludes.map((x) => (
                  <span key={x} className="block">
                    • {x}
                  </span>
                ))}
              </span>
            </Row>
          )}

          {dev && (
            <span className="block space-y-2 border-t border-line pt-2">
              <span className="block text-[10px] font-semibold uppercase tracking-wider text-brand-700">
                Developer mode
              </span>
              {dev.column && (
                <Row label="Column">
                  <code className="font-mono text-[10.5px]">{dev.column}</code>
                </Row>
              )}
              <Row label="Selected as">
                <code className="font-mono text-[10.5px]">{dev.expression}</code>
              </Row>
              {dev.formula && (
                <Row label="Formula">
                  <code className="font-mono text-[10.5px]">{dev.formula}</code>
                </Row>
              )}
              {dev.ownedBy && <Row label="Owned by">{dev.ownedBy}</Row>}
            </span>
          )}
        </span>
      )}
    </span>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <span className="block">
      <span className="block text-[10px] font-semibold uppercase tracking-wider text-ink-muted">{label}</span>
      <span className="block text-[11px] leading-snug text-ink">{children}</span>
    </span>
  );
}
