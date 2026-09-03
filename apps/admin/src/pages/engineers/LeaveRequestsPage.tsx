import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../../auth/AuthProvider';
import { apiEngineers, type EngineerListRow } from '../../api/engineers';
import {
  apiApproveLeave,
  apiLeaveRequests,
  apiRejectLeave,
  apiRevokeLeave,
  apiSubmitLeave,
  LeaveApiError,
  type LeaveRequestRow,
} from '../../api/leaveRequests';
import { istWindowEndDate, istWindowStartDate } from '../../lib/datetime';

const STATUS_TONE: Record<string, string> = {
  PENDING: 'bg-amber-100 text-amber-800',
  APPROVED: 'bg-emerald-100 text-emerald-800',
  REJECTED: 'bg-rose-100 text-rose-800',
  // #363 — revoked is neither approved leave nor a rejection the SE never received: the day went back
  // on the board. Read as a neutral, closed state.
  REVOKED: 'bg-slate-200 text-slate-700',
};

/** The failure copy a manager can act on. `OVERLAP` (#363) is the one this page can actually provoke. */
function messageFor(err: unknown): string {
  const code = err instanceof LeaveApiError ? err.code : 'UNKNOWN';
  const conflictId = err instanceof LeaveApiError ? err.conflictId : undefined;
  switch (code) {
    case 'OVERLAP':
      return `That engineer already has leave for those dates${conflictId ? ` (request #${conflictId})` : ''}. Open it instead of filing a second one.`;
    case 'WINDOW_ORDER':
    case 'INVALID_WINDOW':
      return 'The end date must be on or after the start date.';
    case 'LEAVE_NOT_PENDING':
      return 'That request has already been decided — reload the list.';
    case 'LEAVE_NOT_APPROVED':
      return 'Only approved leave can be revoked — reload the list.';
    case 'LEAVE_FORBIDDEN':
      return 'That engineer is outside your zone.';
    case 'SE_REQUIRED':
      return 'Choose an engineer.';
    default:
      return `That did not go through (${code}).`;
  }
}

/** Which row has its reason box open, and for which decision. */
type PendingDecision = { id: string; kind: 'reject' | 'revoke' };

/**
 * ZM Leave Requests approvals (Issue 26, `/leave-requests`). The own-zone leave requests with the SE,
 * type, window and reason; PENDING rows carry Approve / Reject (mandatory reason) for ZM / CSM —
 * approving writes the SE's availability window (so the Recommender excludes them). Operations Head
 * reads only. Notifications (SE-on-decision) are the Issue 03 seam.
 *
 * #363 adds the two halves of leave integrity a manager can see. **Revoke** (mandatory reason) undoes
 * an approval: the SE goes back on the board for that window on the next Recommender run, where before
 * an approval was terminal and the engineer's day was simply gone. And **filing on behalf of an SE**
 * — the phone call a ZM takes when an engineer cannot use the app — which is where the server's 409
 * `OVERLAP` lands: the same absence filed twice used to be accepted and could be approved twice.
 */
export function LeaveRequestsPage() {
  const { session } = useAuth();
  const canDecide = session?.role === 'ZONAL_MANAGER' || session?.role === 'CENTRAL_SERVICE_MANAGER';

  const [rows, setRows] = useState<LeaveRequestRow[]>([]);
  const [engineers, setEngineers] = useState<EngineerListRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [decision, setDecision] = useState<PendingDecision | null>(null);
  const [reason, setReason] = useState('');
  const [form, setForm] = useState({ seId: '', type: 'ON_LEAVE' as 'ON_LEAVE' | 'WEEKLY_OFF', from: '', to: '', reason: '' });

  const load = useCallback(() => {
    apiLeaveRequests()
      .then(setRows)
      .catch(() => setError('Failed to load leave requests'));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!canDecide) return;
    apiEngineers()
      .then(setEngineers)
      .catch(() => undefined); // the list still works without the file-on-behalf picker
  }, [canDecide]);

  /** Every write takes the same path: clear the banner, act, reload, or show why not. */
  const run = async (work: () => Promise<void>, after?: () => void) => {
    setError(null);
    try {
      await work();
      after?.();
      load();
    } catch (err) {
      setError(messageFor(err));
    }
  };

  const closeDecision = () => {
    setDecision(null);
    setReason('');
  };

  const approve = (id: string) => run(() => apiApproveLeave(id));

  const confirmDecision = () => {
    if (!decision || !reason.trim()) return;
    const { id, kind } = decision;
    const trimmed = reason.trim();
    return run(() => (kind === 'reject' ? apiRejectLeave(id, trimmed) : apiRevokeLeave(id, trimmed)), closeDecision);
  };

  const fileLeave = () => {
    if (!form.seId || !form.from || !form.to) {
      setError('Choose an engineer and both dates.');
      return;
    }
    return run(
      () =>
        apiSubmitLeave({
          seId: form.seId,
          type: form.type,
          windowStart: form.from,
          windowEnd: form.to,
          reason: form.reason.trim() || null,
        }),
      () => setForm({ seId: '', type: 'ON_LEAVE', from: '', to: '', reason: '' }),
    );
  };

  return (
    <div>
      <h2 className="mb-1 text-xl font-semibold">Leave Requests</h2>
      <p className="mb-4 text-sm text-slate-500">
        SE-filed leave (ON_LEAVE / WEEKLY_OFF). Approving writes the SE's availability window so the
        Recommender stops considering them for it; rejecting requires a reason and the SE can resubmit.
        Revoking an approval hands the day back — the SE is bookable again on the next run.
      </p>

      {error && (
        <p role="alert" className="mb-4 text-sm text-red-700">
          {error}
        </p>
      )}

      {canDecide && (
        <div className="mb-4 rounded border border-line p-3">
          <div className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-500">File leave for an engineer</div>
          <div className="flex flex-wrap items-end gap-3 text-xs">
            <div className="flex flex-col gap-1">
              <label htmlFor="lr-se" className="text-slate-500">
                Engineer
              </label>
              <select
                id="lr-se"
                value={form.seId}
                onChange={(e) => setForm({ ...form, seId: e.target.value })}
                className="rounded border px-2 py-1"
              >
                <option value="">Select…</option>
                {engineers.map((e) => (
                  <option key={e.seId} value={e.seId}>
                    {e.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="lr-type" className="text-slate-500">
                Type
              </label>
              <select
                id="lr-type"
                value={form.type}
                onChange={(e) => setForm({ ...form, type: e.target.value as 'ON_LEAVE' | 'WEEKLY_OFF' })}
                className="rounded border px-2 py-1"
              >
                <option value="ON_LEAVE">ON_LEAVE</option>
                <option value="WEEKLY_OFF">WEEKLY_OFF</option>
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="lr-from" className="text-slate-500">
                From
              </label>
              <input
                id="lr-from"
                type="date"
                value={form.from}
                onChange={(e) => setForm({ ...form, from: e.target.value })}
                className="rounded border px-2 py-1"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="lr-to" className="text-slate-500">
                To
              </label>
              <input
                id="lr-to"
                type="date"
                value={form.to}
                onChange={(e) => setForm({ ...form, to: e.target.value })}
                className="rounded border px-2 py-1"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="lr-reason" className="text-slate-500">
                Reason (optional)
              </label>
              <input
                id="lr-reason"
                value={form.reason}
                onChange={(e) => setForm({ ...form, reason: e.target.value })}
                className="rounded border px-2 py-1"
              />
            </div>
            <button type="button" onClick={fileLeave} className="rounded border px-2 py-1 text-xs font-medium text-slate-700">
              File leave
            </button>
          </div>
          <p className="mt-2 text-xs text-slate-400">
            Dates are IST calendar days, end inclusive. An engineer cannot hold the same day twice.
          </p>
        </div>
      )}

      <table aria-label="Leave Requests" className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b text-left text-slate-500">
            <th className="py-2 pr-3">Engineer</th>
            <th className="py-2 pr-3">Type</th>
            <th className="py-2 pr-3">Window</th>
            <th className="py-2 pr-3">Reason</th>
            <th className="py-2 pr-3">Status</th>
            {canDecide && <th className="py-2 pr-3">Actions</th>}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={canDecide ? 6 : 5} className="py-4 text-slate-400">
                No leave requests in scope.
              </td>
            </tr>
          )}
          {rows.map((r) => (
            <tr key={r.id} data-testid={`lr-row-${r.id}`} className="border-b border-line align-top hover:bg-row-hover">
              <td className="py-2 pr-3 font-medium">{r.seName}</td>
              <td className="py-2 pr-3">{r.type}</td>
              <td className="py-2 pr-3 text-slate-600">
                {istWindowStartDate(r.windowStart)} – {istWindowEndDate(r.windowEnd)}
              </td>
              <td className="py-2 pr-3 text-slate-600">{r.reason ?? '—'}</td>
              <td className="py-2 pr-3">
                <span className={`rounded px-2 py-0.5 text-xs font-medium ${STATUS_TONE[r.status] ?? ''}`}>{r.status}</span>
                {(r.status === 'REJECTED' || r.status === 'REVOKED') && r.decisionReason && (
                  <div className="mt-1 text-xs text-slate-400">{r.decisionReason}</div>
                )}
              </td>
              {canDecide && (
                <td className="py-2 pr-3">
                  {r.status === 'PENDING' && decision?.id !== r.id && (
                    <div className="flex gap-2">
                      <button type="button" onClick={() => approve(r.id)} className="rounded border px-2 py-0.5 text-xs text-emerald-700">
                        Approve
                      </button>
                      <button
                        type="button"
                        onClick={() => setDecision({ id: r.id, kind: 'reject' })}
                        className="rounded border px-2 py-0.5 text-xs text-rose-700"
                      >
                        Reject
                      </button>
                    </div>
                  )}
                  {/* #363 — only an approval that still holds a window can be handed back. */}
                  {r.status === 'APPROVED' && decision?.id !== r.id && (
                    <button
                      type="button"
                      onClick={() => setDecision({ id: r.id, kind: 'revoke' })}
                      className="rounded border px-2 py-0.5 text-xs text-rose-700"
                    >
                      Revoke
                    </button>
                  )}
                  {decision?.id === r.id && (
                    <div className="flex flex-col gap-1">
                      <label className="text-xs text-slate-500" htmlFor={`${decision.kind}-${r.id}`}>
                        {decision.kind === 'reject' ? 'Reject reason' : 'Revoke reason'}
                      </label>
                      <input
                        id={`${decision.kind}-${r.id}`}
                        value={reason}
                        onChange={(e) => setReason(e.target.value)}
                        className="rounded border px-2 py-0.5 text-xs"
                      />
                      <div className="flex gap-2">
                        <button type="button" onClick={confirmDecision} className="rounded border px-2 py-0.5 text-xs text-rose-700">
                          {decision.kind === 'reject' ? 'Confirm reject' : 'Confirm revoke'}
                        </button>
                        <button type="button" onClick={closeDecision} className="rounded border px-2 py-0.5 text-xs">
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
