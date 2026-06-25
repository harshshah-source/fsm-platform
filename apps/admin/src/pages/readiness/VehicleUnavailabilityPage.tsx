import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  apiConfirmVuDate,
  apiResumeVuSla,
  apiVehicleUnavailability,
  type VehicleUnavailReason,
  type VehicleUnavailRow,
} from '../../api/vehicleUnavailability';

/**
 * ZM Vehicle Unavailability Review (Issue 28, `/readiness/vehicle-unavailability`,
 * v2-reference/11-vehicle-unavailability). Lists OPEN reports newest-first with a metric strip and a
 * table carrying BOTH SLA clocks — the **secondary** (true-elapsed, never-pausing) clock is
 * manager-only by living on this manager-gated surface, never the SE. Per-row ZM legs: Confirm date
 * (edit/confirm the expected-availability window) and Resume SLA (manually resume the primary SLA,
 * which resolves the report). Manager roles only (ZM own-zone; CSM / Operations Head all zones).
 */
const REASON_LABELS: Record<VehicleUnavailReason, string> = {
  VEHICLE_ON_TRIP: 'Vehicle on trip',
  VEHICLE_NOT_AT_PLANT: 'Vehicle not at plant',
  DRIVER_NOT_AVAILABLE: 'Driver not available',
  CUSTOMER_REFUSED: 'Customer refused',
  OTHER: 'Other',
};

/** Humanise an elapsed-seconds clock as "Hh Mm" (the SLA-clock display in ref 11). */
function fmtDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

function fmtDate(iso: string): string {
  return iso.slice(0, 10);
}

export function VehicleUnavailabilityPage() {
  const navigate = useNavigate();
  const [rows, setRows] = useState<VehicleUnavailRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [dateInput, setDateInput] = useState('');

  const load = useCallback(() => {
    apiVehicleUnavailability()
      .then(setRows)
      .catch(() => setError('Failed to load Vehicle Unavailability Reports'));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const pausedCount = rows.filter((r) => r.slaPaused).length;
  const contactedCount = rows.filter((r) => r.transporterContacted).length;

  const saveDate = async (id: string) => {
    if (!dateInput.trim()) return;
    const iso = new Date(dateInput).toISOString();
    await apiConfirmVuDate(id, iso);
    setEditingId(null);
    setDateInput('');
    load();
  };
  const resume = async (id: string) => {
    await apiResumeVuSla(id);
    load();
  };

  return (
    <div>
      <h2 className="mb-1 text-xl font-semibold">Vehicle Unavailability Reports</h2>
      <p className="mb-4 text-sm text-slate-500">
        Open reports where an SE could not work the vehicle. The primary SLA is paused while the
        vehicle is unavailable; the secondary clock keeps counting true elapsed time. Confirm the
        expected-availability date, or manually resume the SLA once the vehicle is back.
      </p>

      {error && (
        <p role="alert" className="mb-4 text-sm text-red-700">
          {error}
        </p>
      )}

      <div data-testid="vu-metric-strip" className="mb-5 flex gap-3">
        <div data-testid="vu-metric-open" className="rounded border px-4 py-2">
          <div className="text-2xl font-semibold">{rows.length}</div>
          <div className="text-xs uppercase tracking-wide text-slate-500">Open reports</div>
        </div>
        <div data-testid="vu-metric-paused" className="rounded border px-4 py-2">
          <div className="text-2xl font-semibold">{pausedCount}</div>
          <div className="text-xs uppercase tracking-wide text-slate-500">SLA paused</div>
        </div>
        <div data-testid="vu-metric-contacted" className="rounded border px-4 py-2">
          <div className="text-2xl font-semibold">{contactedCount}</div>
          <div className="text-xs uppercase tracking-wide text-slate-500">Transporter contacted</div>
        </div>
      </div>

      <table aria-label="Vehicle Unavailability Reports" className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b text-left text-slate-500">
            <th className="py-2 pr-3">Report</th>
            <th className="py-2 pr-3">Ticket</th>
            <th className="py-2 pr-3">Vehicle &amp; Plant</th>
            <th className="py-2 pr-3">Reason</th>
            <th className="py-2 pr-3">Filed by</th>
            <th className="py-2 pr-3">Expected date</th>
            <th className="py-2 pr-3">Primary SLA</th>
            <th className="py-2 pr-3">Secondary SLA</th>
            <th className="py-2 pr-3">Status</th>
            <th className="py-2 pr-3">Actions</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={10} className="py-4 text-slate-400">
                No open vehicle-unavailability reports.
              </td>
            </tr>
          )}
          {rows.map((row) => (
            <tr key={row.id} data-testid={`vu-row-${row.id}`} className="border-b align-top hover:bg-slate-50">
              <td className="py-2 pr-3 font-mono text-xs">{row.id.slice(0, 8)}</td>
              <td className="py-2 pr-3">
                <button
                  type="button"
                  onClick={() => navigate(`/tickets/${row.ticketId}`)}
                  className="font-mono text-xs text-blue-700 hover:underline"
                >
                  {row.ticketId.slice(0, 8)}
                </button>
              </td>
              <td className="py-2 pr-3">{row.plantName}</td>
              <td className="py-2 pr-3">
                {REASON_LABELS[row.reasonCode]}
                {row.transporterContacted && (
                  <span className="ml-1 text-xs text-slate-400">· transporter contacted</span>
                )}
              </td>
              <td className="py-2 pr-3 font-mono text-xs">{row.seId.slice(0, 8)}</td>
              <td className="py-2 pr-3 text-slate-600">{fmtDate(row.expectedFrom)}</td>
              <td data-testid={`vu-primary-${row.id}`} className="py-2 pr-3 text-amber-700">
                {fmtDuration(row.primarySlaSeconds)}
                {row.slaPaused && <span className="ml-1 text-xs text-amber-500">(paused)</span>}
              </td>
              <td data-testid={`vu-secondary-${row.id}`} className="py-2 pr-3 text-rose-700">
                {fmtDuration(row.secondarySlaSeconds)}
              </td>
              <td className="py-2 pr-3">
                <span className="rounded bg-amber-100 px-2 py-0.5 text-xs text-amber-800">{row.status}</span>
              </td>
              <td className="py-2 pr-3">
                {editingId !== row.id && (
                  <div className="flex gap-2">
                    <button type="button" onClick={() => { setEditingId(row.id); setDateInput(''); }} className="rounded border px-2 py-0.5 text-xs">
                      Confirm date
                    </button>
                    <button type="button" onClick={() => resume(row.id)} className="rounded border px-2 py-0.5 text-xs text-emerald-700">
                      Resume SLA
                    </button>
                  </div>
                )}
                {editingId === row.id && (
                  <div className="flex flex-col gap-1">
                    <label className="text-xs text-slate-500" htmlFor={`date-${row.id}`}>
                      Expected date
                    </label>
                    <input
                      id={`date-${row.id}`}
                      type="datetime-local"
                      value={dateInput}
                      onChange={(e) => setDateInput(e.target.value)}
                      className="rounded border px-2 py-0.5 text-xs"
                    />
                    <div className="flex gap-2">
                      <button type="button" onClick={() => saveDate(row.id)} className="rounded border px-2 py-0.5 text-xs">
                        Save date
                      </button>
                      <button type="button" onClick={() => { setEditingId(null); setDateInput(''); }} className="rounded border px-2 py-0.5 text-xs">
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
