import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiCandidates, type PlantCandidates } from '../../../api/candidates';
import {
  apiDispatchRunDecisions,
  apiDispatchTicketTrace,
  type DispatchRunDecisions,
  type DispatchTicketTrace,
  type PoolEmptyReason,
} from '../../../api/dispatch-runs';
import type { DispatchTodayView, TodayEngineer, TodayStop, TodayTicket } from '../../../api/dispatchToday';
import {
  apiTicketAttempts,
  apiTicketDetail,
  type TicketAttemptHistory,
  type TicketDetail,
} from '../../../api/tickets';
import { Skeleton } from '../../../components/data';
import { Modal } from '../../../components/overlay';
import { Badge } from '../../../components/ui';
import { LoadBadge } from '../../../components/ui/LoadBadge';
import { cn } from '../../../lib/cn';
import { CandidateColumn } from '../../assign/CandidateColumn';
import { DecisionTraceView, TracePanel } from '../DecisionTrace';
import { POOL_EMPTY_LABEL, ordinal } from '../format';
import { StopActions, TicketActions, type ActionPrefill, type TicketPlacement } from './ActionsBand';
import { ScoreBreakdownPanel } from './ScoreBreakdownPanel';
import type { Selection } from './selection';

type Band = 'why' | 'candidates' | 'history';

/**
 * **The CONTEXTUAL INSPECTOR — the Console's modal overlay** (operator ruling, 2026-09-01).
 *
 * Exactly one object is selected, and this is where the Console answers everything about it: what it
 * is, why the engine placed it where it did, who else could have taken it, what has happened to it,
 * and — from Phase 2 — what can be done about it and what that would cost.
 *
 * **It was the bottom band until 2026-09-01, and the band is why drops felt broken.** The Console's
 * deck is a screen or more tall, so a band *underneath* it opened the drop's whole answer below the
 * fold; the page answered by scroll-chasing it into view with a `ResizeObserver`, which put the
 * operator somewhere they had not asked to be and still lost the board. An overlay makes the distance
 * irrelevant instead of chasing it: the answer opens where the operator is looking, the board keeps
 * its scroll position, and Escape / the backdrop / Close all put it away. The scroll-chasing effect
 * was deleted with the band, not kept as a belt.
 *
 * **The Inspector is composition, not new views.** `DecisionTraceView` already owns "why this SE";
 * `CandidateColumn` already renders the engine's candidate list tier-grouped, in precedence order,
 * with drop reasons and without re-sorting. Both are reused verbatim rather than reimplemented — which
 * is what keeps #282 R5 satisfied and, more practically, is why the Alternatives band is correct on
 * the first day: a flat score-sorted list here would teach a false model of an engine that walks
 * tiers.
 *
 * **Where the run id comes from, and why no new endpoint is needed.** The Why band needs
 * `(runId, ticketId)`. A ticket selected on the board carries its stop's `runId`; a ticket selected in
 * the Work rail belongs to today's operating day, whose run is `view.run.runId`. That covers every
 * door the Console has, so slice §9 B4 (`GET /tickets/:id/decision`) is **not** required for this
 * phase, and Phase 1 stays free of backend change as specified. When a ticket genuinely has no trace
 * in that run, the band says so rather than inventing one.
 *
 * **Actions and Impact landed in Phase 2** (operator ruling D1, 2026-08-27). The six override controls
 * were **moved** here from `ScheduleDetailPage`, not copied: one implementation, so `#282 R5` holds.
 * `ActionsBand` owns them, together with assign / hold / release, the impact preview where the action
 * is projectable, and both 409 confirm gates. What each object may do is decided by
 * {@link placementOf} — and the illegal set is **absent**, never greyed out.
 */
