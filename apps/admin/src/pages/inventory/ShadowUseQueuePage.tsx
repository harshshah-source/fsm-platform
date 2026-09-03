import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  apiDisputeShadowUse,
  apiReconcileShadowUse,
  apiShadowUse,
  apiShadowUseDisputes,
  type ShadowUseRow,
} from '../../api/shadowUse';
import { useAuth } from '../../auth/AuthProvider';
import { DataTable, MetricCard, PageHeader, type Column } from '../../components/data';
import { AgeChip } from '../../components/domain';
import { Button, Field, Input } from '../../components/ui';
import { formatDateTimeWithYear } from '../../lib/datetime';

/**
 * Shadow Use Queue (Issue 24 · FE-15 recipe, `/warehouse/shadow-use`, reference 19).
 *
 * Two audiences on one page, because they are two halves of one decision. The **Warehouse Manager**
 * works the unreconciled rows — components a 409-loser SE physically consumed — marking each
 * Reconciled (genuine duplicate effort) or Disputed (mandatory reason). A dispute escalates to the
 * **Zonal Manager**, who until #353 had no way to see one: the escalation went into an audit row and
 * the queue was adjudicated by whoever happened to look. The Disputes section is that missing surface,
 * zone-clamped server-side, and it is read-only — the WM owns the actions, and the server 403s a ZM on
 * them either way (#353 AC4).
 *
 * FE-15 applies the canonical queue recipe (`MetricStrip` + `DataTable`). The dispute mandatory-reason
 * leg stays inline (re-skinned onto `Button`/`Field`/`Input`); the `su-metric-UNRECONCILED` / `su-row-*`
 * test ids, the `Shadow Use Queue` aria-label, the action labels, and the `?tab=Components` ticket
 * navigation are all preserved. The Reconciled and Disputed metric cards fill the two slots reference
 * 19 draws beside Unreconciled and the page had left empty.
 */
export function ShadowUseQueuePage() {
  const navigate = useNavigate();
  const { session } = useAuth();
  const isWarehouseManager = session?.role === 'WAREHOUSE_MANAGER';
  const [rows, setRows] = useState<ShadowUseRow[]>([]);
  const [reconciledCount, setReconciledCount] = useState(0);
  const [disputes, setDisputes] = useState<ShadowUseRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [disputingId, setDisputingId] = useState<string | null>(null);
  const [reason, setReason] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    const work: Promise<unknown>[] = [apiShadowUseDisputes().then(setDisputes)];
    if (isWarehouseManager) {
      work.push(
        apiShadowUse().then(setRows),
        apiShadowUse('RECONCILED').then((r) => setReconciledCount(r.length)),
      );
    }
    Promise.all(work)
      .then(() => setError(null))
      .catch(() => setError('Failed to load the Shadow Use Queue'))
      .finally(() => setLoading(false));
  }, [isWarehouseManager]);

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

  const ticketCell = (row: ShadowUseRow) =>
    row.ticketId ? (
      <button
        type="button"
        onClick={() => navigate(`/tickets/${row.ticketId}?tab=Components`)}
        className="font-mono text-xs text-link hover:underline"
      >
        {row.ticketId.slice(0, 8)}
      </button>
    ) : (
      <span className="text-ink-muted">—</span>
    );

  const columns: Column<ShadowUseRow>[] = [
    { key: 'ticket', header: 'Ticket', render: ticketCell },
    { key: 'component', header: 'Component', render: (row) => <span className="text-ink">{row.componentName ?? '—'}</span> },
    { key: 'qty', header: 'Qty', align: 'right', render: (row) => <span className="tabular-nums">{row.qty}</span> },
    { key: 'engineer', header: 'Engineer', render: (row) => <span className="font-mono text-xs text-ink">{row.seId ?? '—'}</span> },
    { key: 'company', header: 'Company', render: (row) => <span className="text-ink">{row.companyName ?? '—'}</span> },
    { key: 'age', header: 'Age', align: 'right', render: (row) => <AgeChip days={row.ageDays} /> },
    {
      key: 'actions',
      header: 'Actions',
      exportable: false,
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

  /**
   * The adjudication columns. "Qty restored" is the same number as the consumption: a dispute puts
   * back exactly what it charged (#353 AC1), so the ZM is looking at a ledger that already balances
   * and is deciding who was right — not chasing a correction that still has to be made.
   */
  const disputeColumns: Column<ShadowUseRow>[] = [
    { key: 'ticket', header: 'Ticket', render: ticketCell },
    { key: 'component', header: 'Component', render: (row) => <span className="text-ink">{row.componentName ?? '—'}</span> },
    { key: 'qty', header: 'Qty restored', align: 'right', render: (row) => <span className="tabular-nums">{row.qty}</span> },
    { key: 'engineer', header: 'Engineer', render: (row) => <span className="font-mono text-xs text-ink">{row.seId ?? '—'}</span> },
    { key: 'company', header: 'Company', render: (row) => <span className="text-ink">{row.companyName ?? '—'}</span> },
    { key: 'zone', header: 'Zone', render: (row) => <span className="text-ink">{row.zoneName ?? '—'}</span> },
    { key: 'reason', header: 'Dispute reason', render: (row) => <span className="text-ink">{row.reason ?? '—'}</span> },
    {
      key: 'escalated',
      header: 'Escalated',
      render: (row) => (
        <span className="whitespace-nowrap text-xs text-ink-muted">{formatDateTimeWithYear(row.escalatedAt)}</span>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        title="Shadow Use Queue"
        subtitle={
          isWarehouseManager
            ? 'Components a second SE consumed on a Ticket that another SE had already closed (business 409). Reconcile genuine duplicate effort, or dispute a mismatch — a dispute restores the engineer’s van stock, escalates to the Zonal Manager and flags the Ticket.'
            : 'Shadow-use consumption the Warehouse Manager has disputed and escalated to you. Each dispute has already restored the engineer’s van stock; what is left is the adjudication.'
        }
      />

      {error && (
        <p role="alert" className="mb-4 text-sm text-critical">
          {error}
        </p>
      )}

      <div className="mb-5 grid grid-cols-3 gap-3">
        {isWarehouseManager && (
          <>
            <div data-testid="su-metric-UNRECONCILED">
              <MetricCard label="Unreconciled" value={rows.length} tone="warning" />
            </div>
            <div data-testid="su-metric-RECONCILED">
              <MetricCard label="Reconciled" value={reconciledCount} />
            </div>
          </>
        )}
        <div data-testid="su-metric-DISPUTED">
          <MetricCard label="Disputed" value={disputes.length} tone="critical" />
        </div>
      </div>

      {isWarehouseManager && (
        <DataTable
          ariaLabel="Shadow Use Queue"
          rowKey={(r) => r.id}
          rowTestId={(r) => `su-row-${r.id}`}
          columns={columns}
          rows={rows}
          loading={loading}
          empty="No unreconciled shadow-use rows."
        />
      )}

      <section className={isWarehouseManager ? 'mt-8' : undefined}>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-ink-muted">Disputes</h2>
        <DataTable
          ariaLabel="Shadow Use Disputes"
          rowKey={(r) => r.id}
          rowTestId={(r) => `sud-row-${r.id}`}
          columns={disputeColumns}
          rows={disputes}
          loading={loading}
          empty="No disputes escalated to the Zonal Manager."
        />
      </section>
    </div>
  );
}
