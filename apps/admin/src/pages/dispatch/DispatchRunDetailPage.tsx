import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { apiDispatchRunDetail, type DispatchRunDetail, type DispatchRunZoneCard } from '../../api/dispatch-runs';
import { ErrorState, MetricStrip, PageHeader, type Metric } from '../../components/data';
import { Badge, Card } from '../../components/ui';
import { ConfigInEffectPanel } from './ConfigInEffectPanel';
import { MODE_TONE, STATUS_TONE, formatDateTime, formatDuration, triggerActor } from './format';

/**
 * Dispatch run detail (Issue 123) — the run summary, the configuration frozen at run start, and one
 * card per zone (a ZM sees only their own). Each zone card drills into the zone's batches + decision
 * traces. Read-only.
 */
export function DispatchRunDetailPage() {
  const { runId = '' } = useParams();
  const navigate = useNavigate();
  const [detail, setDetail] = useState<DispatchRunDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    setError(null);
    setDetail(null);
    apiDispatchRunDetail(runId)
      .then(setDetail)
      .catch(() => setError('Failed to load this dispatch run'));
  };
  useEffect(load, [runId]);

  const metrics: Metric[] = detail
    ? [
        // #259 — zones this run WORKED. A contended zone still gets a card below (it is part of what
        // the run asked for), but counting it here would disagree with the same run's row in the runs
        // list, which reports the ledger's own `zones` column.
        {
          label: 'Zones',
          value: detail.zones.filter((z) => z.outcome !== 'CONTENDED').length,
          tone: 'neutral',
          testId: 'metric-zones',
        },
        { label: 'Schedules', value: detail.schedules, tone: 'info' },
        { label: 'Batches', value: detail.batches, tone: 'info' },
        { label: 'Dispatched', value: detail.ticketsDispatched, tone: 'success' },
        { label: 'Recommended', value: detail.recommended, tone: 'neutral' },
        { label: 'Unassignable', value: detail.unassignable, tone: detail.unassignable > 0 ? 'warning' : 'neutral' },
      ]
    : [];

  return (
    <section>
      <Link to="/dispatch-runs" className="mb-3 inline-flex items-center gap-1 text-sm text-brand-600 hover:underline">
        ← Dispatch Runs
      </Link>

      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-3">
            Dispatch Run
            <span className="font-mono text-lg text-ink-muted">#{runId}</span>
            {detail && <Badge tone={STATUS_TONE[detail.status]}>{detail.status}</Badge>}
          </span>
        }
        subtitle={
          detail
            ? `${triggerActor(detail)} · started ${formatDateTime(detail.startedAt)} · ran ${formatDuration(detail.durationMs)}${
                detail.errorCount > 0 ? ` · ${detail.errorCount} zone error(s)` : ''
              }`
            : 'Loading run…'
        }
      />

      {/* #131 — a run produced by a build below the current lock: the run-65-shaped warning sign
          (a stale process may still have been writing when this ran). Never blocks, just flags it. */}
      {detail?.build?.staleBuild && (
        <div
          role="alert"
          data-testid="stale-build-badge"
          className="mb-4 flex items-center gap-2 rounded-md border border-warning/30 bg-warning-bg px-3 py-2 text-sm text-warning"
        >
          <span className="font-semibold">Stale build:</span>
          <span>
            ran under build v{detail.build.buildVersion} ({detail.build.buildFingerprint}), current v
            {detail.build.currentVersion} ({detail.build.currentFingerprint}).
          </span>
        </div>
      )}

      {error && <ErrorState message={error} onRetry={load} />}

      {detail && (
        <>
          <MetricStrip cols={6} metrics={metrics} />
          <ConfigInEffectPanel snapshot={detail.configSnapshot} />

          <h3 className="mb-3 text-[0.82rem] font-semibold uppercase tracking-wider text-ink-caps">Zones</h3>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {detail.zones.map((z) => (
              <ZoneCard key={z.zoneId} zone={z} onOpen={() => navigate(`/dispatch-runs/${runId}/zones/${z.zoneId}`)} />
            ))}
            {detail.zones.length === 0 && <p className="text-sm text-ink-muted">No zones in this run.</p>}
          </div>
        </>
      )}
    </section>
  );
}

function ZoneCard({ zone, onOpen }: { zone: DispatchRunZoneCard; onOpen: () => void }) {
  const reasons = zone.unassignableReasons;
  const contended = zone.outcome === 'CONTENDED';
  return (
    <Card
      className="cursor-pointer p-4 focus-ring"
      role="button"
      tabIndex={0}
      data-testid={`dispatch-zone-card-${zone.zoneId}`}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
    >
      <div className="mb-3 flex items-center justify-between gap-2">
        <span className="font-semibold text-ink-strong">{zone.zoneName ?? `Zone ${zone.zoneId}`}</span>
        {contended ? <Badge tone="warning">CONTENDED</Badge> : zone.mode && <Badge tone={MODE_TONE[zone.mode]}>{zone.mode}</Badge>}
      </div>

      {/* #259 — this run asked for the zone and another run already had it. Its counters are all zero,
          and showing them would read as "looked, found nothing" rather than "never looked". */}
      {contended ? (
        <p className="text-sm text-ink-muted" data-testid="zone-contended-note">
          Not dispatched — a dispatch was already running under run {zone.contendedWithRunId ?? 'unknown'}.
        </p>
      ) : zone.error ? (
        <p className="text-sm font-medium text-critical" role="alert">
          Failed: {zone.error}
        </p>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-2 text-center">
            <Stat label="Dispatched" value={zone.ticketsDispatched} />
            <Stat label="Batches" value={zone.batches} />
            <Stat label="Unassignable" value={zone.unassignable} tone={zone.unassignable > 0 ? 'text-warning' : undefined} />
          </div>
          {reasons && zone.unassignable > 0 && (
            <p className="mt-3 text-xs text-ink-muted">
              No coverage: <span className="font-semibold text-ink">{reasons.NO_COVERAGE}</span> · All dropped:{' '}
              <span className="font-semibold text-ink">{reasons.ALL_DROPPED}</span>
            </p>
          )}
          {/* #179 — the numbers above are what this run DID (immutable ledger). If work has since
              been pulled off a day plan (bulk unassign / ZM override), say so, or the card reads as
              "still assigned" when it isn't. Cause is deliberately not attributed — several actions
              stamp the same column. */}
          {(zone.ticketsRemovedSince ?? 0) > 0 && (
            <p className="mt-2 text-xs text-warning" data-testid="zone-removed-since">
              <span className="font-semibold">{zone.ticketsRemovedSince}</span> of these are no longer assigned
              {(zone.ticketsStillAssigned ?? 0) > 0 && <> · {zone.ticketsStillAssigned} still on a day plan</>}
            </p>
          )}
        </>
      )}
    </Card>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div>
      <div className={`text-lg font-bold tabular-nums ${tone ?? 'text-ink-strong'}`}>{value}</div>
      <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-caps">{label}</div>
    </div>
  );
}