export function Inspector({
  selection,
  view,
  onClose,
  onCommitted,
  prefill,
}: {
  selection: Selection | null;
  view: DispatchTodayView;
  onClose: () => void;
  /**
   * The Console's single lifted fetch (§8.4). Every write in this band calls it — that is the whole
   * mechanism by which four regions reading one payload cannot disagree after an override.
   *
   * `moved` is passed only by a cross-day move. Refetching alone would leave the operator staring at
   * the day the work just *left*, which is the same "nothing happened" the old defer produced; the
   * page uses this to focus the day it landed on.
   */
  onCommitted: (moved?: { day: string }) => void;
  /**
   * A drag-initiated action to open pre-filled (correction §12, D10). The drop wrote nothing — this
   * only opens the same authoritative dialog the typed path uses, with target/date seeded.
   */
  prefill?: ActionPrefill | null;
}) {
  // The Inspector is *contextual*: with nothing selected it does not render, and the board keeps the
  // height. The old dashed "select something" placeholder cost vertical space to say nothing —
  // correction §5.5.
  if (!selection) return null;

  if (selection.kind === 'engineer') {
    const engineer = view.engineers.find((e) => e.seId === selection.id) ?? null;
    return (
      <InspectorFrame title={engineer?.name ?? 'Engineer'} kind="Engineer" onClose={onClose}>
        {engineer ? <EngineerBands engineer={engineer} /> : <NotOnThisDeck what="engineer" />}
      </InspectorFrame>
    );
  }

  if (selection.kind === 'stop') {
    const found = findStop(view, selection.id);
    return (
      <InspectorFrame
        title={found ? found.stop.plantName : 'Stop'}
        kind="Stop"
        onClose={onClose}
      >
        {found ? (
          <StopBands
            stop={found.stop}
            engineer={found.engineer}
            onCommitted={onCommitted}
            onDismiss={onClose}
            prefill={prefill}
          />
        ) : (
          <NotOnThisDeck what="stop" />
        )}
      </InspectorFrame>
    );
  }

  if (selection.kind === 'run') {
    return (
      <InspectorFrame title="What this run did, and why" kind="Run" onClose={onClose}>
        <RunBands runId={selection.id} zoneId={view.zone.zoneId} />
      </InspectorFrame>
    );
  }

  const located = findTicket(view, selection.id);
  return (
    <InspectorFrame title={`Ticket ${selection.id.slice(0, 8)}`} kind="Ticket" onClose={onClose}>
      <TicketBands
        ticketId={selection.id}
        runId={located?.stop.runId ?? view.run?.runId ?? null}
        plantId={located?.stop.plantId ?? unassignedPlantId(view, selection.id)}
        located={located}
        placement={placementOf(view, selection.id, located)}
        onCommitted={onCommitted}
        onDismiss={onClose}
        prefill={prefill}
        operatingDay={view.operatingDay}
      />
    </InspectorFrame>
  );
}

function InspectorFrame({
  title,
  kind,
  onClose,
  children,
}: {
  title: string;
  kind: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <Modal open onClose={onClose} className="max-w-4xl" bodyClassName="p-0">
      <section
        data-testid="console-inspector"
        aria-label="Inspector"
        /* Takes the whole viewport minus the overlay's own 1rem gutter, so the compact case — a drop's
           seeded dialog — fits without scrolling down to laptop heights. Capped rather than unbounded
           because the browsing bands (Alternatives, History) are genuinely long lists; those scroll
           under a header that stays put, so the Close button and the object's name never leave. */
        className="flex max-h-[calc(100vh-2rem)] flex-col"
      >
        <header className="flex flex-wrap items-baseline gap-2 border-b border-line px-3 py-2">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-ink-muted">{kind}</span>
          <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-ink">{title}</h2>
          <button type="button" onClick={onClose} className="text-[11px] text-link" data-testid="inspector-close">
            Close
          </button>
        </header>
        <div className="overflow-y-auto p-3">{children}</div>
      </section>
    </Modal>
  );
}

/**
 * The honest answer when a selection points at something this deck does not hold — a stale deep link,
 * or an object that moved between the URL being shared and the page being opened. It is not an error;
 * it is a fact about today's payload, and it says which.
 */
function NotOnThisDeck({ what }: { what: string }) {
  return (
    <p data-testid="inspector-not-found" className="text-[11px] text-ink-muted">
      That {what} is not on this zone's plan today. It may have been reassigned, or the link may point
      at another zone or another day.
    </p>
  );
}

