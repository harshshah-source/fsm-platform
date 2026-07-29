import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiComponentRequests, type ComponentRequestRow } from '../../api/componentRequests';
import {
  apiComponentBlocked,
  apiFulfillmentSla,
  apiSetWarehouseStock,
  apiWarehouseStock,
  type ComponentBlockedRow,
  type FulfillmentSla,
  type WarehouseStockRow,
} from '../../api/inventory';
import { apiShadowUse, type ShadowUseRow } from '../../api/shadowUse';
import { useAuth } from '../../auth/AuthProvider';
import {
  DataTable,
  DateRangeChips,
  EmptyState,
  type Column,
  type Metric,
} from '../../components/data';
import { DashboardHero } from './DashboardHero';
import { AgeChip, StatusPill } from '../../components/domain';
import { Badge, Button, Field, Input, SectionCard } from '../../components/ui';
import { Modal } from '../../components/overlay/Modal';

/**
 * Warehouse-Manager dashboard — "Zone Warehouse Fulfillment" (FE-17, reference 05). A role-variant of
 * `/` selected in `DashboardHome` for `WAREHOUSE_MANAGER`. Composes the existing WM aggregations (no new
 * endpoints): the Component Request queue, the Component-Blocked tickets, and the Shadow-Use queue.
 *
 * Documented omission (DESIGN-SYSTEM §9.2): the reference's Warehouse Stock table + Low-Stock /
 * Fulfillment-SLA KPIs have no backend read endpoint yet (filed as #73). Those cards/sections render the
 * reference chrome with a `—` placeholder / gated note rather than fabricated stock figures.
 */
