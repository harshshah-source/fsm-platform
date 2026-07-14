import { useCallback, useEffect, useState } from 'react';
import { Outlet, useNavigate } from 'react-router-dom';
import { apiTicketsList, type TicketFilters, type TicketRow } from '../../api/tickets';
import { apiDeviceFilterOptions } from '../../api/devices';
import {
  DataTable,
  EmptyState,
  ExportMenu,
  FilterBar,
  FilterSelect,
  PageHeader,
  SearchInput,
  type Column,
} from '../../components/data';
import { AgeChip, StatusPill, TierBadge } from '../../components/domain';
import { Badge, Button } from '../../components/ui';
import { IconTicket } from '../../components/ui/icons';
import { exportTable, type ExportFormat } from '../../lib/exportFile';
import { formatPlantDisplayName } from '../../lib/plantNames';
import { BUCKET_LABEL_RANGE, SLA_BUCKETS } from '../../lib/slaBucket';
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
  const [companies, setCompanies] = useState<{ companyId: number; name: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Company dropdown source (Issue 122 — replaces the free-text company-ID box). Manager-scoped list
  // of companies present in the caller's fleet; failure just leaves the dropdown empty.
  useEffect(() => {
    apiDeviceFilterOptions()
      .then((o) => setCompanies(o.companies ?? []))
      .catch(() => undefined);
  }, []);

  const load = useCallback(() => {
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

  useEffect(() => load(), [load]);

  const set =
    (key: keyof TicketFilters) => (e: React.ChangeEvent<HTMLSelectElement | HTMLInputElement>) =>
      setFilters((f) => ({ ...f, [key]: e.target.value || undefined }));

  const hasFilters = Object.values(filters).some(Boolean);

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
      key: 'company',
      header: 'Company',
      render: (t) => (
        <div className="min-w-0">
          <div className="text-ink-strong">{t.companyName ?? `Company ${t.companyId}`}</div>
          <div className="text-xs text-ink-muted">#{t.companyId}</div>
        </div>
      ),
    },
    {
      key: 'plant',
      header: 'Plant',
      render: (t) => (
        <div className="min-w-0">
          <div className="text-ink-strong">
            {t.plantName ? formatPlantDisplayName(t.plantName) : `Plant ${t.plantId}`}
          </div>
          <div className="text-xs text-ink-muted">#{t.plantId}</div>
        </div>
      ),
    },
    {
      key: 'vehicle',
      header: 'Vehicle No.',
      render: (t) =>
        t.vehicleNo ? (
          <span className="font-mono text-xs text-ink-strong">{t.vehicleNo}</span>
        ) : (
          <span className="text-ink-muted">—</span>
        ),
    },
    {
      key: 'tier',
      header: 'Tier',
      render: (t) => <TierBadge tier={t.companyTier} />,
    },
    {
      key: 'assignment',
      header: 'Assignment',
      render: (t) => (
        <div className="min-w-0">
          {t.assignmentState === 'FORMALLY_ASSIGNED' ? (
            <>
              <span className="flex items-center gap-1.5">
                <Badge tone="success">Assigned</Badge>
                {t.overridden && <Badge tone="info">Overridden</Badge>}
              </span>
              {t.assignedSeName && <div className="mt-0.5 text-xs text-ink-muted">{t.assignedSeName}</div>}
            </>
          ) : (
            <Badge tone="warning">Unassigned</Badge>
          )}
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (t) => <StatusPill status={t.status} />,
    },
    {
      key: 'bucket',
      header: 'Inactive',
      render: (t) => <BucketBadge bucket={t.slaBucket} latestGpsDatetime={t.latestGpsDatetime} />,
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

  const exportTickets = (format: ExportFormat) => {
    const headers = [
      'Ticket', 'Work Type', 'Company', 'Plant', 'Vehicle No.', 'Tier',
      'Assignment', 'Assigned SE', 'Overridden', 'Status', 'SLA Bucket', 'Age (days)',
    ];
    const body = rows.map((t) => [
      t.ticketId,
      t.workType,
      t.companyName ?? `Company ${t.companyId}`,
      t.plantName ? formatPlantDisplayName(t.plantName) : `Plant ${t.plantId}`,
      t.vehicleNo ?? '',
      t.companyTier,
      t.assignmentState,
      t.assignedSeName ?? '',
      t.overridden ? 'Yes' : 'No',
      t.status,
      t.slaBucket ?? 'ACTIVE',
      ageDays(t.createdAt),
    ]);
    exportTable(format, 'ticket-operations', 'Ticket Operations', headers, body);
  };

  return (
    <div className="flex">
      <div className="min-w-0 flex-1">
        <PageHeader
          title="Ticket Operations"
          subtitle="Every open and recently-closed ticket in your zone, sorted by SLA urgency."
          actions={
            <span className="flex items-center gap-2">
              {hasFilters && (
                <Button variant="ghost" size="sm" onClick={() => setFilters({})}>
                  Clear filters
                </Button>
              )}
              <ExportMenu onExport={exportTickets} disabled={rows.length === 0} label="Download" />
            </span>
          }
        />

        <FilterBar>
          <SearchInput
            aria-label="Search tickets"
            placeholder="Search device, vehicle, plant or company…"
            value={filters.q ?? ''}
            onChange={set('q')}
            className="w-64"
          />
          <FilterSelect aria-label="Work type" value={filters.workType ?? ''} onChange={set('workType')}>
            <option value="">All work types</option>
            {WORK_TYPES.map((w) => (
              <option key={w} value={w}>{w}</option>
            ))}
          </FilterSelect>
          <FilterSelect aria-label="Status" value={filters.status ?? ''} onChange={set('status')}>
            <option value="">All statuses</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </FilterSelect>
          <FilterSelect aria-label="SLA bucket" value={filters.bucket ?? ''} onChange={set('bucket')}>
            <option value="">All buckets</option>
            {SLA_BUCKETS.map((b) => (
              <option key={b} value={b}>{BUCKET_LABEL_RANGE[b]}</option>
            ))}
          </FilterSelect>
          <FilterSelect
            aria-label="Assignment state"
            value={filters.assignmentState ?? ''}
            onChange={set('assignmentState')}
          >
            <option value="">All assignment states</option>
            {ASSIGNMENT_STATES.map((a) => (
              <option key={a} value={a}>{a}</option>
            ))}
          </FilterSelect>
          <FilterSelect aria-label="Company" value={filters.companyId ?? ''} onChange={set('companyId')}>
            <option value="">All companies</option>
            {companies.map((c) => (
              <option key={c.companyId} value={String(c.companyId)}>
                {c.name}
              </option>
            ))}
          </FilterSelect>
          <SearchInput
            aria-label="Plant name or ID"
            placeholder="Plant name or ID"
            value={filters.plant ?? ''}
            onChange={set('plant')}
            className="w-40"
          />
        </FilterBar>

        <DataTable
          ariaLabel="Tickets"
          rowKey={(t) => t.ticketId}
          columns={columns}
          rows={rows}
          loading={loading}
          error={error}
          onRetry={load}
          stickyHeader
          onRowClick={(t) => navigate(`/tickets/${t.ticketId}`)}
          empty={
            <EmptyState
              icon={<IconTicket />}
              message={
                hasFilters
                  ? 'No tickets match these filters.'
                  : 'No open or recently-closed tickets in your zone.'
              }
              action={
                hasFilters ? (
                  <Button variant="secondary" size="sm" onClick={() => setFilters({})}>
                    Clear filters
                  </Button>
                ) : undefined
              }
            />
          }
        />
      </div>
      {/* Detail Drawer renders here (nested route /tickets/:ticketId) over the list. */}
      <Outlet />
    </div>
  );
}