function EngineerBands({ engineer }: { engineer: TodayEngineer }) {
  const ticketCount = engineer.stops.reduce((n, s) => n + s.tickets.length, 0);
  return (
    <div className="flex flex-col gap-3">
      <Facts
        items={[
          { label: 'Coverage', value: engineer.coverageType.replace(/_/g, ' ') },
          { label: 'Availability', value: engineer.availability.replace(/_/g, ' ').toLowerCase() },
          { label: 'Stops today', value: String(engineer.stops.length) },
          { label: 'Devices today', value: String(ticketCount) },
          { label: 'Day plan', value: engineer.scheduleStatus ?? 'none' },
        ]}
        trailing={
          <LoadBadge committed={engineer.committed} dailyCapacity={engineer.dailyCapacity} seId={engineer.seId} />
        }
      />
      {engineer.overCapacity && (
        <p className="text-[11px] text-warning">
          At or over capacity. Dispatch will not add to this engineer; a human still may.
        </p>
      )}
      {/*
        An engineer is not itself an overridable object — every move is a property of a *stop* or a
        *ticket*, so the Actions band appears when one of those is selected rather than here. The link
        survives as a deep-link target (slice D7 is still open on whether the page retires); it is no
        longer the only way to change this engineer's day.
      */}
      <Links links={[{ to: `/schedules/${engineer.seId}`, label: "Open this engineer's day plan →" }]} />
      <p className="text-[10px] text-ink-muted">
        Select a stop or a ticket on this engineer's lane to move, split, reorder or remove work.
      </p>
    </div>
  );
}

function StopBands({
  stop,
  engineer,
  onCommitted,
  onDismiss,
  prefill,
}: {
  stop: TodayStop;
  engineer: TodayEngineer;
  onCommitted: (moved?: { day: string }) => void;
  /** Cancelling a form closes the overlay, so Cancel and Close mean the same thing to the operator. */
  onDismiss: () => void;
  prefill?: ActionPrefill | null;
}) {
  return (
    <div className="flex flex-col gap-3">
      <Facts
        items={[
          { label: 'Engineer', value: engineer.name },
          { label: 'Stop', value: `#${stop.stopSequence}` },
          { label: 'Plant', value: stop.plantName },
          { label: 'Devices', value: String(stop.tickets.length) },
          { label: 'Status', value: stop.status.replace(/_/g, ' ').toLowerCase() },
        ]}
      />
      <Band title="Devices on this stop">
        <ul className="flex flex-wrap gap-1">
          {stop.tickets.map((t) => (
            <li key={t.ticketId} className="rounded border border-line px-1.5 py-0.5 font-mono text-[11px]">
              {t.ticketId.slice(0, 8)}
            </li>
          ))}
        </ul>
      </Band>
      <Links links={[{ to: `/batches/${stop.batchId}`, label: 'Why dispatch chose this →' }]} />
      <StopActions
        batchId={stop.batchId}
        currentSeId={engineer.seId}
        ticketIds={stop.tickets.map((t) => t.ticketId)}
        stopSequence={stop.stopSequence}
        onCommitted={onCommitted}
        onDismiss={onDismiss}
        prefill={prefill}
      />
    </div>
  );
}

