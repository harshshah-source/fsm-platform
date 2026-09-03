import type { CardSummary, TicketActionStatus, TodayTicket } from '../../../api/dispatchToday';
import { cn } from '../../../lib/cn';
import type { Selection } from './selection';
import { DRAG_MIME, Token, provenanceTreatment, type ChipDragPayload } from './WorkChip';

/**
 * **THE WORK CARD** (#295) — what replaced eight characters of a UUID.
 *
 * The board's unit used to be `ticketId.slice(0, 8)`: `1a8e629f`, from which no dispatcher has ever
 * learnt anything. Every question they actually ask — *which unit is this, whose vehicle, at whose
 * plant, who hauls it, how long has it been down, is anyone on it* — required opening the Inspector,
 * one ticket at a time, which is not a thing anyone does across a hundred chips.
 *
 * ## What the card is allowed to say
 *
 * The identity fields are facts off the payload, laid out **two to a row** with the transporter across
 * the bottom — the arrangement that turned a five-line card into a three-line block when the operator
 * found the first build unreadable at board density. The plant comes from the *stop*, handed down
 * rather than copied onto the ticket server-side, so a card can never disagree with the stop it is in.
 *
 * The **status** is the one derived thing on it,
 * and it is derived on the server (`actionStatus`) rather than here, because the rule involves a
 * clock, a soft state and an operator-tunable threshold — three inputs a component has no business
 * recombining. This client renders a verdict; it does not compute one.
 *
 * ## The grammar it joins, without disturbing it
 *
 * Every channel `WorkChip` established survives on this card, in the same meaning and the same
 * position — the border still carries provenance, the inline tokens still carry urgency (`CRIT`),
 * vehicle return (`RET`) and chronic devices (`CHR ×n`), and the cell behind it still carries
 * capacity. The status takes a position nothing else occupies (the card's own surface and left edge)
 * and a palette nothing else uses (`--color-action-*`), which is the whole of how a red/green
 * traffic light coexists with a crimson that means critical and an amber that means over capacity.
 * See the rule and its amendments in `index.css`.
 *
 * ## Identity
 *
 * `ticketId` remains the domain identity for selection, drag, overrides and every mutation. The
 * device number is a **label** — the thing a human recognises — and is never a key. The drag payload
 * is byte-for-byte the one `WorkChip` emitted (`ChipDragPayload` under `DRAG_MIME`), so `dropAction`,
 * `intentFor`, the Inspector prefill, `MOVE_TICKET`, `REASSIGN` and `SWAP_SE` are untouched by
 * construction rather than by re-testing.
 */

/**
 * How the three states read, in words, and how they paint.
 *
 * **`fill` is the correction of 2026-09-01.** The status shipped as a 3px rail, and on a board of a
 * hundred cards nobody saw it: the operator's report was that the colour "is also not present". A
 * hairline is a signal only to a reader who already knows where to look. The card's own background is
 * now the channel — the position `index.css` reserves for it — with the rail kept as its edge and the
 * word kept beside it, so the state is legible at a glance, in grayscale, and to a screen reader.
 *
 * **Three states, two colours (operator ruling, 2026-09-01).** The light answers one question — *is
 * anybody on this?* — and it has two answers, so it gets two hues: green where troubleshooting has
 * begun, red everywhere it has not. `AGING_UNTOUCHED` used to take a third, yellow, but aged work is
 * not a third answer; it is untouched work with a clock on it, and it now paints the same red as any
 * other untouched card. **The label is what still separates them**, which makes the never-hue-alone
 * rule load-bearing here rather than a courtesy — `label` must never be dropped from this table.
 *
 * Colour is never the only carrier: the word always shows.
 */
const ACTION_STATUS: Record<TicketActionStatus, { label: string; rail: string; text: string; fill: string }> = {
  IN_PROGRESS: {
    label: 'Started',
    rail: 'bg-action-started',
    text: 'text-action-started',
    fill: 'bg-action-started-bg',
  },
  NOT_STARTED: {
    label: 'Untouched',
    rail: 'bg-action-untouched',
    text: 'text-action-untouched',
    fill: 'bg-action-untouched-bg',
  },
  /* Same paint as NOT_STARTED, deliberately: nobody has troubleshooted either one. Only the word
     differs, and the word is the aging signal. */
  AGING_UNTOUCHED: {
    label: 'Aged',
    rail: 'bg-action-untouched',
    text: 'text-action-untouched',
    fill: 'bg-action-untouched-bg',
  },
};

