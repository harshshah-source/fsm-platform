import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiComponentRequests, type ComponentRequestRow } from '../../api/componentRequests';
import { apiComponentBlocked, type ComponentBlockedRow } from '../../api/inventory';
import { apiShadowUse, type ShadowUseRow } from '../../api/shadowUse';
import {
  DataTable,
  DateRangeChips,
  EmptyState,
  MetricStrip,
  PageHeader,
  type Column,
  type Metric,
} from '../../components/data';
import { AgeChip, StatusPill } from '../../components/domain';
import { Badge, SectionCard } from '../../components/ui';

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
  const [requests, setRequests] = useState<ComponentRequestRow[]>([]);
  const [blocked, setBlocked] = useState<ComponentBlockedRow[]>([]);
  const [shadow, setShadow] = useState<ShadowUseRow[]>([]);
  const [error, setError] = useState<string | null>(null);

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
    return () => {
      alive = false;
    };
  }, []);

  const metrics: Metric[] = useMemo(() => {
    const open = requests.filter((r) => r.status === 'REQUESTED' || r.status === 'APPROVED' || r.status === 'SHIPPED').length;
    return [
      { label: 'Open Requests', value: open, hint: 'awaiting fulfilment', tone: 'info' },
      { label: 'Tickets Blocked', value: blocked.length, hint: 'on a component', tone: 'warning' },
      { label: 'Low-Stock SKUs', value: '—', hint: 'Warehouse stock report', tone: 'critical' },
      { label: 'Fulfillment SLA', value: '—', hint: 'Warehouse stock report', tone: 'brand' },
    ];
  }, [requests, blocked]);

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
      <PageHeader
        title="Zone Warehouse Fulfillment"
        subtitle="Component requests, blocked tickets, and shadow-use reconciliation for your zone warehouse."
        actions={
          <>
            <Badge tone="success" dot>
              Snapshot Healthy
            </Badge>
            <DateRangeChips />
          </>
        }
      />

      {error && (
        <p role="alert" className="mb-4 text-sm text-critical">
          {error}
        </p>
      )}

      <MetricStrip metrics={metrics} />

      <SectionCard
        title="Component Request Queue"
        action={
          <Link to="/warehouse/requests" className="text-xs font-medium text-brand-700 hover:underline">
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

      <SectionCard title="Warehouse Stock" className="mb-6">
        <EmptyState message="Warehouse stock levels appear here once the stock read endpoint lands (BE follow-up #73)." />
      </SectionCard>

      <SectionCard
        title="Shadow-Use Reconciliation"
        action={
          <Link to="/warehouse/shadow-use" className="text-xs font-medium text-brand-700 hover:underline">
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
