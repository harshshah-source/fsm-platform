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
        { label: 'Zones', value: detail.zones.length, tone: 'neutral' },
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
        {zone.mode && <Badge tone={MODE_TONE[zone.mode]}>{zone.mode}</Badge>}
      </div>

      {zone.error ? (
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
