import { useEffect, useState } from 'react';
import { apiConfirmRecoveryReceipt, apiRecoveryAwaitingReceipt, type RecoveryRow } from '../../api/recovery';
import { DataTable, MetricCard, PageHeader, type Column } from '../../components/data';
import { StatusPill } from '../../components/domain';
import { Button } from '../../components/ui';

/**
 * Recovery "Awaiting Warehouse Receipt" queue (Issue 36 · FE-16 recipe, `/warehouse/recovery-receipt`,
 * reference 20 house style). The Warehouse Manager physically checks the returned device + serial against
 * the Collection-Form data and confirms receipt — which auto-closes the Recovery Ticket
 * (`AUTO_CLOSED_ON_WAREHOUSE_RECEIPT`, no ZM approval).
 *
 * FE-16 applies the canonical queue recipe (`PageHeader` + `MetricCard` + `DataTable` + `StatusPill`);
 * the `Awaiting Warehouse Receipt` aria-label, the `rcv-row-*` / `rcv-receipt-*` test ids, and the
 * single-click Confirm-Receipt action (asserted as a direct POST) are preserved.
 */
export function RecoveryReceiptQueuePage() {
  const [rows, setRows] = useState<RecoveryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    apiRecoveryAwaitingReceipt()
      .then(setRows)
      .catch(() => setError('Failed to load the Recovery receipt queue'))
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  const confirm = async (ticketId: string) => {
    try {
      await apiConfirmRecoveryReceipt(ticketId);
      load();
    } catch {
      setError('Confirm receipt failed');
    }
  };

  const columns: Column<RecoveryRow>[] = [
    { key: 'ticket', header: 'Ticket', render: (r) => <span className="font-mono text-xs text-ink-muted">{r.ticketId.slice(0, 8)}</span> },
    { key: 'device', header: 'Device', render: (r) => <span className="font-mono text-xs text-ink-strong">{r.deviceId}</span> },
    { key: 'serial', header: 'Confirmed serial', render: (r) => <span className="font-mono text-xs text-ink">{r.collectedDeviceSerial ?? '—'}</span> },
    { key: 'notes', header: 'Condition notes', render: (r) => <span className="text-ink-muted">{r.collectionConditionNotes ?? '—'}</span> },
    { key: 'status', header: 'Status', render: (r) => <StatusPill status={r.status} /> },
    {
      key: 'actions',
      header: 'Actions',
      render: (r) => (
        <Button type="button" size="sm" data-testid={`rcv-receipt-${r.ticketId}`} onClick={() => confirm(r.ticketId)}>
          Confirm Receipt
        </Button>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        title="Recovery — Awaiting Warehouse Receipt"
        subtitle="Devices collected in the field, awaiting your physical check + serial confirmation. Confirming receipt auto-closes the Recovery Ticket."
      />

      {error && (
        <p role="alert" className="mb-4 text-sm text-critical">
          {error}
        </p>
      )}

      <div className="mb-5 grid grid-cols-3 gap-3">
        <div>
          <MetricCard label="Awaiting Receipt" value={rows.length} tone="warning" />
        </div>
      </div>

      <DataTable
        ariaLabel="Awaiting Warehouse Receipt"
        rowKey={(r) => r.ticketId}
        rowTestId={(r) => `rcv-row-${r.ticketId}`}
        columns={columns}
        rows={rows}
        loading={loading}
        empty="Nothing awaiting receipt."
      />
    </div>
  );
}
