import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  apiDispatchZoneDetail,
  type DispatchBatchRow,
  type DispatchUnassignableRow,
  type DispatchZoneDetail,
} from '../../api/dispatch-runs';
import { DataTable, EmptyState, ErrorState, PageHeader, type Column } from '../../components/data';
import { Badge } from '../../components/ui';
import { MODE_TONE, POOL_EMPTY_LABEL } from './format';

/**
 * Dispatch run — zone detail (Issue 123). The zone's dispatched batches (SE, plant, capacity used
 * against the frozen snapshot) and its unassignable tickets with the reason the candidate pool ended
 * up empty. Batch rows drill into the assignment table + per-ticket decision trace. Read-only; a ZM
 * reaching another zone here is a 403 (global ZoneScopeGuard) — but the UI never links there.
 */
export function DispatchZoneDetailPage() {
  const { runId = '', zoneId = '' } = useParams();
  const navigate = useNavigate();
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

  const batchColumns: Column<DispatchBatchRow>[] = [
    { key: 'se', header: 'Engineer', render: (b) => b.seName ?? <span className="font-mono text-xs">{b.seId.slice(0, 8)}</span> },
    {
      key: 'plant',
      header: 'Plant',
      render: (b) => (
        <div>
          <div>{b.plantName}</div>
          {b.companyName && <div className="text-xs text-ink-muted">{b.companyName}</div>}
        </div>
      ),
    },
    { key: 'stop', header: 'Stop', align: 'right', render: (b) => b.stopSequence },
    { key: 'status', header: 'Status', render: (b) => <Badge tone="neutral">{b.status}</Badge> },
    { key: 'tickets', header: 'Tickets', align: 'right', render: (b) => b.ticketCount },
    {
      key: 'capacity',
      header: 'SE load / cap',
      align: 'right',
      render: (b) => (
        <span className="tabular-nums">
          {b.capacityUsed.used} / {b.capacityUsed.cap ?? '—'}
        </span>
      ),
    },
  ];

  const unassignableColumns: Column<DispatchUnassignableRow>[] = [
    { key: 'device', header: 'Device', render: (u) => u.deviceId ?? <span className="font-mono text-xs">{u.ticketId.slice(0, 8)}</span> },
    {
      key: 'plant',
      header: 'Plant',
      render: (u) => (
        <div>
          <div>{u.plantName ?? '—'}</div>
          {u.companyName && <div className="text-xs text-ink-muted">{u.companyName}</div>}
        </div>
      ),
    },
    {
      key: 'reason',
      header: 'Why unassignable',
      render: (u) => (
        <Badge tone={u.poolEmptyReason === 'NO_COVERAGE' ? 'critical' : 'warning'}>
          {u.poolEmptyReason ? POOL_EMPTY_LABEL[u.poolEmptyReason] : 'Unknown'}
        </Badge>
      ),
    },
    {
      key: 'drops',
      header: 'Dropped candidates',
      render: (u) => {
        const entries = Object.entries(u.dropCounts ?? {});
        return entries.length === 0 ? (
          <span className="text-ink-muted">—</span>
        ) : (
          <span className="text-xs text-ink-muted">{entries.map(([r, n]) => `${r} ×${n}`).join(' · ')}</span>
        );
      },
    },
  ];

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
          <h3 className="mb-3 text-[0.82rem] font-semibold uppercase tracking-wider text-ink-caps">Batches</h3>
          <DataTable
            columns={batchColumns}
            rows={detail.batches}
            rowKey={(b) => b.batchId}
            rowTestId={(b) => `dispatch-batch-row-${b.batchId}`}
            ariaLabel="Zone batches"
            onRowClick={(b) => navigate(`/dispatch-runs/${runId}/batches/${b.batchId}`)}
            empty={<EmptyState message="No batches dispatched in this zone for this run." />}
          />

          {detail.unassignable.length > 0 && (
            <>
              <h3 className="mb-3 mt-6 text-[0.82rem] font-semibold uppercase tracking-wider text-ink-caps">
                Unassignable ({detail.unassignable.length})
              </h3>
              <DataTable
                columns={unassignableColumns}
                rows={detail.unassignable}
                rowKey={(u) => u.ticketId}
                rowTestId={(u) => `dispatch-unassignable-row-${u.ticketId}`}
                ariaLabel="Unassignable tickets"
              />
            </>
          )}
        </>
      )}
    </section>
  );
}
