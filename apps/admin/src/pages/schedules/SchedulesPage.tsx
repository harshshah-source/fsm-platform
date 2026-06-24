import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiListSchedules, type ScheduleRow } from '../../api/schedules';

/**
 * ZM Batch-Schedule list (Issue 13b AC#1). One row per SE Work Schedule with batch/ticket counts and an
 * AUTO_ASSIGNED / OVERRIDDEN status badge. Monitoring only: system batches auto-dispatch to the SE Day
 * Plan, so there is no Approve action and no approval countdown (the gate was removed — ADR-0019
 * superseded). Zone scope is enforced server-side (a ZM sees their own zone; CSM / Ops Head see all).
 */
const STATUS_CLASS: Record<string, string> = {
  AUTO_ASSIGNED: 'bg-slate-200 text-slate-700',
  OVERRIDDEN: 'bg-amber-100 text-amber-800',
};

export function SchedulesPage() {
  const [rows, setRows] = useState<ScheduleRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    apiListSchedules()
      .then((r) => alive && setRows(r))
      .catch(() => alive && setError('Failed to load schedules'));
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div>
      <h2 className="mb-4 text-xl font-semibold">Batch Schedules</h2>
      {error && (
        <p role="alert" className="mb-4 text-sm text-red-700">
          {error}
        </p>
      )}
      <table aria-label="Batch Schedules" className="w-full text-sm">
        <thead>
          <tr className="border-b text-left text-slate-500">
            <th className="py-2">Engineer</th>
            <th className="py-2">Dates</th>
            <th className="py-2">Batches</th>
            <th className="py-2">Tickets</th>
            <th className="py-2">Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.scheduleId} className="border-b">
              <td className="py-2">
                <Link to={`/schedules/${r.seId}`} className="text-slate-700 hover:underline">
                  {r.seId}
                </Link>
              </td>
              <td className="py-2">{r.dateFrom === r.dateTo ? r.dateFrom : `${r.dateFrom} – ${r.dateTo}`}</td>
              <td className="py-2">{r.batchCount}</td>
              <td className="py-2">{r.ticketCount}</td>
              <td className="py-2">
                <span
                  data-testid={`schedule-status-${r.status}`}
                  className={`rounded px-2 py-0.5 text-xs ${STATUS_CLASS[r.status] ?? 'bg-slate-200 text-slate-700'}`}
                >
                  {r.status}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
