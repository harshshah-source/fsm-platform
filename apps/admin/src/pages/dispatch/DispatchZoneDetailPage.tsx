import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { apiDispatchZoneDetail, type DispatchZoneDetail } from '../../api/dispatch-runs';
import { EmptyState, ErrorState, PageHeader } from '../../components/data';
import { Badge } from '../../components/ui';
import { MODE_TONE } from './format';
import { ZoneDispatchTable } from './ZoneDispatchTable';
import { ZoneUnassignableTable } from './ZoneUnassignableTable';

/**
 * Dispatch run — zone detail (Issue 123). The zone opens on its companies and plants (assignments,
 * batches, and per-plant fleet stats) and lists its unassignable tickets with the reason the candidate
 * pool ended up empty. Plant rows drill into their batches → the per-ticket decision trace. Read-only;
 * a ZM reaching another zone here is a 403 (global ZoneScopeGuard) — but the UI never links there.
 */
export function DispatchZoneDetailPage() {
  const { runId = '', zoneId = '' } = useParams();
  const [detail, setDetail] = useState<DispatchZoneDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    setError(null);
    setDetail(null);
    apiDispatchZoneDetail(runId, zoneId)
      .then(setDetail)
      .catch(() => setError('Failed to load this zone'));
  };
  useEffect(load, [runId, zoneId]);

  const zone = detail?.zone;

  return (
    <section>
      <Link to={`/dispatch-runs/${runId}`} className="mb-3 inline-flex items-center gap-1 text-sm text-brand-600 hover:underline">
        ← Run #{runId}
      </Link>

      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-3">
            {zone?.zoneName ?? `Zone ${zoneId}`}
            {zone?.mode && <Badge tone={MODE_TONE[zone.mode]}>{zone.mode}</Badge>}
          </span>
        }
        subtitle={
          zone
            ? `${zone.ticketsConsidered} considered · ${zone.recommended} recommended · ${zone.ticketsDispatched} dispatched · ${zone.unassignable} unassignable${
                zone.weightSetRef ? ` · weight set ${zone.weightSetRef}` : ''
              }`
            : 'Loading zone…'
        }
      />

      {error && <ErrorState message={error} onRetry={load} />}

      {detail && (
        <>
          {detail.batches.length === 0 ? (
            <EmptyState message="No batches dispatched in this zone for this run." />
          ) : (
            <ZoneDispatchTable batches={detail.batches} plantStats={detail.plantStats ?? {}} />
          )}

          {detail.unassignable.length > 0 && <ZoneUnassignableTable rows={detail.unassignable} />}
        </>
      )}
    </section>
  );
}
