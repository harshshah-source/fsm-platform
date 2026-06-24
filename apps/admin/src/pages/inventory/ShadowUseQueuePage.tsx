import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  apiDisputeShadowUse,
  apiReconcileShadowUse,
  apiShadowUse,
  type ShadowUseRow,
} from '../../api/shadowUse';

/**
 * Warehouse Manager Shadow Use Queue (Issue 24, `/warehouse/shadow-use`,
 * v2-reference/19-shadow-use-queue). Unreconciled SHADOW_USE rows — components a 409-loser SE
 * physically consumed — with per-row Mark Reconciled (genuine duplicate effort) or Mark Disputed
 * (mandatory reason → escalates to the ZM and flags the Ticket). WAREHOUSE_MANAGER only.
 */
export function ShadowUseQueuePage() {
  const navigate = useNavigate();
  const [rows, setRows] = useState<ShadowUseRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [disputingId, setDisputingId] = useState<string | null>(null);
  const [reason, setReason] = useState('');

  const load = useCallback(() => {
    apiShadowUse()
      .then(setRows)
      .catch(() => setError('Failed to load the Shadow Use Queue'));
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

  return (
    <div>
      <h2 className="mb-1 text-xl font-semibold">Shadow Use Queue</h2>
      <p className="mb-4 text-sm text-slate-500">
        Components a second SE consumed on a Ticket that another SE had already closed (business 409).
        Reconcile genuine duplicate effort, or dispute a mismatch — a dispute escalates to the Zonal
        Manager and flags the Ticket.
      </p>

      {error && (
        <p role="alert" className="mb-4 text-sm text-red-700">
          {error}
        </p>
      )}

      <div className="mb-5 flex gap-3">
        <div data-testid="su-metric-UNRECONCILED" className="rounded border px-4 py-2">
          <div className="text-2xl font-semibold">{rows.length}</div>
          <div className="text-xs uppercase tracking-wide text-slate-500">Unreconciled</div>
        </div>
      </div>

      <table aria-label="Shadow Use Queue" className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b text-left text-slate-500">
            <th className="py-2 pr-3">Ticket</th>
            <th className="py-2 pr-3">Component</th>
            <th className="py-2 pr-3">Qty</th>
            <th className="py-2 pr-3">Engineer</th>
            <th className="py-2 pr-3">Company</th>
            <th className="py-2 pr-3">Age</th>
            <th className="py-2 pr-3">Actions</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={7} className="py-4 text-slate-400">
                No unreconciled shadow-use rows.
              </td>
            </tr>
          )}
          {rows.map((row) => (
            <tr key={row.id} data-testid={`su-row-${row.id}`} className="border-b align-top hover:bg-slate-50">
              <td className="py-2 pr-3">
                {row.ticketId ? (
                  <button
                    type="button"
                    onClick={() => navigate(`/tickets/${row.ticketId}?tab=Components`)}
                    className="font-mono text-xs text-blue-700 hover:underline"
                  >
                    {row.ticketId.slice(0, 8)}
                  </button>
                ) : (
                  '—'
                )}
              </td>
              <td className="py-2 pr-3">{row.componentName ?? '—'}</td>
              <td className="py-2 pr-3">{row.qty}</td>
              <td className="py-2 pr-3 font-mono text-xs">{row.seId}</td>
              <td className="py-2 pr-3">{row.companyName ?? '—'}</td>
              <td className="py-2 pr-3 text-slate-500">{row.ageDays}d</td>
              <td className="py-2 pr-3">
                {disputingId !== row.id && (
                  <div className="flex gap-2">
                    <button type="button" onClick={() => reconcile(row.id)} className="rounded border px-2 py-0.5 text-xs">
                      Reconcile
                    </button>
                    <button type="button" onClick={() => setDisputingId(row.id)} className="rounded border px-2 py-0.5 text-xs text-rose-700">
                      Dispute
                    </button>
                  </div>
                )}
                {disputingId === row.id && (
                  <div className="flex flex-col gap-1">
                    <label className="text-xs text-slate-500" htmlFor={`dispute-${row.id}`}>
                      Dispute reason
                    </label>
                    <input
                      id={`dispute-${row.id}`}
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                      className="rounded border px-2 py-0.5 text-xs"
                    />
                    <div className="flex gap-2">
                      <button type="button" onClick={() => confirmDispute(row.id)} className="rounded border px-2 py-0.5 text-xs text-rose-700">
                        Confirm dispute
                      </button>
                      <button type="button" onClick={() => { setDisputingId(null); setReason(''); }} className="rounded border px-2 py-0.5 text-xs">
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
