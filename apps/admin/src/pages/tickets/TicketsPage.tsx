import { useCallback, useEffect, useMemo, useState } from 'react';
import { Outlet, useMatch, useNavigate } from 'react-router-dom';
import { apiSpecialTicketCount, apiTicketsList, type TicketFilters, type TicketRow } from '../../api/tickets';
import { getAssignmentThreshold } from '../../api/assignmentThreshold';
import { apiDeviceFilterOptions, type DeviceFilterOptions } from '../../api/devices';
import {
  DataTable,
  EmptyState,
  FilterSelect,
  PageHeader,
  SearchInput,
  type Column,
} from '../../components/data';
import { AgeChip, StatusPill, TierBadge } from '../../components/domain';
import { Badge, Button } from '../../components/ui';
import { IconTicket } from '../../components/ui/icons';
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
 * FE-08 is a presentation-only refactor onto the canonical `DataTable` (the filters ride in its
 * `toolbar`, inside the table card); the fetch logic, query params, the `Tickets` table `aria-label`,
 * the filter `aria-label`s, the `bucket-*` / `badge-*` test ids, and the row-click navigation are all
 * preserved.
 */
export function TicketsPage() {
  const navigate = useNavigate();
  // The ticket whose Detail Drawer is open (row click or a deep link from Device Detail). Its list
  // row is highlighted + scrolled into view so the drawer and the table stay visibly connected.
  const activeTicketId = useMatch('/tickets/:ticketId')?.params.ticketId ?? null;
  const [filters, setFilters] = useState<TicketFilters>({});
  const [rows, setRows] = useState<TicketRow[]>([]);
  const [options, setOptions] = useState<DeviceFilterOptions>({
    zones: [],
    companies: [],
    plants: [],
    hasUnzoned: false,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // #238 — the live SE-assignment threshold, used only to badge tickets auto-dispatch is holding back.
  // Null on any failure and the badge simply does not render: this is a decoration on someone else's
  // page, and it must never be the reason the ticket queue fails to load.
  const [assignmentThresholdHours, setAssignmentThresholdHours] = useState<number | null>(null);
  // #244 — how many Special tickets the caller has, from the server. Never counted from `rows`: the
  // list is a page, and a page count on a filter chip would understate the queue the moment it
  // paginates. Null on any failure and the chip renders without a number rather than with a wrong one.
  const [specialCount, setSpecialCount] = useState<number | null>(null);

  useEffect(() => {
    let live = true;
    getAssignmentThreshold()
      .then((t) => live && setAssignmentThresholdHours(t.hours))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  // Re-read whenever the filters change: a Special verdict is derived, so the figure moves when the
  // threshold moves or an SE finally submits — a count fetched once at mount would go stale on screen.
  useEffect(() => {
    let live = true;
    apiSpecialTicketCount()
      .then((s) => live && setSpecialCount(s.count))
      .catch(() => live && setSpecialCount(null));
    return () => {
      live = false;
    };
  }, [filters]);

  // Company + plant dropdown source (Issue 122 — replaces the free-text company-ID box). Manager-scoped
  // list of companies/plants present in the caller's fleet; failure just leaves the dropdowns empty.
  useEffect(() => {
    apiDeviceFilterOptions()
      .then(setOptions)
      .catch(() => undefined);
  }, []);

  // The plant dropdown follows the company pick — only that company's plants list, de-duplicated when
  // unscoped (a plant serving several companies appears once per company in `options.plants`).
  const dedupedPlants = useMemo(() => {
    const all = options.plants ?? [];
    const scoped = filters.companyId ? all.filter((p) => String(p.companyId) === filters.companyId) : all;
    const seen = new Set<number>();
    return scoped.filter((p) => (seen.has(p.plantId) ? false : (seen.add(p.plantId), true)));
  }, [options.plants, filters.companyId]);

  // Drop a selected plant that no longer belongs to the picked company. Skips until options load, so a
  // deep-linked plant isn't cleared by the empty first render.
  useEffect(() => {
    if (!filters.plantId || !filters.companyId || (options.plants ?? []).length === 0) return;
    const stillValid = (options.plants ?? []).some(
      (p) => String(p.plantId) === filters.plantId && String(p.companyId) === filters.companyId,
    );
    if (!stillValid) setFilters((f) => ({ ...f, plantId: undefined }));
  }, [filters.companyId, filters.plantId, options.plants]);

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
      render: (t) => <InlineBadges ticket={t} assignmentThresholdHours={assignmentThresholdHours} />,
    },
  ];

  return (
    <div className="flex">
      <div className="min-w-0 flex-1">
        <PageHeader
          title="Ticket Operations"
          subtitle="Every open and recently-closed ticket in your zone, sorted by SLA urgency."
          actions={
            hasFilters ? (
              <Button variant="ghost" size="sm" onClick={() => setFilters({})}>
                Clear filters
              </Button>
            ) : undefined
          }
        />

        <DataTable
          ariaLabel="Tickets"
          toolbar={
            <>
              <SearchInput
                aria-label="Search tickets"
                placeholder="Search device, vehicle, plant or company…"
                value={filters.q ?? ''}
                onChange={set('q')}
                className="w-64"
              />
              {/* #244 — a toggle, not a dropdown: Special is a single property a manager either wants
                  narrowed to or does not, and the count is what makes it worth clicking. Server-side,
                  like every other filter here — the badge and the filter share one definition. */}
              <Button
                variant={filters.special === 'true' ? 'primary' : 'secondary'}
                size="sm"
                data-testid="special-filter"
                aria-pressed={filters.special === 'true'}
                onClick={() =>
                  setFilters((f) => ({ ...f, special: f.special === 'true' ? undefined : 'true' }))
                }
              >
                Special
                {specialCount !== null && (
                  <span data-testid="special-count" className="ml-1 font-semibold">
                    {specialCount}
                  </span>
                )}
              </Button>
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
                {(options.companies ?? []).map((c) => (
                  <option key={c.companyId} value={String(c.companyId)}>
                    {c.name}
                  </option>
                ))}
              </FilterSelect>
              <FilterSelect aria-label="Plant" value={filters.plantId ?? ''} onChange={set('plantId')}>
                <option value="">All plants</option>
                {dedupedPlants.map((p) => (
                  <option key={p.plantId} value={String(p.plantId)}>
                    {formatPlantDisplayName(p.name)}
                  </option>
                ))}
              </FilterSelect>
            </>
          }
          rowKey={(t) => t.ticketId}
          columns={columns}
          rows={rows}
          loading={loading}
          error={error}
          onRetry={load}
          stickyHeader
          onRowClick={(t) => navigate(`/tickets/${t.ticketId}`)}
          rowActive={activeTicketId ? (t) => t.ticketId === activeTicketId : undefined}
          activeVariant="danger"
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