export function WarehouseDashboard() {
  const { session } = useAuth();
  const canAdjust = session?.role === 'WAREHOUSE_MANAGER' || session?.role === 'OPERATIONS_HEAD';

  const [requests, setRequests] = useState<ComponentRequestRow[]>([]);
  const [blocked, setBlocked] = useState<ComponentBlockedRow[]>([]);
  const [shadow, setShadow] = useState<ShadowUseRow[]>([]);
  const [stock, setStock] = useState<WarehouseStockRow[]>([]);
  const [fulfillment, setFulfillment] = useState<FulfillmentSla | null>(null);
  const [editing, setEditing] = useState<WarehouseStockRow | null>(null);
  const [form, setForm] = useState({ onHand: '', reserved: '', lowStockThreshold: '' });
  const [error, setError] = useState<string | null>(null);

  const loadStock = () => {
    apiWarehouseStock().then(setStock).catch(() => setStock([]));
    apiFulfillmentSla().then(setFulfillment).catch(() => setFulfillment(null));
  };

  useEffect(() => {
    let alive = true;
    Promise.all([
      apiComponentRequests().catch(() => [] as ComponentRequestRow[]),
      apiComponentBlocked().catch(() => [] as ComponentBlockedRow[]),
      apiShadowUse().catch(() => [] as ShadowUseRow[]),
    ])
      .then(([req, blk, sh]) => {
        if (!alive) return;
        setRequests(req);
        setBlocked(blk);
        setShadow(sh);
      })
      .catch(() => alive && setError('Failed to load the warehouse dashboard'));
    loadStock();
    return () => {
      alive = false;
    };
  }, []);

  const lowStockCount = useMemo(() => stock.filter((s) => s.lowStock).length, [stock]);

  const metrics: Metric[] = useMemo(() => {
    const open = requests.filter((r) => r.status === 'REQUESTED' || r.status === 'APPROVED' || r.status === 'SHIPPED').length;
    const slaValue = fulfillment && typeof fulfillment.withinSlaPct === 'number' ? `${fulfillment.withinSlaPct}%` : '—';
    return [
      { label: 'Open Requests', value: open, hint: 'awaiting fulfilment', tone: 'info', hero: true },
      { label: 'Tickets Blocked', value: blocked.length, hint: 'on a component', tone: 'warning' },
      { label: 'Low-Stock SKUs', value: stock.length ? lowStockCount : '—', hint: 'available ≤ threshold', tone: 'critical' },
      { label: 'Fulfillment SLA', value: slaValue, hint: fulfillment ? `within ${fulfillment.slaWindowDays}d` : 'Component requests', tone: 'brand' },
    ];
  }, [requests, blocked, stock, lowStockCount, fulfillment]);

  const openAdjust = (row: WarehouseStockRow) => {
    setEditing(row);
    setForm({ onHand: String(row.onHand), reserved: String(row.reserved), lowStockThreshold: String(row.lowStockThreshold) });
  };

  const saveAdjust = async () => {
    if (!editing) return;
    try {
      await apiSetWarehouseStock({
        zoneId: editing.zoneId,
        componentId: editing.componentId,
        onHand: Number(form.onHand),
        reserved: Number(form.reserved),
        lowStockThreshold: Number(form.lowStockThreshold),
      });
      setEditing(null);
      loadStock();
    } catch {
      setError('Failed to update stock');
      setEditing(null);
    }
  };

  const stockColumns: Column<WarehouseStockRow>[] = [
    { key: 'component', header: 'Component', render: (r) => <span className="text-ink-strong">{r.componentName}</span> },
    { key: 'zone', header: 'Zone', render: (r) => r.zoneName },
    { key: 'onHand', header: 'On hand', align: 'right', render: (r) => <span className="tabular-nums">{r.onHand}</span> },
    { key: 'reserved', header: 'Reserved', align: 'right', render: (r) => <span className="tabular-nums">{r.reserved}</span> },
    {
      key: 'available',
      header: 'Available',
      align: 'right',
      render: (r) => (
        <span className="tabular-nums">
          {r.available}
          {r.lowStock && (
            <Badge tone="critical" className="ml-2">
              Low
            </Badge>
          )}
        </span>
      ),
    },
    { key: 'threshold', header: 'Threshold', align: 'right', render: (r) => <span className="tabular-nums text-ink-muted">{r.lowStockThreshold}</span> },
    ...(canAdjust
      ? [
          {
            key: 'action',
            header: '',
            align: 'right' as const,
            exportable: false,
            render: (r: WarehouseStockRow) => (
              <Button size="sm" variant="secondary" data-testid={`stock-adjust-${r.componentId}`} onClick={() => openAdjust(r)}>
                Adjust
              </Button>
            ),
          },
        ]
      : []),
  ];

  const requestColumns: Column<ComponentRequestRow>[] = [
    { key: 'component', header: 'Component', render: (r) => <span className="text-ink-strong">{r.componentName ?? '—'}</span> },
    { key: 'company', header: 'Company', render: (r) => <span className="text-ink">{r.companyName}</span> },
    { key: 'se', header: 'Requested by', render: (r) => <span className="font-mono text-xs text-ink">{r.seId}</span> },
    { key: 'status', header: 'Status', render: (r) => <StatusPill status={r.status} /> },
    { key: 'age', header: 'Age', align: 'right', render: (r) => <AgeChip days={r.ageDays} /> },
  ];

  const shadowColumns: Column<ShadowUseRow>[] = [
    { key: 'component', header: 'Component', render: (r) => <span className="text-ink-strong">{r.componentName ?? '—'}</span> },
    { key: 'qty', header: 'Qty', align: 'right', render: (r) => <span className="tabular-nums">{r.qty}</span> },
    { key: 'se', header: 'Engineer', render: (r) => <span className="font-mono text-xs text-ink">{r.seId}</span> },
    { key: 'company', header: 'Company', render: (r) => <span className="text-ink">{r.companyName ?? '—'}</span> },
  ];

  return (
    <div data-testid="warehouse-dashboard">
      {/* Hero top section (docs/ui/hero-ref.jpg): 2 KPIs each side of the truck. */}
      <DashboardHero
        title="Zone Warehouse Fulfillment"
        actions={
          <>
            <Badge tone="success" dot>
              Snapshot Healthy
            </Badge>
            <DateRangeChips />
          </>
        }
        left={metrics.slice(0, 2)}
        right={metrics.slice(2, 4)}
      />

      {error && (
        <p role="alert" className="mb-4 text-sm text-critical">
          {error}
        </p>
      )}

      <SectionCard
        title="Component Request Queue"
        action={
          <Link to="/warehouse/requests" className="text-xs font-medium text-link hover:underline">
            Open queue →
          </Link>
        }
        className="mb-6"
        bodyClassName="p-0"
      >
        <DataTable
          ariaLabel="Component Request Queue"
          rowKey={(r) => r.requestId}
          columns={requestColumns}
          rows={requests}
          empty="No active component requests."
        />
      </SectionCard>

      <SectionCard title="Warehouse Stock" className="mb-6" bodyClassName="p-0">
        <DataTable
          ariaLabel="Warehouse Stock"
          rowKey={(r) => `${r.zoneId}-${r.componentId}`}
          rowTestId={(r) => `stock-row-${r.componentId}`}
          columns={stockColumns}
          rows={stock}
          empty={<EmptyState message="No warehouse stock recorded yet. Adjust a SKU to set on-hand levels." />}
        />
      </SectionCard>

      <Modal
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing ? `Adjust stock — ${editing.componentName} (${editing.zoneName})` : ''}
        footer={
          <>
            <Button variant="secondary" size="sm" onClick={() => setEditing(null)}>
              Cancel
            </Button>
            <Button variant="primary" size="sm" data-testid="stock-save" onClick={() => void saveAdjust()}>
              Save
            </Button>
          </>
        }
      >
        <div className="grid grid-cols-3 gap-3">
          <Field label="On hand" htmlFor="stock-on-hand">
            <Input id="stock-on-hand" type="number" min={0} value={form.onHand} onChange={(e) => setForm((f) => ({ ...f, onHand: e.target.value }))} />
          </Field>
          <Field label="Reserved" htmlFor="stock-reserved">
            <Input id="stock-reserved" type="number" min={0} value={form.reserved} onChange={(e) => setForm((f) => ({ ...f, reserved: e.target.value }))} />
          </Field>
          <Field label="Low-stock threshold" htmlFor="stock-threshold">
            <Input id="stock-threshold" type="number" min={0} value={form.lowStockThreshold} onChange={(e) => setForm((f) => ({ ...f, lowStockThreshold: e.target.value }))} />
          </Field>
        </div>
      </Modal>

      <SectionCard
        title="Shadow-Use Reconciliation"
        action={
          <Link to="/warehouse/shadow-use" className="text-xs font-medium text-link hover:underline">
            Open queue →
          </Link>
        }
        bodyClassName="p-0"
      >
        <DataTable
          ariaLabel="Shadow-Use Reconciliation"
          rowKey={(r) => r.id}
          columns={shadowColumns}
          rows={shadow}
          empty="No unreconciled shadow-use rows."
        />
      </SectionCard>
    </div>
  );
}
