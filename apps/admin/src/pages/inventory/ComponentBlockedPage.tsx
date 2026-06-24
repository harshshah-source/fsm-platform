import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiComponentBlocked, type ComponentBlockedRow } from '../../api/inventory';

/**
 * Component-Blocked Queue (Issue 21, `/component-blocked`). The ZM read-only view of Tickets the
 * Recommender dropped from a Day Plan because the eligible SE's Common Kit is incomplete. Each row
 * shows the SE, the missing parts, and the Warehouse-Manager action status; a row aged > 7 days with no
 * WM action carries a "Warehouse Overdue" badge (also surfaced in Action Required). Zone-scoped
 * server-side. Read-only — the ZM does not approve stock movement here.
 */
export function ComponentBlockedPage() {
  const navigate = useNavigate();
  const [rows, setRows] = useState<ComponentBlockedRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    apiComponentBlocked()
      .then((r) => alive && setRows(r))
      .catch(() => alive && setError('Failed to load the Component-Blocked Queue'));
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div>
      <h2 className="mb-1 text-xl font-semibold">Component-Blocked Queue</h2>
      <p className="mb-4 text-sm text-slate-500">
        Tickets dropped from a Day Plan because the eligible SE's Common Kit is incomplete. Read-only —
        warehouse stock movement is approved by the Warehouse Manager.
      </p>

      {error && (
        <p role="alert" className="mb-4 text-sm text-red-700">
          {error}
        </p>
      )}

      <table aria-label="Component-Blocked Queue" className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b text-left text-slate-500">
            <th className="py-2 pr-3">Company</th>
            <th className="py-2 pr-3">Zone</th>
            <th className="py-2 pr-3">Engineer</th>
            <th className="py-2 pr-3">Missing parts</th>
            <th className="py-2 pr-3">Warehouse</th>
            <th className="py-2 pr-3">Age</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={6} className="py-4 text-slate-400">
                No component-blocked tickets.
              </td>
            </tr>
          )}
          {rows.map((row) => (
            <tr
              key={row.id}
              data-testid={`cbq-row-${row.ticketId}`}
              onClick={() => navigate(`/tickets/${row.ticketId}?tab=Components`)}
              className="cursor-pointer border-b hover:bg-slate-50"
            >
              <td className="py-2 pr-3">{row.companyName}</td>
              <td className="py-2 pr-3 text-slate-600">{row.zoneName}</td>
              <td className="py-2 pr-3 font-mono text-xs">{row.seId}</td>
              <td className="py-2 pr-3">
                <span className="text-xs text-slate-700">
                  {row.missingComponents.map((m) => `${m.name} (×${m.shortBy})`).join(', ') || '—'}
                </span>
              </td>
              <td className="py-2 pr-3">
                {row.warehouseOverdue ? (
                  <span className="rounded bg-orange-100 px-2 py-0.5 text-xs text-orange-800">Warehouse Overdue</span>
                ) : (
                  <span className="rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-600">{row.wmActionStatus}</span>
                )}
              </td>
              <td className="py-2 pr-3 text-slate-500">{row.ageDays}d</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
