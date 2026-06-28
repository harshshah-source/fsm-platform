import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  apiDisputeShadowUse,
  apiReconcileShadowUse,
  apiShadowUse,
  type ShadowUseRow,
} from '../../api/shadowUse';
import { DataTable, MetricCard, PageHeader, type Column } from '../../components/data';
import { AgeChip } from '../../components/domain';
import { Button, Field, Input } from '../../components/ui';

/**
 * Warehouse Manager Shadow Use Queue (Issue 24 · FE-15 recipe, `/warehouse/shadow-use`, reference 19).
 * Unreconciled SHADOW_USE rows — components a 409-loser SE physically consumed — with per-row Mark
 * Reconciled (genuine duplicate effort) or Mark Disputed (mandatory reason → escalates to the ZM and
 * flags the Ticket). WAREHOUSE_MANAGER only.
 *
 * FE-15 applies the canonical queue recipe (`MetricStrip` + `DataTable`). The dispute mandatory-reason
 * leg stays inline (re-skinned onto `Button`/`Field`/`Input`); the `su-metric-UNRECONCILED` / `su-row-*`
 * test ids, the `Shadow Use Queue` aria-label, the action labels, and the `?tab=Components` ticket
 * navigation are all preserved.
 */
export function ShadowUseQueuePage() {
  const navigate = useNavigate();
  const [rows, setRows] = useState<ShadowUseRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [disputingId, setDisputingId] = useState<string | null>(null);
  const [reason, setReason] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    apiShadowUse()
      .then(setRows)
      .catch(() => setError('Failed to load the Shadow Use Queue'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const reconcile = async (id: string) => {
    await apiReconcileShadowUse(id);
    load();
  };
  const confirmDispute = async (id: string) => {
    if (!reason.trim()) return;
    await apiDisputeShadowUse(id, reason.trim());
    setDisputingId(null);
    setReason('');
    load();
  };

  const columns: Column<ShadowUseRow>[] = [
    {
      key: 'ticket',
      header: 'Ticket',
      render: (row) =>
        row.ticketId ? (
          <button
            type="button"
            onClick={() => navigate(`/tickets/${row.ticketId}?tab=Components`)}
            className="font-mono text-xs text-brand-700 hover:underline"
          >
            {row.ticketId.slice(0, 8)}
          </button>
        ) : (
          <span className="text-ink-muted">—</span>
        ),
    },
    { key: 'component', header: 'Component', render: (row) => <span className="text-ink">{row.componentName ?? '—'}</span> },
    { key: 'qty', header: 'Qty', align: 'right', render: (row) => <span className="tabular-nums">{row.qty}</span> },
    { key: 'engineer', header: 'Engineer', render: (row) => <span className="font-mono text-xs text-ink">{row.seId}</span> },
    { key: 'company', header: 'Company', render: (row) => <span className="text-ink">{row.companyName ?? '—'}</span> },
    { key: 'age', header: 'Age', align: 'right', render: (row) => <AgeChip days={row.ageDays} /> },
    {
      key: 'actions',
      header: 'Actions',
      render: (row) =>
        disputingId !== row.id ? (
          <div className="flex gap-2">
            <Button type="button" size="sm" variant="secondary" onClick={() => reconcile(row.id)}>
              Reconcile
            </Button>
            <Button type="button" size="sm" variant="danger" onClick={() => setDisputingId(row.id)}>
              Dispute
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-1">
            <Field label="Dispute reason" htmlFor={`dispute-${row.id}`}>
              <Input id={`dispute-${row.id}`} value={reason} onChange={(e) => setReason(e.target.value)} className="text-xs" />
            </Field>
            <div className="flex gap-2">
              <Button type="button" size="sm" variant="danger" onClick={() => confirmDispute(row.id)}>
                Confirm dispute
              </Button>
              <Button type="button" size="sm" variant="secondary" onClick={() => { setDisputingId(null); setReason(''); }}>
                Cancel
              </Button>
            </div>
          </div>
        ),
    },
  ];

  return (
    <div>
      <PageHeader
        title="Shadow Use Queue"
        subtitle="Components a second SE consumed on a Ticket that another SE had already closed (business 409). Reconcile genuine duplicate effort, or dispute a mismatch — a dispute escalates to the Zonal Manager and flags the Ticket."
      />

      {error && (
        <p role="alert" className="mb-4 text-sm text-critical">
          {error}
        </p>
      )}

      <div className="mb-5 grid grid-cols-3 gap-3">
        <div data-testid="su-metric-UNRECONCILED">
          <MetricCard label="Unreconciled" value={rows.length} tone="warning" />
        </div>
      </div>

      <DataTable
        ariaLabel="Shadow Use Queue"
        rowKey={(r) => r.id}
        rowTestId={(r) => `su-row-${r.id}`}
        columns={columns}
        rows={rows}
        loading={loading}
        empty="No unreconciled shadow-use rows."
      />
    </div>
  );
}
