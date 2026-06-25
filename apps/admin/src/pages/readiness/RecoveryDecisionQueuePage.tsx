import { useEffect, useState } from 'react';
import {
  apiCloseFailedRecovery,
  apiEscalateRecovery,
  apiRecoveryZmQueue,
  apiRescheduleRecovery,
  type RecoveryRow,
} from '../../api/recovery';

/**
 * ZM Recovery decision queue (Issue 37, `/readiness/recovery-decisions`). Manager roles triage
 * unable-to-collect Recovery Tickets: Reschedule (new SE attempt), Close as FAILED_RECOVERY (mandatory
 * reason), or Escalate to Operations Head. Manual closure from the Ticket Detail Drawer is the other
 * authority path (Issue 37). Follows the sibling queue pages' house style (no dedicated v2 image).
 */
export function RecoveryDecisionQueuePage() {
  const [rows, setRows] = useState<RecoveryRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    apiRecoveryZmQueue()
      .then(setRows)
      .catch(() => setError('Failed to load the Recovery decision queue'));
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

  return (
    <div>
      <h2 className="mb-1 text-xl font-semibold">Recovery — ZM Decision Queue</h2>
      <p className="mb-4 text-sm text-slate-500">
        Recovery Tickets the SE could not collect. Reschedule a new attempt, close as FAILED_RECOVERY
        with a reason, or escalate to Operations Head.
      </p>

      {error && (
        <p role="alert" className="mb-4 text-sm text-red-700">
          {error}
        </p>
      )}

      <table aria-label="Recovery decision queue" className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b text-left text-slate-500">
            <th className="py-2 pr-3">Ticket</th>
            <th className="py-2 pr-3">Device</th>
            <th className="py-2 pr-3">Unable reason</th>
            <th className="py-2 pr-3">Actions</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={4} className="py-4 text-slate-400">
                Nothing awaiting a decision.
              </td>
            </tr>
          )}
          {rows.map((row) => (
            <tr key={row.ticketId} data-testid={`rdq-row-${row.ticketId}`} className="border-b align-top hover:bg-slate-50">
              <td className="py-2 pr-3 font-mono text-xs">{row.ticketId.slice(0, 8)}</td>
              <td className="py-2 pr-3 font-mono text-xs">{row.deviceId}</td>
              <td className="py-2 pr-3">
                <span className="rounded bg-rose-100 px-2 py-0.5 text-xs text-rose-800">{row.unableToCollectReason ?? '—'}</span>
              </td>
              <td className="py-2 pr-3">
                <button type="button" data-testid={`rdq-reschedule-${row.ticketId}`} onClick={() => reschedule(row.ticketId)} className="mr-2 rounded border px-2 py-0.5 text-xs hover:bg-slate-100">
                  Reschedule
                </button>
                <button type="button" data-testid={`rdq-close-failed-${row.ticketId}`} onClick={() => closeFailed(row.ticketId)} className="mr-2 rounded border px-2 py-0.5 text-xs text-rose-700 hover:bg-rose-50">
                  Close FAILED_RECOVERY
                </button>
                <button type="button" data-testid={`rdq-escalate-${row.ticketId}`} onClick={() => escalate(row.ticketId)} className="rounded border px-2 py-0.5 text-xs text-amber-800 hover:bg-amber-50">
                  Escalate to OH
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
