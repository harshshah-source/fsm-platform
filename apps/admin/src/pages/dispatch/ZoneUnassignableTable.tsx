import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { DispatchUnassignableRow } from '../../api/dispatch-runs';
import { DataTable, EmptyState, FilterSelect, SearchInput, type Column } from '../../components/data';
import { Badge } from '../../components/ui';
import { POOL_EMPTY_LABEL } from './format';

type ReasonFilter = '' | 'NO_COVERAGE' | 'ALL_DROPPED';
type SortOrder = '' | 'COMPANY' | 'PLANT';

/**
 * The zone's unassignable tickets (change-request 2026-07) with the reason their candidate pool ended
 * up empty. A search (company / plant / device), a NO_COVERAGE-vs-ALL_DROPPED reason filter, and a
 * company/plant sort scope the list — the same shape as the companies-and-plants overview above it.
 */
export function ZoneUnassignableTable({ rows }: { rows: DispatchUnassignableRow[] }) {
  const [search, setSearch] = useState('');
  const [reason, setReason] = useState<ReasonFilter>('');
  const [sortOrder, setSortOrder] = useState<SortOrder>('');

  const term = search.trim().toLowerCase();

  const filtered = useMemo(() => {
    const matches = rows.filter((u) => {
      if (reason && u.poolEmptyReason !== reason) return false;
      if (!term) return true;
      return [u.companyName, u.plantName, u.deviceId].some((v) => v?.toLowerCase().includes(term));
    });
    if (!sortOrder) return matches;
    const key = (u: DispatchUnassignableRow) => (sortOrder === 'COMPANY' ? u.companyName : u.plantName) ?? '';
    return [...matches].sort((a, b) => key(a).localeCompare(key(b)));
  }, [rows, term, reason, sortOrder]);

  const columns: Column<DispatchUnassignableRow>[] = [
    {
      // #281 AC7 — an unassignable ticket is the row an operator most needs to open, and
      // `/tickets/:ticketId` is live. It was the one identifier on this drill-down left inert.
      key: 'device',
      header: 'Device',
      render: (u) => (
        <Link
          to={`/tickets/${u.ticketId}`}
          onClick={(e) => e.stopPropagation()}
          aria-label={`Open ticket ${u.deviceId ?? u.ticketId}`}
          className="text-link hover:underline"
        >
          {u.deviceId ?? <span className="font-mono text-xs">{u.ticketId.slice(0, 8)}</span>}
        </Link>
      ),
      exportValue: (u) => u.deviceId ?? u.ticketId,
    },
    {
      key: 'plant',
      header: 'Plant',
      render: (u) => (
        <div>
          <div>{u.plantName ?? '—'}</div>
          {u.companyName && <div className="text-xs text-ink-muted">{u.companyName}</div>}
        </div>
      ),
    },
    {
      key: 'reason',
      header: 'Why unassignable',
      render: (u) => (
        <Badge tone={u.poolEmptyReason === 'NO_COVERAGE' ? 'critical' : 'warning'}>
          {u.poolEmptyReason ? POOL_EMPTY_LABEL[u.poolEmptyReason] : 'Unknown'}
        </Badge>
      ),
    },
    {
      key: 'drops',
      header: 'Dropped candidates',
      render: (u) => {
        const entries = Object.entries(u.dropCounts ?? {});
        return entries.length === 0 ? (
          <span className="text-ink-muted">—</span>
        ) : (
          <span className="text-xs text-ink-muted">{entries.map(([r, n]) => `${r} ×${n}`).join(' · ')}</span>
        );
      },
    },
  ];

  return (
    <div className="mt-6">
      <DataTable
        columns={columns}
        rows={filtered}
        rowKey={(u) => u.ticketId}
        rowTestId={(u) => `dispatch-unassignable-row-${u.ticketId}`}
        ariaLabel="Unassignable tickets"
        toolbarTitle={`Unassignable (${rows.length})`}
        toolbar={
          <>
            <SearchInput
              aria-label="Search unassignable by company, plant or device"
              placeholder="Company, plant, device…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-56"
            />
            <FilterSelect aria-label="Filter by reason" value={reason} onChange={(e) => setReason(e.target.value as ReasonFilter)}>
              <option value="">All reasons</option>
              <option value="NO_COVERAGE">No coverage</option>
              <option value="ALL_DROPPED">All candidates dropped</option>
            </FilterSelect>
            <FilterSelect aria-label="Sort unassignable" value={sortOrder} onChange={(e) => setSortOrder(e.target.value as SortOrder)}>
              <option value="">Sort: default</option>
              <option value="COMPANY">Company A–Z</option>
              <option value="PLANT">Plant A–Z</option>
            </FilterSelect>
          </>
        }
        empty={<EmptyState message="No unassignable tickets match this filter." />}
      />
    </div>
  );
}
