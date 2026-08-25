import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  apiDispatchChangesToday,
  apiDispatchToday,
  SE_UNAVAILABLE,
  type DispatchChangesTodayView,
  type DispatchTodayView,
} from '../../api/dispatchToday';
import { EmptyState, MetricStrip, PageHeader, type Metric } from '../../components/data';
import { Badge } from '../../components/ui';
import { Button } from '../../components/ui/Button';
import {
  apiDispatchRunDecisions,
  type DispatchRunDecisions,
  type PoolEmptyReason,
} from '../../api/dispatch-runs';
import { CrewCard, ProvenanceLegend } from './CrewCard';
import { TracePanel } from './DecisionTrace';
import { POOL_EMPTY_LABEL, ordinal } from './format';

type Mode = 'plan' | 'live' | 'replay';

const MODES: { id: Mode; label: string; question: string }[] = [
  { id: 'plan', label: 'Plan', question: 'What the next run will do' },
  { id: 'live', label: 'Live', question: 'What is happening today' },
  { id: 'replay', label: 'Replay', question: 'What a past run did, and why' },
];

/**
 * Today's Dispatch — the scheduler engine's operator cockpit (#285, design #282).
 *
 * One zone, one operating day, three modes over one layout. It is a **composition**, not a new
 * engine: every number comes from `GET /dispatch/today`, which itself reads the persisted plan and
 * the one shared capacity counter (#269). Nothing here decides anything, and nothing here is
 * hard-coded — the wireframe's "42 placed · 3 unassignable" are example values, and #282 R6 forbids
 * shipping them.
 *
 * Plan stays deliberately thin: it links to the Scheduler Preview that already owns the projection
 * (#250/#251) rather than reimplementing it. Replay is no longer thin — #284's decision stream landed,
 * so it lists the run's own decisions in `processing_rank` order and expands each into the existing
 * `TracePanel`, which is what #285 AC8 asked for and what a pair of links could not deliver. Live is
 * the mode that had no home at all before.
 */