function TicketBands({
  ticketId,
  runId,
  plantId,
  located,
  placement,
  onCommitted,
  onDismiss,
  prefill,
  operatingDay,
}: {
  ticketId: string;
  runId: string | null;
  plantId: string | null;
  located: { stop: TodayStop; engineer: TodayEngineer; ticket: TodayTicket } | null;
  placement: TicketPlacement;
  onCommitted: (moved?: { day: string }) => void;
  /** Cancelling a form closes the overlay, so Cancel and Close mean the same thing to the operator. */
  onDismiss: () => void;
  prefill?: ActionPrefill | null;
  /** Today's operating day — the "from" half of a move's summary line. */
  operatingDay: string;
}) {
  const [band, setBand] = useState<Band>('why');
  const [trace, setTrace] = useState<DispatchTicketTrace | null>(null);
  const [traceError, setTraceError] = useState<string | null>(null);

  useEffect(() => {
    if (!runId) return;
    let live = true;
    setTrace(null);
    setTraceError(null);
    void apiDispatchTicketTrace(runId, ticketId)
      .then((d) => live && setTrace(d))
      .catch(() => live && setTraceError('No decision trace for this ticket in today’s run.'));
    return () => {
      live = false;
    };
  }, [runId, ticketId]);

  const BANDS: { id: Band; label: string }[] = [
    { id: 'why', label: 'Why' },
    { id: 'candidates', label: 'Alternatives' },
    { id: 'history', label: 'History' },
  ];

  return (
    <div className="flex flex-col gap-3">
      {/* IDENTITY, board half.
          Device / vehicle / plant / company / transporter are the *trace's* identity strip and are
          rendered there — this strip deliberately carries only what the trace has no idea about: where
          this ticket sits on today's board, and who put it there. Naming the plant in both places was
          the first thing this Inspector got wrong. */}
      {located && (
        <Facts
          items={[
            { label: 'Engineer', value: located.engineer.name },
            { label: 'Stop', value: `#${located.stop.stopSequence}` },
            ...(located.ticket.slaBucket ? [{ label: 'SLA', value: located.ticket.slaBucket.replace(/_/g, ' ') }] : []),
            ...(located.ticket.companyTier ? [{ label: 'Tier', value: located.ticket.companyTier }] : []),
          ]}
          trailing={<ProvenanceFact ticket={located.ticket} />}
        />
      )}

      <nav aria-label="Inspector band" className="flex gap-1 rounded-md bg-surface-sunken p-0.5">
        {BANDS.map((b) => (
          <button
            key={b.id}
            type="button"
            aria-current={band === b.id}
            data-testid={`inspector-band-${b.id}`}
            onClick={() => setBand(b.id)}
            className={cn(
              'rounded px-2 py-1 text-[11px] transition-colors',
              band === b.id ? 'bg-surface font-semibold text-ink shadow-sm' : 'text-ink-muted hover:text-ink',
            )}
          >
            {b.label}
          </button>
        ))}
      </nav>

      {band === 'why' && (
        <div className="flex flex-col gap-3">
          {!runId ? (
            <p className="text-[11px] text-ink-muted">
              No dispatch run for this zone today, so there is no decision to explain yet.
            </p>
          ) : traceError ? (
            <p data-testid="inspector-no-trace" className="text-[11px] text-ink-muted">
              {traceError}
            </p>
          ) : !trace ? (
            <Skeleton className="h-16 w-full" />
          ) : (
            <>
              <DecisionTraceView data={trace} />
              {/* C7 — served, typed, and until now discarded; **collapsed by default since
                  2026-09-01.** The overlay has to answer a drop without the operator scrolling, and
                  the per-term table is the tallest thing in the band by a wide margin. It is reading
                  material for the rare "why *that* number" question, not part of the decision the
                  dialog is asking for — so it stays one click away rather than being deleted, which
                  would put C7's terms back on the floor they were rescued from. */}
              <details data-testid="score-breakdown-disclosure" className="group">
                <summary className="cursor-pointer list-none text-[10px] font-semibold uppercase tracking-wide text-ink-muted hover:text-ink">
                  Score breakdown
                  <span className="ml-1 font-normal normal-case tracking-normal group-open:hidden">▾</span>
                  <span className="ml-1 hidden font-normal normal-case tracking-normal group-open:inline">▴</span>
                </summary>
                <div className="mt-2">
                  {/* The summary above is this panel's heading, so it does not print a second one. */}
                  <ScoreBreakdownPanel breakdown={trace.scoreBreakdown} titled={false} />
                </div>
              </details>
            </>
          )}
        </div>
      )}

      {band === 'candidates' && <AlternativesBand plantId={plantId} />}

      {band === 'history' && <HistoryBand ticketId={ticketId} />}

      <Links
        links={[
          { to: `/tickets/${ticketId}`, label: 'Ticket journey →' },
          ...(plantId ? [{ to: `/devices?plantId=${encodeURIComponent(plantId)}`, label: 'Devices at this plant →' }] : []),
        ]}
      />
      <TicketActions
        ticketId={ticketId}
        placement={placement}
        currentSeId={located?.engineer.seId ?? null}
        onCommitted={onCommitted}
        onDismiss={onDismiss}
        prefill={prefill}
        sourceDay={operatingDay}
        sourceSeName={located?.engineer.name ?? null}
      />
    </div>
  );
}