/**
 * One labelled fact on the card — the unit of the 2×2 (operator, 2026-09-01).
 *
 * The card used to run its facts down the page, one per line, which made a five-fact card five lines
 * tall and a cell of eight cards a scroll. Two columns of labelled pairs says the same thing in half
 * the height, and the label is what lets the pair be read at 10px without the reader having to infer
 * a value's meaning from its shape — `NCP-9117` and `NL01AJ2655` are both just strings.
 *
 * **Null is drawn as unknown, never as absent and never as a zero.** An em-dash keeps the grid's rows
 * aligned across cards, which is the whole reason the fields are a grid rather than a wrapped list.
 */
function Field({
  label,
  value,
  mono,
  bare,
  marker,
  trailing,
}: {
  label: string;
  value: string | null | undefined;
  mono?: boolean;
  /**
   * Draw the value without its label, and name the field in the tooltip instead.
   *
   * Used for the transporter, and for one reason: at two cards across a laptop's focused column the
   * card is ~183px, of which `TRANSPORTER` costs 42 and `Inactive 7430h` beside it costs 61 — leaving
   * the name itself about ten characters, which is `RIMJHI…` and tells nobody anything. The label is
   * the cheapest thing on that row to give up: the transporter is the only free-text name left on the
   * card (the company came off in the same pass), it sits in a fixed position on every card, and the
   * tooltip still says which field it is. Device and vehicle keep their labels — a 15-digit number and
   * a plate are worth naming, and they have the room.
   */
  bare?: boolean;
  /** Drawn *before* the label, where `WorkChip` puts it — a mark on the card, not on this one field. */
  marker?: React.ReactNode;
  /** The row's right-hand slot: tokens, status, inactivity. Never allowed to shrink the label. */
  trailing?: React.ReactNode;
}) {
  return (
    <span className="flex min-w-0 items-baseline gap-1">
      {marker}
      {!bare && (
        <span className="shrink-0 text-[8px] font-medium uppercase tracking-wide text-ink-muted">{label}</span>
      )}
      <span
        className={cn('min-w-0 flex-1 truncate text-[10px] text-ink', mono && 'font-mono')}
        title={value == null ? undefined : bare ? `${label}: ${value}` : value}
      >
        {value ?? '—'}
      </span>
      {trailing}
    </span>
  );
}

const CRITICAL_BUCKETS = new Set(['CRITICAL', 'HIGH_CRITICAL']);

/**
 * What each card variant may claim.
 *
 * - `live` — today's column, from the one lifted `GET /dispatch/today`. Full fidelity: identity,
 *   tokens, provenance and the status rail.
 * - `committed` — a committed **future** day, identity batched in from `POST /dispatch/card-summaries`.
 *   Identity only, and deliberately **no status rail**: nobody has started work whose day has not
 *   begun, and "untouched for six hours" said about Wednesday is a category error rather than a fact.
 *   Where the batch has not answered, the caller falls back to the compact committed chip instead of
 *   drawing this frame with blank rows — a full card with five empty lines is the same class of lie
 *   the provenance grammar exists to prevent.
 */
export type WorkCardVariant =
  | { variant: 'live'; ticket: TodayTicket; agingThresholdHours: number; chronicThreshold: number }
  | {
      variant: 'committed';
      ticketId: string;
      summary: CardSummary;
      addSource: string | null;
      systemPlaced: boolean;
      /** Carried so the committed card can show a tier crossing in violet like any other work — the
       *  day-scoped read returns it, and dropping it would silently downgrade a real signal. */
      coverageTypeAtAssign: string | null;
    };

/**
 * `Inactive 18h`, or an em-dash where the device state has never been recomputed. Never `0h`.
 *
 * The tenth of an hour is kept only under a day, where it is the difference between "just now" and
 * "this morning". Past that it is noise — a device silent for 7430.04 hours has been silent for
 * **7430h**, and the two extra glyphs were being paid for out of the width of the transporter beside
 * them. Rounded, never truncated: `Math.round`, so 23.96h reads `24h` rather than `23h`.
 */
