import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  apiApproveRequest,
  apiComponentRequests,
  apiComponentRequestsOversight,
  apiRejectRequest,
  apiShipRequest,
  type ComponentRequestRow,
  type ComponentRequestStatus,
  type DeliveryDestination,
} from '../../api/componentRequests';

/**
 * Warehouse Manager Component Requests queue (Issue 22, `/warehouse/requests`,
 * v2-reference/18-component-requests). Lists active requests (REQUESTED / APPROVED / SHIPPED) newest
 * first with a lifecycle metric strip, and drives the WM legs: Approve → Mark Shipped (tracking +
 * delivery destination) or Reject (mandatory reason). WAREHOUSE_MANAGER only.
 */
const METRICS: ComponentRequestStatus[] = ['REQUESTED', 'APPROVED', 'SHIPPED'];

const STATUS_CLASS: Record<ComponentRequestStatus, string> = {
  REQUESTED: 'bg-amber-100 text-amber-800',
  APPROVED: 'bg-blue-100 text-blue-800',
  SHIPPED: 'bg-violet-100 text-violet-800',
  RECEIVED: 'bg-green-100 text-green-800',
  REJECTED: 'bg-rose-100 text-rose-800',
};

export function ComponentRequestsPage({ readOnly = false }: { readOnly?: boolean } = {}) {
  const navigate = useNavigate();
  const [rows, setRows] = useState<ComponentRequestRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [shippingId, setShippingId] = useState<string | null>(null);
  const [trackingRef, setTrackingRef] = useState('');
  const [destination, setDestination] = useState<DeliveryDestination>('SE_LOCATION');

  const load = useCallback(() => {
    (readOnly ? apiComponentRequestsOversight() : apiComponentRequests())
      .then(setRows)
      .catch(() => setError('Failed to load Component Requests'));
  }, [readOnly]);

  useEffect(() => {
    load();
  }, [load]);

  const counts = METRICS.map((s) => ({ status: s, n: rows.filter((r) => r.status === s).length }));

  const approve = async (id: string) => {
    await apiApproveRequest(id);
    load();
  };
  const confirmReject = async (id: string) => {
    if (!reason.trim()) return;
    await apiRejectRequest(id, reason.trim());
    setRejectingId(null);
    setReason('');
    load();
  };
  const confirmShip = async (id: string) => {
    if (!trackingRef.trim()) return;
    await apiShipRequest(id, { trackingRef: trackingRef.trim(), deliveryDestination: destination });
    setShippingId(null);
    setTrackingRef('');
    load();
  };

  return (
    <div>
      <h2 className="mb-1 text-xl font-semibold">Component Requests</h2>
      <p className="mb-4 text-sm text-slate-500">
        Spare-part requests raised by SEs when a component is unavailable. Approve and ship, or reject
        with a reason — the Zonal Manager is notified on rejection.
      </p>

      {error && (
        <p role="alert" className="mb-4 text-sm text-red-700">
          {error}
        </p>
      )}

      <div data-testid="cr-metric-strip" className="mb-5 flex gap-3">
        {counts.map((c) => (
          <div key={c.status} data-testid={`cr-metric-${c.status}`} className="rounded border px-4 py-2">
            <div className="text-2xl font-semibold">{c.n}</div>
            <div className="text-xs uppercase tracking-wide text-slate-500">{c.status}</div>
          </div>
        ))}
      </div>

      <table aria-label="Component Requests" className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b text-left text-slate-500">
            <th className="py-2 pr-3">Request</th>
            <th className="py-2 pr-3">Company</th>
            <th className="py-2 pr-3">Zone</th>
            <th className="py-2 pr-3">Component</th>
            <th className="py-2 pr-3">Requested by</th>
            <th className="py-2 pr-3">Ticket</th>
            <th className="py-2 pr-3">Status</th>
            <th className="py-2 pr-3">Age</th>
            <th className="py-2 pr-3">Actions</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={9} className="py-4 text-slate-400">
                No active component requests.
              </td>
            </tr>
          )}
          {rows.map((row) => (
            <tr key={row.requestId} data-testid={`cr-row-${row.requestId}`} className="border-b align-top hover:bg-slate-50">
              <td className="py-2 pr-3 font-mono text-xs">{row.requestId.slice(0, 8)}</td>
              <td className="py-2 pr-3">{row.companyName}</td>
              <td className="py-2 pr-3 text-slate-600">{row.zoneName}</td>
              <td className="py-2 pr-3">{row.componentName ?? '—'}</td>
              <td className="py-2 pr-3 font-mono text-xs">{row.seId}</td>
              <td className="py-2 pr-3">
                <button
                  type="button"
                  onClick={() => navigate(`/tickets/${row.ticketId}?tab=Components`)}
                  className="font-mono text-xs text-blue-700 hover:underline"
                >
                  {row.ticketId.slice(0, 8)}
                </button>
              </td>
              <td className="py-2 pr-3">
                <span className={`rounded px-2 py-0.5 text-xs ${STATUS_CLASS[row.status]}`}>{row.status}</span>
              </td>
              <td className="py-2 pr-3 text-slate-500">{row.ageDays}d</td>
              <td className="py-2 pr-3">
                {readOnly && <span className="text-xs text-slate-400">read-only</span>}
                {!readOnly && row.status === 'REQUESTED' && rejectingId !== row.requestId && (
                  <div className="flex gap-2">
                    <button type="button" onClick={() => approve(row.requestId)} className="rounded border px-2 py-0.5 text-xs">
                      Approve
                    </button>
                    <button
                      type="button"
                      onClick={() => setRejectingId(row.requestId)}
                      className="rounded border px-2 py-0.5 text-xs text-rose-700"
                    >
                      Reject
                    </button>
                  </div>
                )}
                {!readOnly && row.status === 'REQUESTED' && rejectingId === row.requestId && (
                  <div className="flex flex-col gap-1">
                    <label className="text-xs text-slate-500" htmlFor={`reason-${row.requestId}`}>
                      Rejection reason
                    </label>
                    <input
                      id={`reason-${row.requestId}`}
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                      className="rounded border px-2 py-0.5 text-xs"
                    />
                    <div className="flex gap-2">
                      <button type="button" onClick={() => confirmReject(row.requestId)} className="rounded border px-2 py-0.5 text-xs text-rose-700">
                        Confirm reject
                      </button>
                      <button type="button" onClick={() => { setRejectingId(null); setReason(''); }} className="rounded border px-2 py-0.5 text-xs">
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
                {!readOnly && row.status === 'APPROVED' && shippingId !== row.requestId && (
                  <button type="button" onClick={() => setShippingId(row.requestId)} className="rounded border px-2 py-0.5 text-xs">
                    Mark Shipped
                  </button>
                )}
                {!readOnly && row.status === 'APPROVED' && shippingId === row.requestId && (
                  <div className="flex flex-col gap-1">
                    <label className="text-xs text-slate-500" htmlFor={`track-${row.requestId}`}>
                      Tracking ref
                    </label>
                    <input
                      id={`track-${row.requestId}`}
                      value={trackingRef}
                      onChange={(e) => setTrackingRef(e.target.value)}
                      className="rounded border px-2 py-0.5 text-xs"
                    />
                    <label className="text-xs text-slate-500" htmlFor={`dest-${row.requestId}`}>
                      Delivery destination
                    </label>
                    <select
                      id={`dest-${row.requestId}`}
                      value={destination}
                      onChange={(e) => setDestination(e.target.value as DeliveryDestination)}
                      className="rounded border px-2 py-0.5 text-xs"
                    >
                      <option value="SE_LOCATION">SE location</option>
                      <option value="PLANT_WAREHOUSE">Plant warehouse</option>
                    </select>
                    <div className="flex gap-2">
                      <button type="button" onClick={() => confirmShip(row.requestId)} className="rounded border px-2 py-0.5 text-xs">
                        Confirm ship
                      </button>
                      <button type="button" onClick={() => { setShippingId(null); setTrackingRef(''); }} className="rounded border px-2 py-0.5 text-xs">
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