/**
 * **Alternatives — the engine's own candidate list, in the engine's own order.**
 *
 * `CandidateColumn` is reused rather than rebuilt, and it is reused *read-only*: `onAssign` is omitted,
 * so the per-row Assign button is hidden. Hidden rather than disabled — assigning from here is a real
 * Phase 2 capability that the operator has approved, and a greyed-out button would advertise it as
 * broken instead of as not-yet-arrived.
 */
function AlternativesBand({ plantId }: { plantId: string | null }) {
  const [plant, setPlant] = useState<PlantCandidates | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!plantId) return;
    let live = true;
    setLoading(true);
    void apiCandidates([plantId])
      .then((v) => live && setPlant(v.plants[0] ?? null))
      .catch(() => live && setPlant(null))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [plantId]);

  if (!plantId) {
    return (
      <p className="text-[11px] text-ink-muted">
        This ticket has no plant on today's payload, so its candidate list cannot be read.
      </p>
    );
  }
  return <CandidateColumn plant={plant} loading={loading} />;
}

function HistoryBand({ ticketId }: { ticketId: string }) {
  const [detail, setDetail] = useState<TicketDetail | null>(null);
  const [attempts, setAttempts] = useState<TicketAttemptHistory | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let live = true;
    setDetail(null);
    setAttempts(null);
    setError(false);
    void apiTicketDetail(ticketId)
      .then((d) => live && setDetail(d))
      .catch(() => live && setError(true));
    // Attempts are independent: a ticket with no attempt history is normal, not a failure.
    void apiTicketAttempts(ticketId)
      .then((a) => live && setAttempts(a))
      .catch(() => live && setAttempts(null));
    return () => {
      live = false;
    };
  }, [ticketId]);

  if (error) return <p className="text-[11px] text-ink-muted">This ticket's history could not be read.</p>;
  if (!detail) return <Skeleton className="h-16 w-full" />;

  return (
    <div className="flex flex-col gap-3">
      <Band title="Lifecycle">
        {detail.lifecycle.length === 0 ? (
          <p className="text-[11px] text-ink-muted">No recorded state changes yet.</p>
        ) : (
          <ol className="flex flex-col gap-1">
            {detail.lifecycle.map((e, i) => (
              <li key={`${e.at}-${i}`} className="flex flex-wrap items-baseline gap-1.5 text-[11px]">
                <span className="tabular-nums text-ink-muted">{new Date(e.at).toLocaleString()}</span>
                <span className="text-ink">
                  {e.fromState ? `${e.fromState} → ` : ''}
                  {e.toState}
                </span>
                {e.reasonCode && <Badge tone="neutral">{e.reasonCode}</Badge>}
                {e.actorRole && <span className="text-ink-muted">by {e.actorRole.replace(/_/g, ' ')}</span>}
              </li>
            ))}
          </ol>
        )}
      </Band>

      {attempts && (
        <Band
          title={`Attempts — ${attempts.countableAttempts} countable of ${attempts.threshold} threshold`}
        >
          {attempts.isSpecial && (
            <p className="mb-1 text-[11px] text-warning">
              Special: this ticket has reached the repeated-attempt threshold.
            </p>
          )}
          {attempts.attempts.length === 0 ? (
            <p className="text-[11px] text-ink-muted">No visit attempts recorded.</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {attempts.attempts.map((a) => (
                <li key={a.attemptId} className="flex flex-wrap items-baseline gap-1.5 text-[11px]">
                  <span className="tabular-nums text-ink-muted">{new Date(a.openedAt).toLocaleDateString()}</span>
                  <span className="text-ink">{a.seName ?? a.seId ?? '—'}</span>
                  <Badge tone={a.submitted ? 'success' : a.reached ? 'info' : 'neutral'}>
                    {a.submitted ? 'submitted' : a.reached ? 'reached' : 'not reached'}
                  </Badge>
                  {a.closedAt === null && <Badge tone="info">in progress</Badge>}
                  {a.removalReason && <span className="text-ink-muted">{a.removalReason}</span>}
                </li>
              ))}
            </ul>
          )}
        </Band>
      )}

      <Links links={[{ to: `/tickets/${ticketId}`, label: 'Full ticket detail, forms and photos →' }]} />
    </div>
  );
}

