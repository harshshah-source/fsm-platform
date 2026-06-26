import { useEffect, useState } from 'react';
import { Outlet, useNavigate } from 'react-router-dom';
import { apiTicketsList, type TicketFilters, type TicketRow } from '../../api/tickets';
import {
  DataTable,
  FilterBar,
  FilterSelect,
  PageHeader,
  SearchInput,
  type Column,
} from '../../components/data';
import { AgeChip, StatusPill, TierBadge } from '../../components/domain';
import { BUCKET_LABEL, SLA_BUCKETS } from '../../lib/slaBucket';
import { BucketBadge, InlineBadges } from './ticketBadges';

const WORK_TYPES = ['TROUBLESHOOT', 'INSTALL', 'RECOVERY'];
const STATUSES = [
  'OPEN', 'SUBMITTED', 'VERIFICATION_PENDING', 'CLOSED', 'CLOSED_AUTO_RECOVERY',
  'FAILED_VERIFICATION', 'ESCALATED', 'CLOSED_NON_OPERATIONAL',
];
const ASSIGNMENT_STATES = ['UNASSIGNED', 'FORMALLY_ASSIGNED'];

/** Whole-day age from an ISO timestamp (never negative). */
function ageDays(iso: string): number {
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000));
}

/**
 * Ticket List (Issue 07 · FE-08 parity, reference 07). Filterable by work type, status, company, plant,
 * SLA bucket, and assignment state; the server returns rows already sorted SLA-bucket-descending and
 * zone-scoped. A row click opens the Detail Drawer (`/tickets/:ticketId`) inline via the nested Outlet.
 *
 * FE-08 is a presentation-only refactor onto `PageHeader` + `FilterBar` + the canonical `DataTable`;
 * the fetch logic, query params, the `Tickets` table `aria-label`, the filter `aria-label`s, the
 * `bucket-*` / `badge-*` test ids, and the row-click navigation are all preserved.
 */
export function TicketsPage() {
  const navigate = useNavigate();
  const [filters, setFilters] = useState<TicketFilters>({});
  const [rows, setRows] = useState<TicketRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    apiTicketsList(filters)
      .then((r) => {
        if (!alive) return;
        setRows(r);
        setError(null);
      })
      .catch(() => alive && setError('Failed to load tickets'))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [filters]);

  const set =
    (key: keyof TicketFilters) => (e: React.ChangeEvent<HTMLSelectElement | HTMLInputElement>) =>
      setFilters((f) => ({ ...f, [key]: e.target.value || undefined }));

  const columns: Column<TicketRow>[] = [
    {
      key: 'ticket',
      header: 'Ticket',
      render: (t) => (
        <div className="min-w-0">
          <div className="font-mono text-xs text-ink-muted">#{t.ticketId.slice(0, 8)}</div>
          <div className="font-medium text-ink-strong">Device {t.deviceId}</div>
        </div>
      ),
    },
    {
      key: 'workType',
      header: 'Work Type',
      render: (t) => <span className="text-ink">{t.workType}</span>,
    },
    {
      key: 'plant',
      header: 'Plant / Company',
      render: (t) => (
        <div className="min-w-0">
          <div className="text-ink-strong">Plant {t.plantId}</div>
          <div className="text-xs text-ink-muted">Co {t.companyId}</div>
        </div>
      ),
    },
    {
      key: 'tier',
      header: 'Tier',
      render: (t) => <TierBadge tier={t.companyTier} />,
    },
    {
      key: 'status',
      header: 'Status',
      render: (t) => <StatusPill status={t.status} />,
    },
    {
      key: 'bucket',
      header: 'SLA',
      render: (t) => <BucketBadge bucket={t.slaBucket} />,
    },
    {
      key: 'age',
      header: 'Age',
      align: 'right',
      render: (t) => <AgeChip days={ageDays(t.createdAt)} />,
    },
    {
      key: 'flags',
      header: 'Flags',
      render: (t) => <InlineBadges ticket={t} />,
    },
  ];

  return (
    <div className="flex">
      <div className="min-w-0 flex-1">
        <PageHeader
          title="Ticket Operations"
          subtitle="Every open and recently-closed ticket in your zone, sorted by SLA urgency."
        />
        {error && (
          <p role="alert" className="mb-2 text-sm text-critical">
            {error}
          </p>
        )}

        <FilterBar>
          <FilterSelect aria-label="Work type" onChange={set('workType')}>
            <option value="">All work types</option>
            {WORK_TYPES.map((w) => (
              <option key={w} value={w}>{w}</option>
            ))}
          </FilterSelect>
          <FilterSelect aria-label="Status" onChange={set('status')}>
            <option value="">All statuses</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </FilterSelect>
          <FilterSelect aria-label="SLA bucket" onChange={set('bucket')}>
            <option value="">All buckets</option>
            {SLA_BUCKETS.map((b) => (
              <option key={b} value={b}>{BUCKET_LABEL[b]}</option>
            ))}
          </FilterSelect>
          <FilterSelect aria-label="Assignment state" onChange={set('assignmentState')}>
            <option value="">All assignment states</option>
            {ASSIGNMENT_STATES.map((a) => (
              <option key={a} value={a}>{a}</option>
            ))}
          </FilterSelect>
          <SearchInput
            aria-label="Company ID"
            placeholder="Company ID"
            onChange={set('companyId')}
            className="w-36"
          />
          <SearchInput
            aria-label="Plant ID"
            placeholder="Plant ID"
            onChange={set('plantId')}
            className="w-32"
          />
        </FilterBar>

        <DataTable
          ariaLabel="Tickets"
          rowKey={(t) => t.ticketId}
          columns={columns}
          rows={rows}
          loading={loading}
          onRowClick={(t) => navigate(`/tickets/${t.ticketId}`)}
          empty="No tickets match these filters."
        />
      </div>
      {/* Detail Drawer renders here (nested route /tickets/:ticketId) over the list. */}
      <Outlet />
    </div>
  );
}
