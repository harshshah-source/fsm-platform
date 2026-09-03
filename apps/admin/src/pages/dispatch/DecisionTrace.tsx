import { useEffect, useState } from 'react';
import { apiDispatchTicketTrace, type DispatchTicketTrace } from '../../api/dispatch-runs';
import { Skeleton } from '../../components/data';
import { Badge } from '../../components/ui';
import { POOL_EMPTY_LABEL, ordinal } from './format';

/**
 * The per-ticket "why this SE" decision trace (Issue 123), explained in PRECEDENCE terms. While the
 * run's scores are degenerate (all candidates score identically until travel-distance scoring lands),
 * no numeric score is shown — the pick is precedence: coverage tier first, then order. Chosen +
 * bounded runners-up, each with their pass/drop verdict; drop COUNTS, never raw dropped rows.
 */
export function DecisionTraceView({ data }: { data: DispatchTicketTrace }) {
  const t = data.trace;
  // `identity` may be absent when read from an older backend build (version skew) — guard so the
  // trace still renders its precedence narrative rather than crashing.
  const id = data.identity;
  const name = (seId: string | null) => (seId ? (data.seNames[seId] ?? seId.slice(0, 8)) : '—');
  const dropEntries = Object.entries(t.dropCounts ?? {});
  const idParts = (
    id
      ? [
          id.deviceId && { label: 'Device', value: id.deviceId },
          id.vehicleNo && { label: 'Vehicle', value: id.vehicleNo },
          id.plantName && { label: 'Plant', value: id.plantName },
          id.companyName && { label: 'Company', value: id.companyName },
          id.transporterName && { label: 'Transporter', value: id.transporterName },
        ]
      : []
  ).filter((p): p is { label: string; value: string } => Boolean(p));

  return (
    <div className="space-y-3 text-sm">
      {idParts.length > 0 && (
        <div
          data-testid="trace-identity"
          className="flex flex-wrap gap-x-5 gap-y-1 rounded-md border border-line bg-surface-card px-3 py-2"
        >
          {idParts.map((p) => (
            <span key={p.label} className="text-xs">
              <span className="font-semibold uppercase tracking-wider text-ink-caps">{p.label} </span>
              <span className="text-ink">{p.value}</span>
            </span>
          ))}
        </div>
      )}

      {t.chosen ? (
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold text-ink-strong">Chosen: {name(t.chosen.seId)}</span>
            <Badge tone="neutral">{t.chosen.coverageType}</Badge>
            {t.chosen.plannerBias && <Badge tone="brand">SE-Planner bias</Badge>}
            {t.chosen.clusterSeed && <Badge tone="info">Cluster seed</Badge>}
            {/* #266 — the number that actually chose this engineer, beside the runners-up it beat. */}
            {t.chosen.score !== null && t.chosen.score !== undefined && (
              <span className="text-xs tabular-nums text-ink-muted">score {t.chosen.score.toFixed(2)}</span>
            )}
          </div>
          <p className="mt-1 text-ink-muted">
            {ordinal(t.chosen.precedenceRank)} of {t.candidatesTotal} eligible engineer{t.candidatesTotal === 1 ? '' : 's'} by
            precedence. SE load at decision: {t.chosen.capacityAtDecision.used}
            {t.chosen.capacityAtDecision.cap != null ? ` / ${t.chosen.capacityAtDecision.cap}` : ''}.
          </p>
        </div>
      ) : (
        <div>
          <span className="font-semibold text-critical">Unassignable</span>
          {t.poolEmptyReason && <span className="ml-2 text-ink-muted">— {POOL_EMPTY_LABEL[t.poolEmptyReason]}</span>}
        </div>
      )}

      {/*
        #266 — the copy no longer blames travel distance. `scoreDegenerate` used to be derived from
        `distance` being unweighted, so this sentence was the true explanation; it is now derived from
        the scores that were actually computed, and they can differ today via same-plant clustering.
        Naming distance here would send an operator to a setting that is not the reason.
      */}
      {t.scoreDegenerate && (
        <p className="rounded-md bg-surface-sunken px-3 py-2 text-xs text-ink-muted">
          Every candidate scored the same, so this pick was decided by precedence (coverage tier first, then
          order) rather than by a score.
        </p>
      )}

      {t.runnersUp.length > 0 && (
        <div>
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-ink-caps">
            Runners-up (top {t.runnersUp.length})
          </div>
          <ul className="space-y-1">
            {t.runnersUp.map((r, i) => (
              <li key={`${r.seId}-${i}`} className="flex flex-wrap items-center gap-2">
                <span className="text-ink">
                  {ordinal(r.precedenceRank)}. {name(r.seId)}
                </span>
                <Badge tone="neutral">{r.coverageType}</Badge>
                {/*
                  #266 — a never-reached tier is neutral, not a warning. Amber here would tell the
                  operator something went wrong for this candidate; nothing did. The winning tier was
                  decided first and this one was simply never consulted.
                */}
                <Badge tone={r.verdict === 'PASSED' ? 'success' : r.verdict === 'DROPPED' ? 'warning' : 'neutral'}>
                  {r.verdict}
                </Badge>
                {/*
                  #266 — the runner-up's OWN score. It decides the winner now, so it has to be visible:
                  these numbers used to all be the winner's, which displayed as a tie the engine never
                  saw. A candidate whose tier was never reached has no score, and showing one would
                  re-tell exactly the lie this slice removed.
                */}
                {r.score !== null && r.score !== undefined && (
                  <span className="text-xs tabular-nums text-ink-muted">{r.score.toFixed(2)}</span>
                )}
                {r.dropReason && <span className="text-xs text-ink-muted">{r.dropReason}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {dropEntries.length > 0 && (
        <p className="text-xs text-ink-muted">
          Dropped candidates: {dropEntries.map(([reason, n]) => `${reason} ×${n}`).join(' · ')}
        </p>
      )}

      {/*
        #270 — never render a stubbed feed as though it were a genuine pass. VEHICLE_ON_TRIP and
        COMPONENT_UNAVAILABLE cannot fire until Issue 65/22's feeds exist, so this trace never claims
        either was evaluated — distinct, muted, and separate from the real drop reasons above.
      */}
      {t.notEnforcedFilters && t.notEnforcedFilters.length > 0 && (
        <p className="rounded-md bg-surface-sunken px-3 py-2 text-xs text-ink-muted" data-testid="not-enforced-filters">
          Not enforced — data source pending: {t.notEnforcedFilters.join(', ')} (#65/#22)
        </p>
      )}
    </div>
  );
}

/** Lazily fetches a ticket's trace when its row is expanded, then renders the precedence narrative. */
export function TracePanel({ runId, ticketId }: { runId: string; ticketId: string }) {
  const [data, setData] = useState<DispatchTicketTrace | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    apiDispatchTicketTrace(runId, ticketId)
      .then((d) => live && setData(d))
      .catch(() => live && setError('Failed to load the decision trace'));
    return () => {
      live = false;
    };
  }, [runId, ticketId]);

  if (error) return <p className="text-sm text-critical" role="alert">{error}</p>;
  if (!data) return <Skeleton className="h-16 w-full" />;
  return <DecisionTraceView data={data} />;
}
