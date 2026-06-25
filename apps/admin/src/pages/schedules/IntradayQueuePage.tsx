import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  apiIntradayUpdates,
  type IntradayUpdateRow,
  type IntradayUpdateType,
} from '../../api/intradayUpdates';

/**
 * Intra-day Queue (Issue 31, `/intraday`, v2-reference/13-intraday-queue). Renders the ZM manual
 * same-day updates (MANUAL_ZM_UPDATE: ADD / REMOVE / REORDER) newest-first, with an update-type metric
 * strip and a table (Event / Ticket / SE / By / At). Manager roles only; these manual updates apply
 * immediately and need **no SE Acceptance** (AC#2) — the SE-Acceptance lifecycle belongs to the
 * system-triggered CRITICAL insertions (Issue 29), which land in this same view later.
 */
const EVENT_LABEL: Record<IntradayUpdateType, string> = {
  ADD: 'ZM same-day update — Add',
  REMOVE: 'ZM same-day update — Remove',
  REORDER: 'ZM same-day update — Reorder',
};

const EVENT_CLASS: Record<IntradayUpdateType, string> = {
  ADD: 'bg-emerald-100 text-emerald-800',
  REMOVE: 'bg-rose-100 text-rose-800',
  REORDER: 'bg-blue-100 text-blue-800',
};

const TYPES: IntradayUpdateType[] = ['ADD', 'REMOVE', 'REORDER'];

function fmtTime(iso: string): string {
  return iso.slice(0, 16).replace('T', ' ');
}

export function IntradayQueuePage() {
  const navigate = useNavigate();
  const [rows, setRows] = useState<IntradayUpdateRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiIntradayUpdates()
      .then(setRows)
      .catch(() => setError('Failed to load the Intra-day Queue'));
  }, []);

  const counts = TYPES.map((t) => ({ type: t, n: rows.filter((r) => r.updateType === t).length }));

  return (
    <div>
      <h2 className="mb-1 text-xl font-semibold">Intra-day Queue</h2>
      <p className="mb-4 text-sm text-slate-500">
        Zonal-Manager manual same-day changes to SE Day Plans — add, remove, or reorder. Each applies
        immediately; no SE Acceptance is required. System-triggered CRITICAL insertions appear here too.
      </p>

      {error && (
        <p role="alert" className="mb-4 text-sm text-red-700">
          {error}
        </p>
      )}

      <div data-testid="iq-metric-strip" className="mb-5 flex gap-3">
        {counts.map((c) => (
          <div key={c.type} data-testid={`iq-metric-${c.type}`} className="rounded border px-4 py-2">
            <div className="text-2xl font-semibold">{c.n}</div>
            <div className="text-xs uppercase tracking-wide text-slate-500">{c.type}</div>
          </div>
        ))}
      </div>

      <table aria-label="Intra-day Queue" className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b text-left text-slate-500">
            <th className="py-2 pr-3">Event</th>
            <th className="py-2 pr-3">Ticket</th>
            <th className="py-2 pr-3">SE</th>
            <th className="py-2 pr-3">SE Acceptance</th>
            <th className="py-2 pr-3">By</th>
            <th className="py-2 pr-3">At</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={6} className="py-4 text-slate-400">
                No intra-day updates yet today.
              </td>
            </tr>
          )}
          {rows.map((row) => (
            <tr key={row.auditId} data-testid={`iq-row-${row.auditId}`} className="border-b align-top hover:bg-slate-50">
              <td className="py-2 pr-3">
                <span className={`rounded px-2 py-0.5 text-xs ${EVENT_CLASS[row.updateType]}`}>
                  {EVENT_LABEL[row.updateType]}
                </span>
              </td>
              <td className="py-2 pr-3">
                {row.ticketId ? (
                  <button
                    type="button"
                    onClick={() => navigate(`/tickets/${row.ticketId}`)}
                    className="font-mono text-xs text-blue-700 hover:underline"
                  >
                    {row.ticketId.slice(0, 8)}
                  </button>
                ) : (
                  <span className="text-xs text-slate-400">—</span>
                )}
              </td>
              <td className="py-2 pr-3 font-mono text-xs">{row.seId ? row.seId.slice(0, 8) : '—'}</td>
              <td className="py-2 pr-3 text-xs text-slate-400">No acceptance required</td>
              <td className="py-2 pr-3 font-mono text-xs">{row.actorId.slice(0, 8)}</td>
              <td className="py-2 pr-3 text-slate-500">{fmtTime(row.createdAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
