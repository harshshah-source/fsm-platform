import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  apiEscalateVerification,
  apiMarkAutoRecovery,
  apiVerificationReview,
  type VerificationReviewRow,
} from '../../api/verification';

/**
 * GPS Verification Review (Issue 19, `/verification`). The ZM-facing follow-up surface over Issue 18's
 * verification_runs: zone-scoped (server-side), filterable by outcome / company / date, defaulting to
 * all non-CLOSED newest-first. Each row renders by type — PARTIAL_RECOVERY (ping count + 24 h
 * countdown), FAILED_VERIFICATION split into no-pings vs a fraud-flag distance chip, CLOSED (green).
 * Fraud rows get an Escalate action (mandatory reason); recoverable rows get Mark CLOSED_AUTO_RECOVERY.
 * Clicking a row opens the Ticket Detail Drawer at the Verification tab.
 */
const OUTCOME_FILTERS = [
  { value: '', label: 'All non-CLOSED' },
  { value: 'PARTIAL_RECOVERY', label: 'Partial recovery' },
  { value: 'FAILED_VERIFICATION', label: 'Failed verification' },
  { value: 'CLOSED', label: 'Closed' },
  { value: 'CLOSED_AUTO_RECOVERY', label: 'Auto-recovery' },
];

function hoursLeft(deadline: string | null): string | null {
  if (!deadline) return null;
  const ms = new Date(deadline).getTime() - Date.now();
  if (ms <= 0) return 'overdue';
  return `${Math.floor(ms / 3_600_000)}h left`;
}

