import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  apiScheduleDetail,
  type ScheduleDetail,
  type SchedulePickup,
  type ScheduleStop,
  type ScheduleStopTicket,
} from '../../api/schedules';
import { Badge, Button } from '../../components/ui';
import type { BadgeTone } from '../../components/ui/Badge';
import { PlantName } from '../../components/domain';
import { StopActions, TicketActions } from '../dispatch/console/ActionsBand';

/**
 * ZM Schedule detail (Issue 13b AC#2/#3/#4 · FE-12 parity, reference 12). The ordered stop list for one
 * SE's Work Schedule, each stop showing plant + device count and its tickets with a "Why suggested?"
 * reasoning chip.
 *
 * **#313 (AR-4 + CB-7) — the override controls are the Console's, not a second copy of them.**
 * `ActionsBand`'s docblock has claimed since the Console landed that the ScheduleDetailPage controls
 * were *"moved here … not copied: one implementation"*. They were copied. This page carried a full
 * second implementation of Remove / Defer / Reassign / Swap / Split / Reorder plus its own
 * `useOverridePreview`, and the two had already diverged in the ways a fork always does:
 *
 * - **Failures were silent here (CB-7).** The page's `onOverride` re-threw anything that was not an
 *   ON_SITE conflict and both commit helpers were `try/finally` with no `catch`, so a 500 or a dropped
 *   connection produced an unhandled rejection, a button that stopped spinning, and no message at all.
 *   The Console's form has caught and rendered that since it was written.
 * - **Move to another day did not exist here**, months after the Console gained it.
 * - The conflict banner had one copy of the deferral-vs-ON_SITE wording, and the Console another.
 *
 * Rendering {@link StopActions} and {@link TicketActions} makes the docblock's claim true and closes
 * CB-7 *by construction* rather than by adding a second error surface that could drift again. The page
 * keeps everything that is genuinely its own — the stop ordering, the batch link, the state badges,
 * the "Why suggested?" chip — and gains MOVE_TICKET for free, which is the point of there being one
 * implementation.
 *
 * The impact preview (#289, an operator-ruled surface on this page) is unaffected: it lives inside the
 * shared `OverrideForm` and renders in every move dialog here exactly as it does in the Console.
 *
 * **#281 AC8 (#280 R8) — present → past, per record.** Each stop IS a batch, and `/batches/:batchId`
 * is the dispatch record that produced it: the decision trace, the candidates considered, the run's
 * configuration. That was reachable only by walking down from the runs ledger, which meant an operator
 * asking "why is this stop on their day?" had to find the run first. The reverse direction — batch
 * back to the day plan — is #281 AC6, on `DispatchBatchDetailPage`.
 */
const STATUS_TONE: Record<string, BadgeTone> = {
  AUTO_ASSIGNED: 'neutral',
  OVERRIDDEN: 'warning',
};

export function ScheduleDetailPage() {
  const { engineerId = '' } = useParams();
  const [detail, setDetail] = useState<ScheduleDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    return apiScheduleDetail(engineerId)
      .then(setDetail)
      .catch(() => setError('Failed to load schedule'));
  }, [engineerId]);

  useEffect(() => {
    let alive = true;
    apiScheduleDetail(engineerId)
      .then((d) => alive && setDetail(d))
      .catch(() => alive && setError('Failed to load schedule'));
    return () => {
      alive = false;
    };
  }, [engineerId]);

  if (error) {
    return (
      <p role="alert" className="text-sm text-critical">
        {error}
      </p>
    );
  }
  if (!detail) {
    return <p className="text-sm text-ink-muted">Loading…</p>;
  }

  return (
    <div>
      <Link to="/schedules" className="text-sm text-ink-muted hover:underline">
        ← Schedules
      </Link>
      <h2 className="mb-1 mt-2 text-xl font-semibold text-ink-strong">
        {detail.seName ?? detail.seId}
        <span className="ml-2 align-middle font-mono text-xs font-normal text-ink-muted">
          {detail.seId.slice(0, 8)}
        </span>
      </h2>
      <p className="mb-1 flex items-center gap-2 text-sm text-ink-muted">
        <span>
          {detail.dateFrom === detail.dateTo ? detail.dateFrom : `${detail.dateFrom} – ${detail.dateTo}`}
        </span>
        <span data-testid={`schedule-status-${detail.status}`}>
          <Badge tone={STATUS_TONE[detail.status] ?? 'neutral'}>{detail.status}</Badge>
        </span>
      </p>
      <p className="mb-5 text-xs text-ink-muted">
        The SE visits the stops below in order; each stop is one plant with its assigned tickets. Every
        change here (remove / defer / reassign / move / swap / split / reorder) commits immediately with
        a mandatory reason and flags the plan OVERRIDDEN.
      </p>

      <ol className="flex flex-col gap-3">
        {/* #366 — stop 0, and only when it is real. Inside the ordered list, ahead of stop 1: the
            engineer cannot work stop 1 without the part, so the pickup genuinely comes first. */}
        {detail.pickup ? <PickupStop pickup={detail.pickup} /> : null}
        {detail.stops.map((stop) => (
          <Stop
            key={stop.batchId}
            stop={stop}
            seId={detail.seId}
            seName={detail.seName ?? null}
            day={detail.dateFrom}
            onCommitted={load}
          />
        ))}
      </ol>
    </div>
  );
}