/**
 * **The run's own decisions, in the order the engine made them** (#285 AC8, #284 §C) — the old
 * Replay mode, relocated. The mode nav dissolved into the day axis (correction §4): a run is now an
 * *inspectable object*, reached from the today column's "Run decisions →" header link, and this band
 * is its Inspector view.
 *
 * `processing_rank` is the whole reason this is a replay and not a report: it is the order the
 * engine actually considered tickets in, and any other sort describes the same decisions in an order
 * the run never used. An **unassignable** decision is a decision and gets a row — listing only the
 * placements would show a run doing less than it did (#282 R6's class of omission).
 */
function RunBands({ runId, zoneId }: { runId: string; zoneId: string }) {
  const [data, setData] = useState<DispatchRunDecisions | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openTicket, setOpenTicket] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setData(null);
    setError(null);
    setOpenTicket(null);
    apiDispatchRunDecisions(runId, { zoneId })
      .then((d) => live && setData(d))
      .catch((e: unknown) => live && setError(e instanceof Error ? e.message : 'Failed to load the decisions'));
    return () => {
      live = false;
    };
  }, [runId, zoneId]);

  if (error) return <p className="text-[11px] text-ink-muted">Could not load this run's decisions — {error}</p>;
  if (!data) return <Skeleton className="h-16 w-full" />;
  if (data.rows.length === 0) {
    return (
      <p data-testid="replay-empty" className="text-[11px] text-ink-muted">
        This run recorded no decisions for this zone.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="text-[11px] text-ink-muted">
        Decisions in the order the engine made them. Open one for the candidates it compared, the tier
        it evaluated and the capacity at the moment it chose.
      </p>
      <ul className="divide-y divide-line">
        {data.rows.map((d) => (
          <li key={d.ticketId} data-testid={`decision-row-${d.ticketId}`} className="py-1.5">
            <div className="flex flex-wrap items-center gap-2 text-[11px]">
              <span className="tabular-nums text-ink-muted">
                {d.processingRank == null ? '—' : ordinal(d.processingRank)}
              </span>
              <Link to={`/tickets/${d.ticketId}`} className="font-mono text-link">
                {d.ticketId.slice(0, 8)}
              </Link>
              <span className="text-ink">{d.plantName ?? d.plantId ?? '—'}</span>
              {d.deviceBucket && <Badge tone="neutral">{d.deviceBucket.replace('_', ' ')}</Badge>}
              {d.seName ? (
                <span className="text-ink">{d.seName}</span>
              ) : (
                <span className="text-warning">
                  Unassignable
                  {d.poolEmptyReason && ` — ${POOL_EMPTY_LABEL[d.poolEmptyReason as PoolEmptyReason] ?? d.poolEmptyReason}`}
                </span>
              )}
              {d.status && d.status !== 'DISPATCHED' && d.status !== 'UNASSIGNABLE' && (
                // RETIRED (#286) and SUGGESTED both mean "intended, not placed" — worth saying,
                // because the row otherwise reads as work that landed on somebody's plan.
                <Badge tone="warning">{d.status.toLowerCase()}</Badge>
              )}
              <button
                type="button"
                className="ml-auto text-link"
                aria-expanded={openTicket === d.ticketId}
                onClick={() => setOpenTicket(openTicket === d.ticketId ? null : d.ticketId)}
              >
                {openTicket === d.ticketId ? 'Hide why' : 'Why?'}
              </button>
            </div>
            {openTicket === d.ticketId && (
              <div className="mt-2">
                <TracePanel runId={runId} ticketId={d.ticketId} />
              </div>
            )}
          </li>
        ))}
      </ul>
      {data.total > data.rows.length && (
        <p className="text-[10px] text-ink-muted">
          Showing the first {data.rows.length} of {data.total} decisions.
        </p>
      )}
      <Links
        links={[
          { to: `/dispatch-runs/${runId}`, label: 'Run detail →' },
          { to: '/dispatch-runs', label: 'All runs →' },
        ]}
      />
    </div>
  );
}

