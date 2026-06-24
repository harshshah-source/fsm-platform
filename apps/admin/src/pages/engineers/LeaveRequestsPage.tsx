import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../../auth/AuthProvider';
import { apiApproveLeave, apiLeaveRequests, apiRejectLeave, type LeaveRequestRow } from '../../api/leaveRequests';

const STATUS_TONE: Record<string, string> = {
  PENDING: 'bg-amber-100 text-amber-800',
  APPROVED: 'bg-emerald-100 text-emerald-800',
  REJECTED: 'bg-rose-100 text-rose-800',
};

/**
 * ZM Leave Requests approvals (Issue 26, `/leave-requests`). The own-zone leave requests with the SE,
 * type, window and reason; PENDING rows carry Approve / Reject (mandatory reason) for ZM / CSM —
 * approving writes the SE's availability window (so the Recommender excludes them). Operations Head
 * reads only. Notifications (SE-on-decision) are the Issue 03 seam.
 */
export function LeaveRequestsPage() {
  const { session } = useAuth();
  const canDecide = session?.role === 'ZONAL_MANAGER' || session?.role === 'CENTRAL_SERVICE_MANAGER';

  const [rows, setRows] = useState<LeaveRequestRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [reason, setReason] = useState('');

  const load = useCallback(() => {
    apiLeaveRequests()
      .then(setRows)
      .catch(() => setError('Failed to load leave requests'));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const approve = async (id: string) => {
    await apiApproveLeave(id);
    load();
  };
  const confirmReject = async (id: string) => {
    if (!reason.trim()) return;
    await apiRejectLeave(id, reason.trim());
    setRejectingId(null);
    setReason('');
    load();
  };

  const fmt = (iso: string) => iso.slice(0, 10);

  return (
    <div>
      <h2 className="mb-1 text-xl font-semibold">Leave Requests</h2>
      <p className="mb-4 text-sm text-slate-500">
        SE-filed leave (ON_LEAVE / WEEKLY_OFF). Approving writes the SE's availability window so the
        Recommender stops considering them for it; rejecting requires a reason and the SE can resubmit.
      </p>

      {error && (
        <p role="alert" className="mb-4 text-sm text-red-700">
          {error}
        </p>
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
            <tr key={r.id} data-testid={`lr-row-${r.id}`} className="border-b align-top hover:bg-slate-50">
              <td className="py-2 pr-3 font-medium">{r.seName}</td>
              <td className="py-2 pr-3">{r.type}</td>
              <td className="py-2 pr-3 text-slate-600">
                {fmt(r.windowStart)} – {fmt(r.windowEnd)}
              </td>
              <td className="py-2 pr-3 text-slate-600">{r.reason ?? '—'}</td>
              <td className="py-2 pr-3">
                <span className={`rounded px-2 py-0.5 text-xs font-medium ${STATUS_TONE[r.status] ?? ''}`}>{r.status}</span>
                {r.status === 'REJECTED' && r.decisionReason && (
                  <div className="mt-1 text-xs text-slate-400">{r.decisionReason}</div>
                )}
              </td>
              {canDecide && (
                <td className="py-2 pr-3">
                  {r.status === 'PENDING' && rejectingId !== r.id && (
                    <div className="flex gap-2">
                      <button type="button" onClick={() => approve(r.id)} className="rounded border px-2 py-0.5 text-xs text-emerald-700">
                        Approve
                      </button>
                      <button type="button" onClick={() => setRejectingId(r.id)} className="rounded border px-2 py-0.5 text-xs text-rose-700">
                        Reject
                      </button>
                    </div>
                  )}
                  {rejectingId === r.id && (
                    <div className="flex flex-col gap-1">
                      <label className="text-xs text-slate-500" htmlFor={`reject-${r.id}`}>
                        Reject reason
                      </label>
                      <input
                        id={`reject-${r.id}`}
                        value={reason}
                        onChange={(e) => setReason(e.target.value)}
                        className="rounded border px-2 py-0.5 text-xs"
                      />
                      <div className="flex gap-2">
                        <button type="button" onClick={() => confirmReject(r.id)} className="rounded border px-2 py-0.5 text-xs text-rose-700">
                          Confirm reject
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setRejectingId(null);
                            setReason('');
                          }}
                          className="rounded border px-2 py-0.5 text-xs"
                        >
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
