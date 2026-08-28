import type { TodayTicket } from '../../../api/dispatchToday';
import { cn } from '../../../lib/cn';
import type { Selection } from './selection';

/**
 * **The work chip and its grammar** (composition correction §7.3, approved as D11).
 *
 * Four independent channels, four meanings, no overlap — and every one survives grayscale:
 *
 * | Channel            | Carries                                  |
 * |--------------------|------------------------------------------|
 * | chip BORDER STYLE  | provenance — solid+dot = the engine · dashed = a human · dashed violet =
 * |                    | a human crossed a coverage tier · dotted = not recorded |
 * | inline TOKENS      | urgency (`CRIT`), vehicle return (`RET`), chronic device (`CHR ×n`) |
 * | chip FILL          | operational state — **reserved**: needs the day-scoped board read (D13),
 * |                    | which is deferred, so no fill claims anything yet |
 * | CELL treatment     | capacity — an amber cell means the engineer is at/over capacity (BoardGrid) |
 *
 * **Urgency became a token, and that is the fix for the field-ops P0.** The old grammar drew
 * critical work as a heavy crimson *border* — but only on the `systemPlaced` branch, so a critical
 * ticket a human assigned lost its urgency mark the moment it was reassigned. A token renders on
 * every chip regardless of who placed it, and frees the border to carry provenance alone.
 *
 * The provenance rule about absence is inherited unchanged (#282 R2 · #283): a ticket written before
 * provenance tracking carries `addSource: null`, and unknown is drawn as *unknown* — the dotted
 * treatment, which reads as neither a system decision nor a human one. Drawing it solid would be the
 * single lie this grammar exists to prevent.
 */
function provenanceTreatment(t: TodayTicket): { className: string; title: string } {
  if (t.addSource == null) {
    return {
      className: 'border border-dotted border-line text-ink-muted',
      title: 'Provenance not recorded — this assignment predates provenance tracking',
    };
  }
  if (t.systemPlaced) {
    return { className: 'border border-line text-ink', title: 'System decision' };
  }
  // A human. Dashed always; violet when they crossed a coverage tier — the case #272 R6 permits
  // and requires be marked.
  const crossed = t.coverageTypeAtAssign === 'FLOATING' || t.coverageTypeAtAssign === 'NONE';
  return {
    className: crossed
      ? 'border border-dashed border-tier-cross text-tier-cross'
      : 'border border-dashed border-ink-muted text-ink',
    title: crossed ? `Human override — coverage at assign: ${t.coverageTypeAtAssign}` : 'Human override',
  };
}

const CRITICAL_BUCKETS = new Set(['CRITICAL', 'HIGH_CRITICAL']);

/** The inline-token idiom shared by CRIT / RET / CHR — words and numbers, never a hue-only mark. */
function Token({
  label,
  title,
  testId,
  critical,
}: {
  label: string;
  title: string;
  testId?: string;
  critical?: boolean;
}) {
  return (
    <span
      data-testid={testId}
      className={cn(
        'rounded px-1 text-[9px] font-bold tracking-wide',
        critical ? 'bg-critical-bg text-critical' : 'bg-surface-sunken',
      )}
      title={title}
    >
      {label}
    </span>
  );
}

export interface ChipDragPayload {
  type: 'ticket' | 'stop' | 'pool';
  ticketId?: string;
  batchId?: string;
  fromSeId?: string;
}

export const DRAG_MIME = 'application/x-console-drag';

/**
 * A committed ticket on today's board. Selection adds a ring, never a border style — the border
 * grammar already carries provenance and has to survive grayscale.
 *
 * Draggable when `draggable` — but a drag **initiates** the authoritative dialog, prefilled; it
 * never commits on release (correction §12, D10).
 */