/** `REQ-1a2b3c4d` — the request's own id, truncated the way this page already truncates ticket and
 *  engineer ids. There is no separate human reference on `component_request` to print instead. */
function requestRef(requestId: string): string {
  return `REQ-${requestId.slice(0, 8)}`;
}

/**
 * The Zone Warehouse pickup stop (#366), per the approved design
 * `docs/ui/desktop/approved-designs/warehouse-pickup-stop.html`.
 *
 * **A stop row of its own kind, not a banner and not a differently-coloured plant.** It sits in the
 * same ordered list at sequence 0 so the numbering stays literal; a banner above the list would say
 * "also, collect something" and detach the pickup from the sequence it is part of, which is the
 * ambiguity stop numbering exists to remove. It carries no ticket list, no device count, no SLA and
 * none of the override controls, because a warehouse has none of those — the shape differs, which is
 * why `kind` is discriminated on the wire rather than a boolean beside the plant fields.
 *
 * **Colour encodes kind, not severity.** Violet because crimson is already spent on critical and
 * amber on over-capacity in this product's grammar, and a pickup is neither urgent nor wrong — it is
 * a different sort of thing. The "Pickup" tag carries that meaning in text, so the row survives
 * grayscale, colour-blind rendering and a screen reader without depending on the hue at all.
 *
 * The parts are **named**: a dispatcher checking a plan should not have to open the component
 * requests to learn what their engineer is carrying. One component request is one component, so the
 * per-part quantity is structurally ×1; the shipment reference the WM recorded rides in the row's
 * `title` rather than taking a column that would push the part names off the line.
 */
function PickupStop({ pickup }: { pickup: SchedulePickup }) {
  const count = pickup.parts.length;
  return (
    <li
      data-testid="schedule-pickup-stop"
      className="rounded-card border border-line border-l-[3px] border-l-violet-500 bg-violet-50 p-3 shadow-sm dark:border-l-violet-400 dark:bg-violet-950/40"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span data-testid="pickup-stop-sequence" className="font-mono text-xs text-ink-caps">
              Stop 0
            </span>
            <span className="font-semibold text-violet-700 dark:text-violet-300">Zone Warehouse</span>
            <span
              data-testid="pickup-kind-tag"
              className="rounded border border-violet-500 px-1.5 text-[0.62rem] font-bold uppercase tracking-wider text-violet-700 dark:border-violet-400 dark:text-violet-300"
            >
              Pickup
            </span>
          </div>
          <p className="mt-1 text-xs text-ink-muted">{pickup.warehouseName} · collect before first plant</p>
          <ul className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 font-mono text-xs text-ink-muted">
            {pickup.parts.map((part) => (
              <li
                key={part.requestId}
                data-testid={`pickup-part-${part.requestId}`}
                title={part.trackingRef ? `Tracking ${part.trackingRef}` : undefined}
              >
                {requestRef(part.requestId)} · {part.componentName ?? 'Unnamed component'} ×1
              </li>
            ))}
          </ul>
        </div>
        <span className="whitespace-nowrap text-xs text-ink-muted">
          {count} {count === 1 ? 'part' : 'parts'}
        </span>
      </div>
    </li>
  );
}

