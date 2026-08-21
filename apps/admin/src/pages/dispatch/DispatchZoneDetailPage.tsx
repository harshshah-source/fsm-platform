import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { apiDispatchZoneDetail, type DispatchRunZoneCard, type DispatchZoneDetail } from '../../api/dispatch-runs';
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
/**
 * #252 (landed with #259) — the zone's funnel, in one line, with nothing left out.
 *
 * It used to read "N considered · N recommended · N dispatched · N unassignable", which invites the
 * arithmetic `considered = recommended + unassignable` and is wrong: three further populations were
 * withheld or dropped before any decision, and on the dev mirror they were the *majority* of the pool.
 * Each is named separately because each sends a different team — Ops for a coverage gap, nobody for
 * policy working as intended, data engineering for a missing SLA bucket, the warehouse for a part on
 * order. A counter the run never measured says so; "0" would be a claim nobody made.
 */
function ZoneFunnel({ zone }: { zone: DispatchRunZoneCard }) {
  const measured = (n: number | null | undefined) => (n == null ? 'not recorded' : String(n));
  const parts = [
    `${zone.ticketsConsidered} considered`,
    `${zone.recommended} recommended`,
    `${zone.ticketsDispatched} dispatched`,
    `${zone.unassignable} unassignable`,
    // `label: value` for the three withheld/dropped populations, not the `value label` of the four
    // above: one of them can legitimately read "not recorded", and "not recorded no SLA bucket" is not
    // a sentence.
    `held below threshold: ${zone.withheldBelowThreshold ?? 0}`,
    `no SLA bucket: ${measured(zone.bucketlessDropped)}`,
  ];
  // #177's column is the newest of the three; a run that never reported one says nothing rather than
  // adding a fourth "not recorded" to an already long line.
  if (zone.componentBlockedWithheld != null) parts.push(`waiting on a part: ${zone.componentBlockedWithheld}`);
  if (zone.weightSetRef) parts.push(`weight set ${zone.weightSetRef}`);
  return <span data-testid="zone-funnel">{parts.join(' · ')}</span>;
}

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
        subtitle={zone ? <ZoneFunnel zone={zone} /> : 'Loading zone…'}
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