/** The provenance grammar as a fact rather than a chip — same rule, different context (#282 R2). */
function ProvenanceFact({ ticket }: { ticket: TodayTicket }) {
  if (ticket.addSource == null) {
    return <Badge tone="neutral">provenance not recorded</Badge>;
  }
  if (ticket.systemPlaced) return <Badge tone="neutral">placed by the scheduler</Badge>;
  const crossed = ticket.coverageTypeAtAssign === 'FLOATING' || ticket.coverageTypeAtAssign === 'NONE';
  return (
    // Tier crossing is violet — its own tone, never `warning`: amber already means over capacity,
    // and one colour for two meanings is the collision #290 fixed (field-ops review, Identity band).
    <Badge tone={crossed ? 'tierCross' : 'neutral'}>
      {crossed ? `human override — crossed to ${ticket.coverageTypeAtAssign}` : 'human override'}
    </Badge>
  );
}

function Facts({
  items,
  trailing,
}: {
  items: { label: string; value: string }[];
  trailing?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-1 rounded-md border border-line bg-surface-sunken px-3 py-2">
      {items.map((f) => (
        <span key={f.label} className="text-[11px]">
          <span className="font-semibold uppercase tracking-wider text-ink-muted">{f.label} </span>
          <span className="text-ink">{f.value}</span>
        </span>
      ))}
      {trailing && <span className="ml-auto">{trailing}</span>}
    </div>
  );
}

function Band({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-ink-muted">{title}</h3>
      {children}
    </div>
  );
}

function Links({ links }: { links: { to: string; label: string }[] }) {
  if (links.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 border-t border-line pt-2 text-[11px]">
      {links.map((l) => (
        <Link key={l.to} to={l.to} className="text-link">
          {l.label}
        </Link>
      ))}
    </div>
  );
}

/**
 * **Which actions are legal for this ticket, decided from where the ticket actually is.**
 *
 * The approved direction forbids rendering the union of every control with the illegal ones greyed
 * out, and this function is where that rule is enforced rather than repeated. The three placements are
 * mutually exclusive *by the data*, not by a preference:
 *
 * - **PLACED** — the ticket is on a stop, so it has a `batchId`, and `POST /batches/:id/override` is
 *   the door. Assign is not offered: `assignTicket` refuses an already-assigned ticket, so an Assign
 *   button here would be a button that always fails.
 * - **UNPLACED** — nobody holds it. There is no batch, so there is nothing to override; Assign and
 *   Hold are the two real actions.
 * - **HELD** — it is deliberately out of the runs until a date. Releasing is the only live action; the
 *   hold itself was already a decision, and offering "Hold" again would invite an operator to overwrite
 *   their own return date without seeing it.
 *
 * A ticket found on no rail and no lane resolves to UNPLACED, which offers the two safest actions and
 * lets the server refuse if the client's picture is stale.
 */
function placementOf(
  view: DispatchTodayView,
  ticketId: string,
  located: { stop: TodayStop; engineer: TodayEngineer; ticket: TodayTicket } | null,
): TicketPlacement {
  if (located) return { kind: 'PLACED', batchId: located.stop.batchId, seId: located.engineer.seId };
  const held = view.rails.held.find((h) => h.ticketId === ticketId);
  if (held) return { kind: 'HELD', heldUntil: held.heldUntil };
  return { kind: 'UNPLACED' };
}

function findTicket(
  view: DispatchTodayView,
  ticketId: string,
): { stop: TodayStop; engineer: TodayEngineer; ticket: TodayTicket } | null {
  for (const engineer of view.engineers) {
    for (const stop of engineer.stops) {
      const ticket = stop.tickets.find((t) => t.ticketId === ticketId);
      if (ticket) return { stop, engineer, ticket };
    }
  }
  return null;
}

function findStop(view: DispatchTodayView, batchId: string): { stop: TodayStop; engineer: TodayEngineer } | null {
  for (const engineer of view.engineers) {
    const stop = engineer.stops.find((s) => s.batchId === batchId);
    if (stop) return { stop, engineer };
  }
  return null;
}

/** A ticket selected from the Unassignable rail is on no stop, but the rail knows its plant. */
function unassignedPlantId(view: DispatchTodayView, ticketId: string): string | null {
  return view.rails.unassignable.find((u) => u.ticketId === ticketId)?.plantId ?? null;
}
