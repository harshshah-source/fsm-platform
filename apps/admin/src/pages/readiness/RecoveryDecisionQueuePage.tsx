import { useEffect, useState } from 'react';
import {
  apiCloseFailedRecovery,
  apiEscalateRecovery,
  apiRecoveryZmQueue,
  apiRescheduleRecovery,
  type RecoveryRow,
} from '../../api/recovery';
import { DataTable, MetricCard, PageHeader, type Column } from '../../components/data';
import { Badge, Button } from '../../components/ui';

/**
 * ZM Recovery decision queue (Issue 37 · FE-16 recipe, `/readiness/recovery-decisions`, reference 20
 * house style). Manager roles triage unable-to-collect Recovery Tickets: Reschedule (new SE attempt),
 * Close as FAILED_RECOVERY (mandatory reason), or Escalate to Operations Head.
 *
 * FE-16 applies the canonical queue recipe (`PageHeader` + `MetricCard` + `DataTable`). The
 * `Recovery decision queue` aria-label, the `rdq-row-*` / `rdq-reschedule-*` / `rdq-close-failed-*` /
 * `rdq-escalate-*` test ids, and the action behaviour (asserted as direct/prompt→POST) are preserved;
 * the `window.prompt` reason/SE legs are scheduled for a `Modal` upgrade in follow-up #72.
 */
export function RecoveryDecisionQueuePage() {
  const [rows, setRows] = useState<RecoveryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    apiRecoveryZmQueue()
      .then(setRows)
      .catch(() => setError('Failed to load the Recovery decision queue'))
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  const run = async (fn: () => Promise<unknown>, failMsg: string) => {
    try {
      await fn();
      load();
    } catch {
      setError(failMsg);
    }
  };

  const reschedule = (ticketId: string) => {
    const seId = window.prompt('Reassign to SE (user id):');
    if (!seId?.trim()) return;
    void run(() => apiRescheduleRecovery(ticketId, seId.trim()), 'Reschedule failed');
  };

  const closeFailed = (ticketId: string) => {
    const reason = window.prompt('Close as FAILED_RECOVERY — reason (mandatory):');
    if (!reason?.trim()) return;
    void run(() => apiCloseFailedRecovery(ticketId, reason.trim()), 'Close failed');
  };

  const escalate = (ticketId: string) => void run(() => apiEscalateRecovery(ticketId), 'Escalate failed');

  const columns: Column<RecoveryRow>[] = [
    { key: 'ticket', header: 'Ticket', render: (r) => <span className="font-mono text-xs text-ink-muted">{r.ticketId.slice(0, 8)}</span> },
    { key: 'device', header: 'Device', render: (r) => <span className="font-mono text-xs text-ink-strong">{r.deviceId}</span> },
    {
      key: 'reason',
      header: 'Unable reason',
      render: (r) => <Badge tone="critical">{r.unableToCollectReason ?? '—'}</Badge>,
    },
    {
      key: 'actions',
      header: 'Actions',
      render: (r) => (
        <div className="flex gap-2">
          <Button type="button" size="sm" variant="secondary" data-testid={`rdq-reschedule-${r.ticketId}`} onClick={() => reschedule(r.ticketId)}>
            Reschedule
          </Button>
          <Button type="button" size="sm" variant="danger" data-testid={`rdq-close-failed-${r.ticketId}`} onClick={() => closeFailed(r.ticketId)}>
            Close FAILED_RECOVERY
          </Button>
          <Button type="button" size="sm" variant="ghost" data-testid={`rdq-escalate-${r.ticketId}`} onClick={() => escalate(r.ticketId)}>
            Escalate to OH
          </Button>
        </div>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        title="Recovery — ZM Decision Queue"
        subtitle="Recovery Tickets the SE could not collect. Reschedule a new attempt, close as FAILED_RECOVERY with a reason, or escalate to Operations Head."
      />

      {error && (
        <p role="alert" className="mb-4 text-sm text-critical">
          {error}
        </p>
      )}

      <div className="mb-5 grid grid-cols-3 gap-3">
        <div>
          <MetricCard label="Awaiting Decision" value={rows.length} tone="critical" />
        </div>
      </div>

      <DataTable
        ariaLabel="Recovery decision queue"
        rowKey={(r) => r.ticketId}
        rowTestId={(r) => `rdq-row-${r.ticketId}`}
        columns={columns}
        rows={rows}
        loading={loading}
        empty="Nothing awaiting a decision."
      />
    </div>
  );
}