export default function TodaysDispatchPage() {
  const [params, setParams] = useSearchParams();
  const mode = (params.get('mode') as Mode | null) ?? 'live';
  const zoneParam = params.get('zoneId') ?? undefined;

  const [view, setView] = useState<DispatchTodayView | null>(null);
  const [changes, setChanges] = useState<DispatchChangesTodayView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    apiDispatchToday(zoneParam)
      .then((v) => alive && setView(v))
      .catch((e: Error) => alive && setError(e.message || 'Failed to load today’s dispatch'))
      .finally(() => alive && setLoading(false));
    // The change ledger is secondary content: its failure must not take the deck down with it.
    apiDispatchChangesToday(zoneParam)
      .then((c) => alive && setChanges(c))
      .catch(() => alive && setChanges(null));
    return () => {
      alive = false;
    };
  }, [zoneParam]);

  useEffect(() => load(), [load]);

  const setMode = (next: Mode) => {
    const p = new URLSearchParams(params);
    p.set('mode', next);
    setParams(p, { replace: true });
  };

  const metrics: Metric[] = useMemo(() => {
    const s = view?.situation;
    return [
      { label: 'Placed', value: s?.placed ?? 0, hint: 'devices on a plan today', tone: 'brand' },
      { label: 'Unassignable', value: s?.unassignable ?? 0, hint: 'no eligible engineer', tone: 'warning' },
      { label: 'Held', value: s?.held ?? 0, hint: 'deferred past today', tone: 'info' },
      { label: 'Critical needs you', value: s?.criticalNeedsYou ?? 0, hint: 'escalated to a human', tone: 'critical' },
      { label: 'Over capacity', value: s?.overCapacity ?? 0, hint: 'engineers at or past cap', tone: 'warning' },
      { label: 'Changes today', value: s?.changesToday ?? 0, hint: 'since dispatch', tone: 'neutral' },
    ];
  }, [view]);

  if (loading && !view) {
    return (
      <div className="flex flex-col gap-4">
        <PageHeader title="Today's Dispatch" subtitle="Loading the operating day…" />
        <div className="h-40 animate-pulse rounded-lg border border-line bg-surface-sunken" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col gap-4">
        <PageHeader title="Today's Dispatch" />
        <EmptyState
          message={`Could not load today’s dispatch — ${error}`}
          action={<Button onClick={load}>Try again</Button>}
        />
      </div>
    );
  }

  if (!view) return null;

  const run = view.run;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Today's Dispatch"
        subtitle={`${view.zone.name} · ${view.operatingDay}`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {run ? (
              <Badge tone={run.status === 'SUCCESS' ? 'success' : run.status === 'RUNNING' ? 'info' : 'warning'} dot>
                {run.status === 'RUNNING'
                  ? 'Dispatch running'
                  : `Dispatched ${new Date(run.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · ${run.status}`}
              </Badge>
            ) : (
              <Badge tone="neutral">No run today</Badge>
            )}
            <Button onClick={load} variant="secondary">
              Refresh
            </Button>
          </div>
        }
      />

      <nav aria-label="Dispatch mode" className="flex flex-wrap gap-1 rounded-lg bg-surface-sunken p-1">
        {MODES.map((m) => (
          <button
            key={m.id}
            type="button"
            onClick={() => setMode(m.id)}
            aria-current={mode === m.id}
            data-testid={`mode-${m.id}`}
            className={[
              'rounded-md px-3 py-1.5 text-sm transition-colors',
              mode === m.id ? 'bg-surface font-semibold text-ink shadow-sm' : 'text-ink-muted hover:text-ink',
            ].join(' ')}
          >
            {m.label}
            <span className="ml-2 hidden text-[10px] font-normal text-ink-muted sm:inline">{m.question}</span>
          </button>
        ))}
      </nav>

      <MetricStrip metrics={metrics} />

      {view.recovery && <RecoveryNotice recovery={view.recovery} />}

      {view.escalations.length > 0 && (
        <section
          data-testid="critical-interception"
          className="rounded-lg border-2 border-critical bg-critical-bg/40 p-3"
        >
          <h2 className="text-sm font-semibold text-critical">
            {view.escalations.length} critical{' '}
            {view.escalations.length === 1 ? 'ticket needs' : 'tickets need'} manual assignment
          </h2>
          {/* #288 — the capacity sentence is only printed when it is true of every row. Two causes now
              write an escalation: no capacity-eligible engineer (#268), and an engineer going
              unavailable on work already committed to them. One explanation over a mixed list would be
              wrong about half of it, so each row carries its own instead. */}
          {view.escalations.every((e) => e.insertionType !== SE_UNAVAILABLE) && (
            <p className="mt-0.5 text-[11px] text-ink-muted">
              No capacity-eligible engineer was available, so the scheduler escalated rather than
              overloading anyone.
            </p>
          )}
          <ul className="mt-2 flex flex-col gap-1">
            {view.escalations.map((e) => (
              <li key={e.insertionId} className="flex flex-wrap items-center gap-2 text-[11px]">
                <Link to={`/tickets/${e.ticketId}`} className="font-mono text-link">
                  {e.ticketId.slice(0, 8)}
                </Link>
                {e.slaBucket && <Badge tone="critical">{e.slaBucket.replace('_', ' ')}</Badge>}
                <span className="text-ink-muted">
                  escalated {new Date(e.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
                {e.insertionType === SE_UNAVAILABLE && (
                  <span className="text-ink">
                    {e.assignedSeName ?? e.assignedSeId ?? 'The assigned engineer'} is unavailable
                  </span>
                )}
                {/* Assign is the door for work nobody holds. Stranded work is still formally assigned
                    (escalate-only, #282 R4), and `assignTicket` refuses an assigned ticket — so the
                    door that works is a reassign on the holder's day plan. */}
                {e.assignedSeId ? (
                  <Link to={`/schedules/${e.assignedSeId}`} className="ml-auto text-link">
                    Reassign on the day plan →
                  </Link>
                ) : (
                  <Link to="/intraday" className="ml-auto text-link">
                    Assign manually →
                  </Link>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {mode === 'plan' && <PlanMode zoneId={view.zone.zoneId} />}
      {mode === 'replay' && <ReplayMode runId={run?.runId ?? null} zoneId={view.zone.zoneId} />}

      {mode === 'live' && (
        <div className="grid gap-4 lg:grid-cols-[1fr_18rem]">
          <section className="flex flex-col gap-3">
            <div className="flex items-baseline justify-between">
              <h2 className="text-sm font-semibold text-ink">Crew</h2>
              <span className="text-[11px] text-ink-muted">{view.engineers.length} engineers</span>
            </div>
            {view.engineers.length === 0 ? (
              <EmptyState message="No engineers on this zone's roster yet." />
            ) : (
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {view.engineers.map((e) => (
                  <CrewCard key={e.seId} engineer={e} />
                ))}
              </div>
            )}
            <ProvenanceLegend />
          </section>

          <aside className="flex flex-col gap-3">
            <Rail
              title="Unassignable"
              count={view.rails.unassignable.length}
              empty="Everything found an engineer."
            >
              {view.rails.unassignable.map((u) => (
                <li key={u.ticketId} className="flex flex-col">
                  <Link to={`/tickets/${u.ticketId}`} className="font-mono text-link">
                    {u.deviceId ?? u.ticketId.slice(0, 8)}
                  </Link>
                  <span className="text-ink-muted">
                    {u.plantName ?? '—'} ·{' '}
                    {u.poolEmptyReason === 'NO_COVERAGE'
                      ? 'no coverage'
                      : u.poolEmptyReason === 'ALL_DROPPED'
                        ? 'all candidates dropped'
                        : 'reason not recorded'}
                  </span>
                </li>
              ))}
            </Rail>

            <Rail title="Held / deferred" count={view.rails.held.length} empty="Nothing is being held back.">
              {view.rails.held.map((h) => (
                <li key={h.ticketId} className="flex flex-col">
                  <Link to={`/tickets/${h.ticketId}`} className="font-mono text-link">
                    {h.deviceId ?? h.ticketId.slice(0, 8)}
                  </Link>
                  <span className="text-ink-muted">
                    {h.plantName ?? '—'} · returns {h.heldUntil}
                    {h.decidedBy ? ' · manager-approved' : ''}
                  </span>
                </li>
              ))}
            </Rail>

            <section className="rounded-lg border border-line bg-surface p-3">
              <h3 className="flex items-baseline justify-between text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
                Withheld by policy
                <span className="tabular-nums text-ink">{view.rails.policyWithheld.count}</span>
              </h3>
              {/* The engine counts this work and never itemises it — those tickets get no
                  recommendation, no row and no trace. Saying "a count, not a list" is the honest
                  rendering; a truncated-looking list would be an invention. */}
              <p className="mt-1 text-[10px] text-ink-muted">
                Below the assignment threshold. Counted by the run, not itemised.
              </p>
            </section>

            <Rail
              title="Changes today"
              count={changes?.counts.total ?? 0}
              empty="Nobody has changed today's plan."
              subtitle={
                changes
                  ? `${changes.counts.adds} adds · ${changes.counts.removes} removes · ${changes.counts.swaps} swaps`
                  : undefined
              }
            >
              {(changes?.changes ?? []).slice(0, 8).map((c, i) => (
                <li key={`${c.ticketId}-${c.at}-${i}`} className="flex flex-col">
                  <span>
                    <Badge tone={c.kind === 'SWAP' ? 'warning' : c.kind === 'ADD' ? 'info' : 'neutral'}>
                      {c.kind.toLowerCase()}
                    </Badge>{' '}
                    <Link to={`/tickets/${c.ticketId}`} className="font-mono text-link">
                      {c.ticketId.slice(0, 8)}
                    </Link>
                  </span>
                  {c.reason && <span className="text-ink-muted">{c.reason}</span>}
                </li>
              ))}
            </Rail>
          </aside>
        </div>
      )}
    </div>
  );
}

/**
 * #286 — what happened to a zone whose dispatch run died this morning.
 *
 * Rendered above the deck rather than in the work rail on purpose: it is not a queue of work, it is a
 * statement about whether this zone's day is intact. Four states, and the operator has to be able to
 * tell them apart at a glance —
 *  - `RECOVERED`: the system put it right by itself. Reassurance, not an alarm.
 *  - `PENDING`: still owed, and the collector will come back for it.
 *  - `EXHAUSTED`: the system tried its budget and stopped. Somebody has to look.
 *  - `EXPIRED`: the field day ran out first. The work did not happen and will not happen today.
 *
 * The attempt count and the last failure are shown for the two that need action, because "it gave up"
 * without saying after how many tries or why is an alert nobody can act on.
 */
function RecoveryNotice({ recovery }: { recovery: NonNullable<DispatchTodayView['recovery']> }) {
  const needsAction = recovery.state === 'EXHAUSTED' || recovery.state === 'EXPIRED';
  const headline =
    recovery.state === 'RECOVERED'
      ? "This zone's dispatch run died and was automatically re-dispatched"
      : recovery.state === 'PENDING'
        ? "This zone's dispatch run died — a re-dispatch is queued"
        : recovery.state === 'EXHAUSTED'
          ? "This zone's dispatch run died and could not be recovered automatically"
          : "This zone's dispatch run died and the operating day ended before it could be recovered";

  return (
    <section
      data-testid="recovery-notice"
      className={[
        'rounded-lg border p-3',
        needsAction ? 'border-2 border-warning bg-warning-bg/40' : 'border-line bg-surface',
      ].join(' ')}
    >
      <h2 className={['text-sm font-semibold', needsAction ? 'text-warning' : 'text-ink'].join(' ')}>{headline}</h2>
      <p className="mt-0.5 text-[11px] text-ink-muted">
        Detected {new Date(recovery.markedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} ·{' '}
        <span className="tabular-nums">{recovery.attempts}</span>{' '}
        {recovery.attempts === 1 ? 'attempt' : 'attempts'}
        {recovery.lastAttemptAt && (
          <>
            {' '}
            · last tried{' '}
            {new Date(recovery.lastAttemptAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </>
        )}
      </p>
      {recovery.lastError && <p className="mt-1 text-[11px] text-ink">{recovery.lastError}</p>}
      {needsAction && (
        <p className="mt-1 text-[11px] text-ink-muted">
          Nothing further will be attempted automatically today — run dispatch for this zone manually
          once the cause is cleared.
        </p>
      )}
    </section>
  );
}

function Rail({
  title,
  count,
  empty,
  subtitle,
  children,
}: {
  title: string;
  count: number;
  empty: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border border-line bg-surface p-3">
      <h3 className="flex items-baseline justify-between text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
        {title}
        <span className="tabular-nums text-ink">{count}</span>
      </h3>
      {subtitle && <p className="mt-0.5 text-[10px] text-ink-muted">{subtitle}</p>}
      {count === 0 ? (
        <p className="mt-1 text-[10px] text-ink-muted">{empty}</p>
      ) : (
        <ul className="mt-2 flex flex-col gap-1.5 text-[11px]">{children}</ul>
      )}
    </section>
  );
}

/**
 * Plan mode points at the projection that already exists rather than rebuilding it.
 *
 * #250 made the preview project the *real* recommender and #251 shipped the page; #282 R5 says reuse
 * it. What the cockpit adds is adjacency — the projection and the button that executes it finally in
 * one place, instead of two nav groups apart.
 */
function PlanMode({ zoneId }: { zoneId: string }) {
  return (
    <section className="rounded-lg border border-line bg-surface p-4">
      <h2 className="text-sm font-semibold text-ink">What the next run will do</h2>
      <p className="mt-1 max-w-prose text-[12px] text-ink-muted">
        The projection runs the real recommender with every write suppressed, so it is what would
        happen — not a second scheduler’s opinion. Holding a ticket back is the only change available
        before a run; approval was never required.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Link to={`/schedules/preview?zoneId=${encodeURIComponent(zoneId)}`}>
          <Button>Open the projection</Button>
        </Link>
        <Link to="/bulk-unassign">
          <Button variant="secondary">Run dispatch</Button>
        </Link>
      </div>
    </section>
  );
}

/**
 * Replay — the run's own decisions, in the order the engine made them (#285 AC8, #284 §C).
 *
 * `processing_rank` is the whole reason this is a replay and not a report: it is the order the engine
 * actually considered tickets in, and any other sort describes the same decisions in an order the run
 * never used. Each row expands into the per-ticket trace that already owns "why this SE" — the deep
 * view is not rebuilt here, it is reached from here.
 *
 * An **unassignable** decision is a decision and gets a row. Listing only the placements would show a
 * run doing less than it did, which is the same class of omission #282 R6 forbids on the counters.
 */
function ReplayMode({ runId, zoneId }: { runId: string | null; zoneId: string }) {
  const [data, setData] = useState<DispatchRunDecisions | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openTicket, setOpenTicket] = useState<string | null>(null);

  useEffect(() => {
    if (!runId) return;
    let live = true;
    setData(null);
    setError(null);
    apiDispatchRunDecisions(runId, { zoneId })
      .then((d) => live && setData(d))
      .catch((e: unknown) => live && setError(e instanceof Error ? e.message : 'Failed to load the decisions'));
    return () => {
      live = false;
    };
  }, [runId, zoneId]);

  return (
    <section className="flex flex-col gap-3">
      <div className="rounded-lg border border-line bg-surface p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold text-ink">What a past run did, and why</h2>
          <div className="flex flex-wrap gap-2">
            {runId && (
              <Link to={`/dispatch-runs/${runId}`}>
                <Button variant="secondary">Run detail</Button>
              </Link>
            )}
            <Link to="/dispatch-runs">
              <Button variant="secondary">All runs</Button>
            </Link>
          </div>
        </div>
        <p className="mt-1 max-w-prose text-[12px] text-ink-muted">
          Decisions in the order the engine made them. Open one for the candidates it compared, the
          tier it evaluated and the capacity at the moment it chose.
        </p>
      </div>

      {!runId ? (
        <EmptyState message="No dispatch run for this zone today — there is nothing to replay yet." />
      ) : error ? (
        <EmptyState message={`Could not load this run’s decisions — ${error}`} />
      ) : !data ? (
        <EmptyState message="Loading decisions…" />
      ) : data.rows.length === 0 ? (
        <div data-testid="replay-empty">
          <EmptyState message="This run recorded no decisions for this zone." />
        </div>
      ) : (
        <section className="rounded-lg border border-line bg-surface">
          <h3 className="border-b border-line px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
            Decisions
            <span className="ml-2 tabular-nums text-ink">
              {data.rows.length} of {data.total}
            </span>
          </h3>
          <ul className="divide-y divide-line">
            {data.rows.map((d) => (
              <li key={d.ticketId} data-testid={`decision-row-${d.ticketId}`} className="px-3 py-2">
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
                {openTicket === d.ticketId && runId && (
                  <div className="mt-2">
                    <TracePanel runId={runId} ticketId={d.ticketId} />
                  </div>
                )}
              </li>
            ))}
          </ul>
          {data.total > data.rows.length && (
            <p className="border-t border-line px-3 py-2 text-[10px] text-ink-muted">
              Showing the first {data.rows.length} of {data.total} decisions. Open the run detail for
              the full ledger.
            </p>
          )}
        </section>
      )}
    </section>
  );
}