function Stop({
  stop,
  seId,
  seName,
  day,
  onCommitted,
}: {
  stop: ScheduleStop;
  seId: string;
  seName: string | null;
  day: string;
  onCommitted: () => void;
}) {
  return (
    <li data-testid="schedule-stop" className="rounded-card border border-line bg-surface-card p-3 shadow-sm">
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-xs text-ink-caps">Stop {stop.stopSequence}</span>
          <PlantName code={stop.plantName} variant="inline" className="font-semibold text-ink-strong" />
          <Badge tone={stop.status === 'OVERRIDDEN' ? 'warning' : 'neutral'}>
            {stop.status === 'AUTO_ASSIGNED' ? 'AUTO' : stop.status}
          </Badge>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-ink-muted">{stop.deviceCount} devices</span>
          {/* A link, not a control: the batch record is read-only history (#280 R3 / #281 AC5). It sits
              before the override buttons so "see why this was assigned" reads ahead of "change it". */}
          <Link
            to={`/batches/${stop.batchId}`}
            data-testid={`stop-to-batch-${stop.batchId}`}
            className="whitespace-nowrap text-xs text-link hover:underline"
          >
            Why dispatch chose this →
          </Link>
        </div>
      </div>

      {/* #313 — the Console's stop actions, verbatim. `onDismiss` is a no-op here on purpose: there is
          no overlay on this page to put away, and Cancel closing the form is the shared component's
          own business. */}
      <StopActions
        batchId={stop.batchId}
        currentSeId={seId}
        ticketIds={stop.tickets.map((t) => t.ticketId)}
        stopSequence={stop.stopSequence}
        onCommitted={onCommitted}
        onDismiss={() => undefined}
      />

      <ul className="mt-2 flex flex-col gap-1 text-sm">
        {stop.tickets.map((t) => (
          <TicketRow
            key={t.ticketId}
            batchId={stop.batchId}
            seId={seId}
            seName={seName}
            day={day}
            ticket={t}
            onCommitted={onCommitted}
          />
        ))}
      </ul>
    </li>
  );
}

function TicketRow({
  batchId,
  seId,
  seName,
  day,
  ticket,
  onCommitted,
}: {
  batchId: string;
  seId: string;
  seName: string | null;
  day: string;
  ticket: ScheduleStopTicket;
  onCommitted: () => void;
}) {
  return (
    <li
      data-testid={`ticket-row-${ticket.ticketId}`}
      className="flex flex-col gap-1 rounded-md px-2 py-1 hover:bg-surface-sunken/50"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-ink-strong" title={ticket.ticketId}>
          Ticket <span className="font-mono">#{ticket.ticketId.slice(0, 8)}</span>
        </span>
        <TicketStateBadges ticket={ticket} />
        <WhySuggested ticket={ticket} />
      </div>

      {/* #313 — PLACED, always: every ticket on this page is on this engineer's plan by definition, so
          the placement is a fact of the route rather than something to derive. `sourceDay`/`sourceSeName`
          let the shared move dialog state the whole change in the operator's own terms. */}
      <TicketActions
        ticketId={ticket.ticketId}
        placement={{ kind: 'PLACED', batchId, seId }}
        currentSeId={seId}
        onCommitted={onCommitted}
        onDismiss={() => undefined}
        sourceDay={day}
        sourceSeName={seName}
      />
    </li>
  );
}

/** SLA-bucket → badge tone: the severe end of the ladder is critical, the risk band is warning. */
const SLA_TONE: Record<string, BadgeTone> = {
  CRITICAL: 'critical',
  HIGH_CRITICAL: 'critical',
  SEVERE: 'critical',
  VERY_SEVERE: 'critical',
  LONG_PENDING: 'critical',
  RISK: 'warning',
  EARLY_RISK: 'warning',
  WARNING: 'warning',
};

/**
 * Ungated per-ticket state badges (Issue 79 · reference 12) — SLA bucket, Company Tier, and a
 * PARTIAL_RECOVERY marker. Always visible: unlike "Why suggested?", these are the un-gated ticket state,
 * not the Recommender scoring reasoning. Each guarded so the pre-#79 payload (no fields) renders nothing.
 */
function TicketStateBadges({ ticket }: { ticket: ScheduleStopTicket }) {
  return (
    <span className="flex items-center gap-1">
      {ticket.slaBucket && (
        <span data-testid={`ticket-sla-${ticket.ticketId}`}>
          <Badge tone={SLA_TONE[ticket.slaBucket] ?? 'neutral'}>{ticket.slaBucket}</Badge>
        </span>
      )}
      {ticket.companyTier && (
        <span data-testid={`ticket-tier-${ticket.ticketId}`}>
          <Badge tone="brand">{ticket.companyTier}</Badge>
        </span>
      )}
      {ticket.partialRecovery && (
        <span data-testid={`ticket-partial-${ticket.ticketId}`}>
          <Badge tone="warning">PARTIAL</Badge>
        </span>
      )}
    </span>
  );
}

/** Collapsed "Why suggested?" chip → expands to the per-ticket Recommender reasoning. */
function WhySuggested({ ticket }: { ticket: ScheduleStopTicket }) {
  const [open, setOpen] = useState(false);
  const r = ticket.reasoning;

  return (
    <span>
      <Button type="button" size="sm" variant="ghost" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        Why suggested?
      </Button>
      {open && (
        <span className="ml-2 text-xs text-ink-muted">
          {r
            ? `Tier ${r.companyTier ?? '—'} · Bucket ${r.deviceBucket ?? '—'} · Rank ${r.companyPriorityRank ?? '—'} · Cluster ×${r.clusterMultiplier ?? '—'}`
            : 'No recommendation reasoning recorded.'}
        </span>
      )}
    </span>
  );
}