export function WorkChip({
  ticket,
  selected,
  onSelect,
  chronicThreshold,
  draggable,
  dragPayload,
  onDragChange,
}: {
  ticket: TodayTicket;
  selected?: boolean;
  onSelect?: (sel: Selection) => void;
  /** From the payload, never hard-coded — the server owns the rule (#244's precedent). */
  chronicThreshold: number;
  draggable?: boolean;
  dragPayload?: ChipDragPayload;
  onDragChange?: (payload: ChipDragPayload | null) => void;
}) {
  const { className, title } = provenanceTreatment(ticket);
  const critical = CRITICAL_BUCKETS.has(ticket.slaBucket ?? '');
  const shared = cn(
    'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] tabular-nums',
    className,
    selected && 'ring-2 ring-brand-600 ring-offset-1',
  );
  const body = (
    <>
      {ticket.systemPlaced && <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-current" />}
      {ticket.ticketId.slice(0, 8)}
      {/* Urgency as a token, not a border — D11, and the reason is in this file's docblock. */}
      {critical && (
        <Token
          testId={`crit-${ticket.ticketId}`}
          label="CRIT"
          critical
          title={`${(ticket.slaBucket ?? '').replace(/_/g, ' ')} — critical work; urgency travels with the ticket, whoever assigned it`}
        />
      )}
      {ticket.returnDueToday && <Token label="RET" title="Vehicle due back today" />}
      {/*
        **Chronic device** (3.4). An inline token, not a border or a colour: chronic names the
        equipment (lifetime failure cycles), and the replace-or-investigate question it carries is
        different from urgency, provenance and capacity — so it gets its own word, not their hues.
      */}
      {ticket.failureCycles != null && ticket.failureCycles >= chronicThreshold && (
        <Token
          testId={`chronic-${ticket.ticketId}`}
          label={`CHR ×${ticket.failureCycles}`}
          title={`Chronic device — ${ticket.failureCycles} failure cycles. Dispatch treats it normally; the question is whether to replace the unit.`}
        />
      )}
    </>
  );

  const dragProps =
    draggable && dragPayload
      ? {
          draggable: true,
          onDragStart: (e: React.DragEvent) => {
            e.dataTransfer.setData(DRAG_MIME, JSON.stringify(dragPayload));
            e.dataTransfer.effectAllowed = 'move';
            onDragChange?.(dragPayload);
          },
          onDragEnd: () => onDragChange?.(null),
        }
      : {};

  if (!onSelect) {
    return (
      <span title={title} data-testid={`chip-${ticket.ticketId}`} data-provenance={ticket.addSource ?? 'UNKNOWN'} className={shared}>
        {body}
      </span>
    );
  }

  return (
    <button
      type="button"
      title={title}
      aria-pressed={selected}
      data-testid={`chip-${ticket.ticketId}`}
      data-provenance={ticket.addSource ?? 'UNKNOWN'}
      className={cn(shared, 'cursor-pointer hover:brightness-95')}
      onClick={() => onSelect({ kind: 'ticket', id: ticket.ticketId })}
      {...dragProps}
    >
      {body}
    </button>
  );
}

/**
 * A projected ticket on a future column — the recommender's conditional answer, not a commitment.
 *
 * Ghosted, labelled by its container as *projected*, and deliberately **not selectable**: there is
 * no committed object behind it to inspect, no trace to explain and no override to offer. Hold is
 * the only pre-run lever, and it lives on the Work Pool's held population, not here.
 */
export function GhostChip({ ticketId }: { ticketId: string }) {
  return (
    <span
      data-testid={`ghost-${ticketId}`}
      title="Projected — nothing is committed. The run may decide differently; holding a ticket back is the only pre-run lever."
      className="inline-flex items-center gap-1 rounded border border-dashed border-line px-1.5 py-0.5 text-[11px] tabular-nums italic text-ink-muted opacity-70"
    >
      ~{ticketId.slice(0, 8)}
    </span>
  );
}

/** The grammar, spelled out — reference content for the top bar's `?` popover, not a strip. */
export function GrammarLegend() {
  return (
    <ul className="flex flex-col gap-1.5 text-[10px] text-ink-muted">
      <li className="flex items-center gap-1.5">
        <span className="inline-flex items-center gap-1 rounded border border-line px-1.5 py-0.5">
          <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-current" />
          solid
        </span>
        system decision
      </li>
      <li className="flex items-center gap-1.5">
        <span className="rounded border border-dashed border-ink-muted px-1.5 py-0.5">dashed</span>
        human override
      </li>
      <li className="flex items-center gap-1.5">
        <span className="rounded border border-dashed border-tier-cross px-1.5 py-0.5 text-tier-cross">dashed violet</span>
        a human crossed a coverage tier
      </li>
      <li className="flex items-center gap-1.5">
        <span className="rounded border border-dotted border-line px-1.5 py-0.5">dotted</span>
        provenance not recorded
      </li>
      <li className="flex items-center gap-1.5">
        <span className="rounded bg-critical-bg px-1 text-[9px] font-bold tracking-wide text-critical">CRIT</span>
        critical work — travels with the ticket, whoever assigned it
      </li>
      <li className="flex items-center gap-1.5">
        <span className="rounded bg-surface-sunken px-1 text-[9px] font-bold tracking-wide">RET</span>
        vehicle due back today
      </li>
      <li className="flex items-center gap-1.5">
        <span className="rounded bg-surface-sunken px-1 text-[9px] font-bold tracking-wide">CHR ×n</span>
        chronic device — n lifetime failure cycles
      </li>
      <li className="flex items-center gap-1.5">
        <span className="rounded border border-dashed border-line px-1.5 py-0.5 italic opacity-70">~ghost</span>
        projected by the preview — nothing committed
      </li>
      <li className="flex items-center gap-1.5">
        <span className="rounded bg-warning-soft/60 px-1.5 py-0.5">amber cell</span>
        engineer at or over capacity
      </li>
    </ul>
  );
}
