import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiComponentBlocked, type ComponentBlockedRow } from '../../api/inventory';
import { Badge } from '../../components/ui/Badge';
import { DataTable, type Column } from '../../components/data/DataTable';
import { EmptyState } from '../../components/data/feedback';
import { FilterBar, SearchInput } from '../../components/data/FilterBar';
import { MetricStrip } from '../../components/data/MetricStrip';
import { PageHeader } from '../../components/data/PageHeader';
import { useApiResource } from '../../hooks';

/**
 * Component-Blocked Queue (Issue 21, `/component-blocked`) — reskinned to the reference (17) recipe in
 * FE-03: PageHeader + MetricStrip + FilterBar + DataTable. The ZM read-only view of Tickets the
 * Recommender dropped from a Day Plan because the eligible SE's Common Kit is incomplete. A row aged
 * > 7 days with no WM action carries a "Warehouse Overdue" badge. Zone-scoped server-side; row click
 * deep-links to the ticket Components tab. Data fetching, scoping, and selectors are unchanged.
 */
export function ComponentBlockedPage() {
  const navigate = useNavigate();
  const { data, loading, error } = useApiResource<ComponentBlockedRow[]>(
    () => apiComponentBlocked(),
    [],
    'Failed to load the Component-Blocked Queue',
  );
  const rows = data ?? [];
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (r) =>
        r.companyName.toLowerCase().includes(q) ||
        r.zoneName.toLowerCase().includes(q) ||
        r.seId.toLowerCase().includes(q),
    );
  }, [rows, query]);

  const overdue = rows.filter((r) => r.warehouseOverdue).length;
  const engineers = new Set(rows.map((r) => r.seId)).size;
  const oldest = rows.reduce((m, r) => Math.max(m, r.ageDays), 0);

  const columns: Column<ComponentBlockedRow>[] = [
    { key: 'company', header: 'Company', render: (r) => <span className="font-medium text-ink-strong">{r.companyName}</span> },
    { key: 'zone', header: 'Zone', render: (r) => <span className="text-ink-muted">{r.zoneName}</span> },
    { key: 'engineer', header: 'Engineer', render: (r) => <span className="font-mono text-xs">{r.seId}</span> },
    {
      key: 'missing',
      header: 'Missing parts',
      render: (r) => (
        <span className="text-xs">
          {r.missingComponents.map((m) => `${m.name} (×${m.shortBy})`).join(', ') || '—'}
        </span>
      ),
    },
    {
      key: 'warehouse',
      header: 'Warehouse',
      render: (r) =>
        r.warehouseOverdue ? (
          <Badge tone="warning">Warehouse Overdue</Badge>
        ) : (
          <Badge tone="neutral">{r.wmActionStatus}</Badge>
        ),
    },
    {
      key: 'age',
      header: 'Age',
      align: 'right',
      sortable: true,
      sortValue: (r) => r.ageDays,
      render: (r) => <span className="text-ink-muted">{r.ageDays}d</span>,
    },
  ];

  return (
    <div>
      <PageHeader
        title="Component-Blocked Queue"
        subtitle="Tickets dropped from a Day Plan because the eligible SE's Common Kit is incomplete. Read-only — warehouse stock movement is approved by the Warehouse Manager."
      />

      <MetricStrip
        cols={4}
        metrics={[
          { label: 'Blocked Tickets', value: rows.length, tone: 'brand' },
          { label: 'Warehouse Overdue', value: overdue, tone: overdue ? 'critical' : 'neutral', hint: '> 7 days, no WM action' },
          { label: 'Engineers Affected', value: engineers, tone: 'info' },
          { label: 'Oldest', value: `${oldest}d`, tone: oldest > 7 ? 'warning' : 'neutral' },
        ]}
      />

      <FilterBar>
        <SearchInput
          aria-label="Search blocked tickets"
          placeholder="Search company, zone, engineer…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </FilterBar>

      <DataTable
        ariaLabel="Component-Blocked Queue"
        columns={columns}
        rows={filtered}
        rowKey={(r) => r.id}
        rowTestId={(r) => `cbq-row-${r.ticketId}`}
        onRowClick={(r) => navigate(`/tickets/${r.ticketId}?tab=Components`)}
        loading={loading}
        error={error}
        empty={<EmptyState message="No component-blocked tickets." />}
      />
    </div>
  );
}