export function VerificationReviewPage() {
  const navigate = useNavigate();
  const [rows, setRows] = useState<VerificationReviewRow[]>([]);
  const [outcome, setOutcome] = useState('');
  const [companyId, setCompanyId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [escalateFor, setEscalateFor] = useState<VerificationReviewRow | null>(null);
  const [reason, setReason] = useState('');

  const filters = useMemo(
    () => ({ outcome: outcome || undefined, companyId: companyId || undefined }),
    [outcome, companyId],
  );

  const refetch = useCallback(() => {
    apiVerificationReview(filters)
      .then(setRows)
      .catch(() => setError('Failed to load verification review'));
  }, [filters]);

  useEffect(() => {
    let alive = true;
    apiVerificationReview(filters)
      .then((r) => alive && setRows(r))
      .catch(() => alive && setError('Failed to load verification review'));
    return () => {
      alive = false;
    };
  }, [filters]);

  async function submitEscalation() {
    if (!escalateFor || !reason.trim()) return;
    try {
      await apiEscalateVerification(escalateFor.ticketId, reason.trim());
      setEscalateFor(null);
      setReason('');
      refetch();
    } catch {
      setError('Escalation failed');
    }
  }

  async function markAutoRecovery(ticketId: string) {
    try {
      await apiMarkAutoRecovery(ticketId);
      refetch();
    } catch {
      setError('Mark auto-recovery failed');
    }
  }

  return (
    <div>
      <h2 className="mb-1 text-xl font-semibold">GPS Verification Review</h2>
      <p className="mb-4 text-sm text-slate-500">
        Outcomes for submitted Troubleshoot tickets in your zone. Default shows everything still needing
        attention (non-closed).
      </p>

      {error && (
        <p role="alert" className="mb-4 text-sm text-red-700">
          {error}
        </p>
      )}

      <div className="mb-4 flex flex-wrap items-center gap-3 text-sm">
        <label htmlFor="vr-outcome" className="text-slate-600">
          Outcome
        </label>
        <select
          id="vr-outcome"
          aria-label="Outcome filter"
          value={outcome}
          onChange={(e) => setOutcome(e.target.value)}
          className="rounded border px-2 py-1"
        >
          {OUTCOME_FILTERS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <input
          aria-label="Company filter"
          placeholder="Company id"
          value={companyId}
          onChange={(e) => setCompanyId(e.target.value)}
          className="w-28 rounded border px-2 py-1"
        />
      </div>

      <table aria-label="Verification review" className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b text-left text-slate-500">
            <th className="py-2 pr-3">Company</th>
            <th className="py-2 pr-3">Zone</th>
            <th className="py-2 pr-3">Device</th>
            <th className="py-2 pr-3">Outcome</th>
            <th className="py-2 pr-3">Actions</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={5} className="py-4 text-slate-400">
                No verification rows.
              </td>
            </tr>
          )}
          {rows.map((row) => (
            <tr
              key={row.ticketId}
              data-testid={`vr-row-${row.ticketId}`}
              onClick={() => navigate(`/tickets/${row.ticketId}?tab=Verification`)}
              className="cursor-pointer border-b hover:bg-slate-50"
            >
              <td className="py-2 pr-3">{row.companyName}</td>
              <td className="py-2 pr-3 text-slate-600">{row.zoneName}</td>
              <td className="py-2 pr-3 font-mono text-xs">{row.deviceId}</td>
              <td className="py-2 pr-3">
                <OutcomeCell row={row} />
              </td>
              <td className="py-2 pr-3" onClick={(e) => e.stopPropagation()}>
                {row.rowType === 'FAILED_FRAUD' && (
                  <button
                    type="button"
                    onClick={() => {
                      setEscalateFor(row);
                      setReason('');
                    }}
                    className="rounded bg-orange-600 px-2 py-0.5 text-xs text-white hover:bg-orange-700"
                  >
                    Escalate
                  </button>
                )}
                {(row.rowType === 'PARTIAL_RECOVERY' || row.rowType === 'FAILED_NO_PINGS') && (
                  <button
                    type="button"
                    onClick={() => void markAutoRecovery(row.ticketId)}
                    className="rounded border px-2 py-0.5 text-xs text-slate-700 hover:bg-slate-100"
                  >
                    Mark auto-recovery
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {escalateFor && (
        <div role="dialog" aria-label="Escalate verification" className="mt-4 rounded border bg-orange-50 p-3 text-sm">
          <p className="mb-2 font-medium text-orange-900">
            Escalate fraud-flagged ticket {escalateFor.deviceId} — reason required
          </p>
          <textarea
            aria-label="Escalation reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="mb-2 w-full rounded border px-2 py-1"
            rows={2}
          />
          <div className="flex gap-2">
            <button
              type="button"
              disabled={!reason.trim()}
              onClick={() => void submitEscalation()}
              className="rounded bg-orange-600 px-3 py-1 text-xs text-white disabled:opacity-40"
            >
              Escalate
            </button>
            <button type="button" onClick={() => setEscalateFor(null)} className="rounded border px-3 py-1 text-xs">
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function OutcomeCell({ row }: { row: VerificationReviewRow }) {
  switch (row.rowType) {
    case 'PARTIAL_RECOVERY':
      return (
        <span className="rounded bg-amber-100 px-2 py-0.5 text-xs text-amber-800">
          Partial recovery · {row.pingsReceivedCount}/3 pings · {hoursLeft(row.partialDeadline)}
        </span>
      );
    case 'FAILED_FRAUD':
      return (
        <span className="rounded bg-orange-100 px-2 py-0.5 text-xs text-orange-800">
          Failed — fraud · {row.firstPingDistanceMeters != null ? `${Math.round(row.firstPingDistanceMeters)} m off` : 'location mismatch'}
        </span>
      );
    case 'FAILED_NO_PINGS':
      return <span className="rounded bg-red-100 px-2 py-0.5 text-xs text-red-800">Failed — no pings</span>;
    case 'CLOSED':
      return <span className="rounded bg-emerald-100 px-2 py-0.5 text-xs text-emerald-800">Closed</span>;
    case 'CLOSED_AUTO_RECOVERY':
      return <span className="rounded bg-emerald-100 px-2 py-0.5 text-xs text-emerald-800">Auto-recovery</span>;
    default:
      return <span className="rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-600">Pending</span>;
  }
}
