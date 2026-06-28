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
import { DataTable, MetricCard, PageHeader, FilterSelect, type Column } from '../../components/data';
import { AgeChip, StatusPill } from '../../components/domain';
import { Button, Field, Input } from '../../components/ui';

/**
 * Warehouse Manager Component Requests queue (Issue 22 · FE-15 recipe, `/warehouse/requests`,
 * reference 18) and its read-only manager oversight variant (Issue 23). Lists active requests
 * (REQUESTED / APPROVED / SHIPPED) newest first with a lifecycle metric strip, and drives the WM legs:
 * Approve → Mark Shipped (tracking + delivery destination) or Reject (mandatory reason).
 *
 * FE-15 applies the canonical queue recipe (`MetricStrip` + `DataTable` + `StatusPill`). The
 * mandatory-reason / ship legs stay inline (the tests assert their labels + buttons by global query, and
 * they are already not `window.prompt`) — re-skinned onto `Button`/`Field`/`Input`. The `cr-metric-*` /
 * `cr-row-*` test ids, the `Component Requests` aria-label, the action labels, the read-only gating, and
 * the `?tab=Components` ticket navigation are all preserved.
 */
const METRICS: ComponentRequestStatus[] = ['REQUESTED', 'APPROVED', 'SHIPPED'];
const METRIC_TONE: Record<string, 'warning' | 'info' | 'verified'> = {
  REQUESTED: 'warning',
  APPROVED: 'info',
  SHIPPED: 'verified',
};

export function ComponentRequestsPage({ readOnly = false }: { readOnly?: boolean } = {}) {
  const navigate = useNavigate();
  const [rows, setRows] = useState<ComponentRequestRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [shippingId, setShippingId] = useState<string | null>(null);
  const [trackingRef, setTrackingRef] = useState('');
  const [destination, setDestination] = useState<DeliveryDestination>('SE_LOCATION');

  const load = useCallback(() => {
    setLoading(true);
    (readOnly ? apiComponentRequestsOversight() : apiComponentRequests())
      .then(setRows)
      .catch(() => setError('Failed to load Component Requests'))
      .finally(() => setLoading(false));
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

  const columns: Column<ComponentRequestRow>[] = [
    { key: 'request', header: 'Request', render: (r) => <span className="font-mono text-xs text-ink-muted">{r.requestId.slice(0, 8)}</span> },
    { key: 'company', header: 'Company', render: (r) => <span className="text-ink-strong">{r.companyName}</span> },
    { key: 'zone', header: 'Zone', render: (r) => <span className="text-ink-muted">{r.zoneName}</span> },
    { key: 'component', header: 'Component', render: (r) => <span className="text-ink">{r.componentName ?? '—'}</span> },
    { key: 'requestedby', header: 'Requested by', render: (r) => <span className="font-mono text-xs text-ink">{r.seId}</span> },
    {
      key: 'ticket',
      header: 'Ticket',
      render: (r) => (
        <button
          type="button"
          onClick={() => navigate(`/tickets/${r.ticketId}?tab=Components`)}
          className="font-mono text-xs text-brand-700 hover:underline"
        >
          {r.ticketId.slice(0, 8)}
        </button>
      ),
    },
    { key: 'status', header: 'Status', render: (r) => <StatusPill status={r.status} /> },
    { key: 'age', header: 'Age', align: 'right', render: (r) => <AgeChip days={r.ageDays} /> },
    {
      key: 'actions',
      header: 'Actions',
      render: (row) => {
        if (readOnly) return <span className="text-xs text-ink-muted">read-only</span>;
        if (row.status === 'REQUESTED' && rejectingId !== row.requestId) {
          return (
            <div className="flex gap-2">
              <Button type="button" size="sm" variant="secondary" onClick={() => approve(row.requestId)}>
                Approve
              </Button>
              <Button type="button" size="sm" variant="danger" onClick={() => setRejectingId(row.requestId)}>
                Reject
              </Button>
            </div>
          );
        }
        if (row.status === 'REQUESTED' && rejectingId === row.requestId) {
          return (
            <div className="flex flex-col gap-1">
              <Field label="Rejection reason" htmlFor={`reason-${row.requestId}`}>
                <Input id={`reason-${row.requestId}`} value={reason} onChange={(e) => setReason(e.target.value)} className="text-xs" />
              </Field>
              <div className="flex gap-2">
                <Button type="button" size="sm" variant="danger" onClick={() => confirmReject(row.requestId)}>
                  Confirm reject
                </Button>
                <Button type="button" size="sm" variant="secondary" onClick={() => { setRejectingId(null); setReason(''); }}>
                  Cancel
                </Button>
              </div>
            </div>
          );
        }
        if (row.status === 'APPROVED' && shippingId !== row.requestId) {
          return (
            <Button type="button" size="sm" variant="secondary" onClick={() => setShippingId(row.requestId)}>
              Mark Shipped
            </Button>
          );
        }
        if (row.status === 'APPROVED' && shippingId === row.requestId) {
          return (
            <div className="flex flex-col gap-1">
              <Field label="Tracking ref" htmlFor={`track-${row.requestId}`}>
                <Input id={`track-${row.requestId}`} value={trackingRef} onChange={(e) => setTrackingRef(e.target.value)} className="text-xs" />
              </Field>
              <Field label="Delivery destination" htmlFor={`dest-${row.requestId}`}>
                <FilterSelect
                  id={`dest-${row.requestId}`}
                  value={destination}
                  onChange={(e) => setDestination(e.target.value as DeliveryDestination)}
                  className="w-full"
                >
                  <option value="SE_LOCATION">SE location</option>
                  <option value="PLANT_WAREHOUSE">Plant warehouse</option>
                </FilterSelect>
              </Field>
              <div className="flex gap-2">
                <Button type="button" size="sm" onClick={() => confirmShip(row.requestId)}>
                  Confirm ship
                </Button>
                <Button type="button" size="sm" variant="secondary" onClick={() => { setShippingId(null); setTrackingRef(''); }}>
                  Cancel
                </Button>
              </div>
            </div>
          );
        }
        return null;
      },
    },
  ];

  return (
    <div>
      <PageHeader
        title="Component Requests"
        subtitle="Spare-part requests raised by SEs when a component is unavailable. Approve and ship, or reject with a reason — the Zonal Manager is notified on rejection."
      />

      {error && (
        <p role="alert" className="mb-4 text-sm text-critical">
          {error}
        </p>
      )}

      <div data-testid="cr-metric-strip" className="mb-5 grid grid-cols-3 gap-3">
        {counts.map((c) => (
          <div key={c.status} data-testid={`cr-metric-${c.status}`}>
            <MetricCard label={c.status} value={c.n} tone={METRIC_TONE[c.status]} />
          </div>
        ))}
      </div>

      <DataTable
        ariaLabel="Component Requests"
        rowKey={(r) => r.requestId}
        rowTestId={(r) => `cr-row-${r.requestId}`}
        columns={columns}
        rows={rows}
        loading={loading}
        empty="No active component requests."
      />
    </div>
  );
}