function inactivityLabel(hours: number | null): string {
  if (hours == null) return '—';
  if (hours >= 24) return `${Math.round(hours)}h`;
  return `${Number.isInteger(hours) ? hours : hours.toFixed(1)}h`;
}

/**
 * The sentence behind the status word.
 *
 * The threshold is **quoted only when the payload actually sent one**, so the tooltip cannot read
 * "turns aged after undefinedh" against a backend that predates the field. Naming a number the server
 * did not give would be the same class of invention the rest of this file refuses.
 */
function statusTitle(status: TicketActionStatus, thresholdHours: number | undefined): string {
  if (status === 'IN_PROGRESS') return 'An engineer has started troubleshooting this ticket.';
  const after = typeof thresholdHours === 'number' ? `${thresholdHours}h` : 'the configured threshold';
  return status === 'AGING_UNTOUCHED'
    ? `Assigned ${after} or more ago and nobody has started troubleshooting it yet.`
    : `Nobody has started troubleshooting this yet. It turns aged after ${after} assigned.`;
}

export function WorkCard(
  props: WorkCardVariant & {
    selected?: boolean;
    onSelect?: (sel: Selection) => void;
    draggable?: boolean;
    dragPayload?: ChipDragPayload;
    onDragChange?: (payload: ChipDragPayload | null) => void;
  },
) {
  const live = props.variant === 'live';
  const ticketId = live ? props.ticket.ticketId : props.ticketId;
  const identity: Pick<CardSummary, 'deviceId' | 'vehicleNo' | 'transporterName' | 'inactivityHours'> =
    live ? props.ticket : props.summary;

  // Provenance keeps its channel on both variants: the border style, unchanged, from the same reader.
  const { className: provenanceClass, title: provenanceTitle } = provenanceTreatment(
    live
      ? props.ticket
      : {
          addSource: props.addSource,
          systemPlaced: props.systemPlaced,
          coverageTypeAtAssign: props.coverageTypeAtAssign,
        },
  );

  /**
   * The status to draw, or `null` for "the payload did not say".
   *
   * **A lookup on a network value, so the miss is a real case, not a defensive tic.** An admin build
   * deployed ahead of its backend receives a payload with no `actionStatus`, and dereferencing the
   * missing row threw inside every card's render — which React escalates from one bad card to a blank
   * page. It happened on the first run against a live stack.
   *
   * Absent is drawn as absent: no rail, no word, the rest of the card unchanged. That is the same rule
   * the provenance grammar follows for an unrecorded `addSource` — an unknown fact is rendered as
   * unknown, never guessed into a state the server never claimed.
   */
  const status = live ? (ACTION_STATUS[props.ticket.actionStatus] ?? null) : null;
  const critical = live && CRITICAL_BUCKETS.has(props.ticket.slaBucket ?? '');

  const body = (
    <>
      {/* The status rail: the card's left edge. The fill is the same channel — the rail is its edge. */}
      {live && status && (
        <span aria-hidden className={cn('absolute inset-y-0 left-0 w-[3px] rounded-l', status.rail)} />
      )}

      {/*
        **Three rows, each ending in one piece of metadata** (operator, 2026-09-01, second pass).

        The card briefly carried plant and company as well, in a 2×2. Both came straight back off: the
        plant is the stop header these cards are already sitting under, and the tickets at one plant
        share a company, so the pair printed the same two strings on every card in the cell and
        charged the cell's width for it. What is left is what actually differs card to card — the
        unit, its vehicle, who hauls it — with the verdict, the silence and the tokens down the right
        edge in fixed positions, so the metadata reads as a column even though it belongs to rows.

        This is what makes the cell a grid rather than a list: at roughly 10.5rem a card fits two or
        three across instead of one, and a fifteen-device stop stops being a scroll.

        **Which row carries which piece of metadata is load-bearing, not arbitrary.** At two cards
        across a laptop's focused column each card is ~183px, so exactly one value per row can afford
        to be cut — and it must always be the same one. The device number and the plate are what an
        operator matches against the Work Pool and against the unit in the field, so the two short
        right-hand items (the tokens, the status word) sit on their rows, and the long one
        (`Inactive 7430h`) sits on the transporter's row, where the truncation lands on a name the
        tooltip still gives back in full.
      */}
      <Field
        label="Device"
        mono
        // The unit as a human recognises it. `ticketId` stays the key; the hash is only the fallback
        // for a read that could not name the device — never the headline.
        value={identity.deviceId ?? ticketId.slice(0, 8)}
        marker={
          live && props.ticket.systemPlaced ? (
            <span aria-hidden className="h-1.5 w-1.5 shrink-0 self-center rounded-full bg-current" />
          ) : undefined
        }
        trailing={
          live ? (
            <span className="flex shrink-0 items-center gap-0.5">
              {critical && (
                <Token
                  testId={`crit-${ticketId}`}
                  label="CRIT"
                  critical
                  title={`${(props.ticket.slaBucket ?? '').replace(/_/g, ' ')} — critical work; urgency travels with the ticket, whoever assigned it`}
                />
              )}
              {props.ticket.returnDueToday && <Token label="RET" title="Vehicle due back today" />}
              {props.ticket.failureCycles != null && props.ticket.failureCycles >= props.chronicThreshold && (
                <Token
                  testId={`chronic-${ticketId}`}
                  label={`CHR ×${props.ticket.failureCycles}`}
                  title={`Chronic device — ${props.ticket.failureCycles} failure cycles. Dispatch treats it normally; the question is whether to replace the unit.`}
                />
              )}
            </span>
          ) : undefined
        }
      />
      <Field
        label="Vehicle"
        value={identity.vehicleNo}
        mono
        trailing={
          live && status ? (
            <span
              data-testid={`action-status-${ticketId}`}
              data-action-status={props.ticket.actionStatus}
              className={cn('shrink-0 text-[9px] font-bold uppercase tracking-wide', status.text)}
              title={statusTitle(props.ticket.actionStatus, props.agingThresholdHours)}
            >
              {status.label}
            </span>
          ) : !live ? (
            <span className="shrink-0 text-[9px] font-bold uppercase tracking-wide text-ink-muted">
              {props.addSource === 'MANUAL_DAY_MOVE' ? '⇥ moved' : 'committed'}
            </span>
          ) : undefined
        }
      />
      <Field
        label="Transporter"
        bare
        value={identity.transporterName}
        trailing={
          <span
            className="shrink-0 text-[9px] tabular-nums text-ink-muted"
            title={
              identity.inactivityHours == null
                ? 'How long the device has been silent has never been computed for this unit.'
                : 'How long the device has been silent. This is why the ticket exists — it is not how long the work has gone untouched.'
            }
          >
            Inactive {inactivityLabel(identity.inactivityHours)}
          </span>
        }
      />
    </>
  );

  const shared = cn(
    'relative flex w-full min-w-0 flex-col gap-px rounded-sm py-0.5 pl-2 pr-1 text-left leading-tight',
    provenanceClass,
    // The action status as a fill — the card's own surface, which is the one place `index.css`
    // licenses this palette outside the rail. Absent verdict, absent fill: an unknown state is drawn
    // as unknown, exactly as an unrecorded provenance is.
    status?.fill,
    props.selected && 'ring-2 ring-brand-600 ring-offset-1',
  );

  const dragProps =
    props.draggable && props.dragPayload
      ? {
          draggable: true,
          onDragStart: (e: React.DragEvent) => {
            e.dataTransfer.setData(DRAG_MIME, JSON.stringify(props.dragPayload));
            e.dataTransfer.effectAllowed = 'move';
            props.onDragChange?.(props.dragPayload!);
          },
          onDragEnd: () => props.onDragChange?.(null),
        }
      : {};

  if (!props.onSelect) {
    return (
      <span
        title={provenanceTitle}
        data-testid={`chip-${ticketId}`}
        data-provenance={(live ? props.ticket.addSource : props.addSource) ?? 'UNKNOWN'}
        className={shared}
      >
        {body}
      </span>
    );
  }

  const onSelect = props.onSelect;
  return (
    <button
      type="button"
      title={provenanceTitle}
      aria-pressed={props.selected}
      data-testid={`chip-${ticketId}`}
      data-provenance={(live ? props.ticket.addSource : props.addSource) ?? 'UNKNOWN'}
      className={cn(
        shared,
        'hover:brightness-95',
        // `grab` only where it really is draggable — a grab cursor on a card that cannot move is a
        // worse lie than no affordance at all.
        props.draggable && props.dragPayload ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer',
      )}
      onClick={() => onSelect({ kind: 'ticket', id: ticketId })}
      {...dragProps}
    >
      {body}
    </button>
  );
}
