import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  apiApproveVuDate,
  apiOverrideVuDate,
  apiResumeVuSla,
  apiVehicleUnavailability,
  apiVuHistory,
  type VehicleUnavailReason,
  type VehicleUnavailRow,
} from '../../api/vehicleUnavailability';
import {
  DataTable,
  FilterSelect,
  MetricCard,
  PageHeader,
  SearchInput,
  type Column,
} from '../../components/data';
import { PlantName, StatusPill } from '../../components/domain';
import { Button, Card, Field, Input } from '../../components/ui';

/**
 * ZM Vehicle Unavailability Review (Issue 28 · #245, `/readiness/vehicle-unavailability`,
 * reference 11). The queue of vehicles an SE could not work — and, since #245, the surface where the
 * return date is *decided* rather than quietly edited.
 *
 * Two things reference 11 already anticipated and #245 fills in. Its STATUS column shows `CONFIRMED`
 * alongside `OPEN` and `RESUMED`: that is the decision state, so the decision lives in the existing
 * column (with who and when on its second line) rather than in a column the reference does not have.
 * And `EXPECTED BACK` is a two-line cell like the rest of the table: the authoritative date on top,
 * the SE's original proposal beneath it whenever a manager moved it — because the whole point of
 * keeping `proposedFrom` immutable is that someone can see the disagreement.
 *
 * Actions are per-row and server-scoped (ZM own-zone; CSM / OH global). **Approve** takes the SE's
 * date as authoritative; **Override** replaces it and requires a reason; **Resume SLA** ends the
 * absence; **History** loads the ticket's supersession chain — every report it has ever carried,
 * which is where superseded rows live (they are history for one ticket, not queue work, so the queue
 * itself never lists them).
 *
 * Preserved from FE-14: the `vu-metric-*` / `vu-row-*` / `vu-primary-*` / `vu-secondary-*` test ids
 * and the `Vehicle Unavailability Reports` aria-label. The secondary (true-elapsed, never-pausing)
 * clock keeps its manager-only home here as the second line of the PRIMARY SLA cell — reference 11
 * has one SLA column and the dual clock is an Issue-28 requirement, so it rides in that column's
 * second line rather than being dropped or given a column the reference does not show.
 */
const REASON_LABELS: Record<VehicleUnavailReason, string> = {
  VEHICLE_ON_TRIP: 'Vehicle on trip',
  VEHICLE_NOT_AT_PLANT: 'Not at plant',
  DRIVER_NOT_AVAILABLE: 'Driver not available',
  CUSTOMER_REFUSED: 'Customer refused',
  OTHER: 'Other',
};

/** What the STATUS column shows — reference 11's vocabulary, derived from row state + decision. */
function displayStatus(row: VehicleUnavailRow): string {
  if (row.status === 'RESOLVED') return 'RESUMED';
  if (row.status === 'SUPERSEDED') return 'SUPERSEDED';
  return row.decision ? 'CONFIRMED' : 'OPEN';
}

/** Humanise an elapsed-seconds clock as "Hh Mm" (the SLA-clock display in ref 11). */
function fmtDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

function fmtDate(iso: string): string {
  return iso.slice(0, 10);
}

const STATUS_FILTERS = ['All statuses', 'OPEN', 'CONFIRMED', 'RESUMED'] as const;

export function VehicleUnavailabilityPage() {
  const navigate = useNavigate();
  const [rows, setRows] = useState<VehicleUnavailRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('All statuses');
  const [overridingId, setOverridingId] = useState<string | null>(null);
  const [dateInput, setDateInput] = useState('');
  const [reasonInput, setReasonInput] = useState('');
  const [historyId, setHistoryId] = useState<string | null>(null);
  const [historyRows, setHistoryRows] = useState<VehicleUnavailRow[]>([]);

  const load = useCallback(() => {
    setLoading(true);
    apiVehicleUnavailability()
      .then(setRows)
      .catch(() => setError('Failed to load Vehicle Unavailability Reports'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const openRows = rows.filter((r) => r.status === 'OPEN');
  const pausedCount = rows.filter((r) => r.slaPaused).length;
  const onTripCount = openRows.filter((r) => r.reasonCode === 'VEHICLE_ON_TRIP').length;
  const resumedCount = rows.filter((r) => r.status === 'RESOLVED').length;

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      if (statusFilter !== 'All statuses' && displayStatus(r) !== statusFilter) return false;
      if (!q) return true;
      return [r.id, r.ticketId, r.plantName, r.seId, REASON_LABELS[r.reasonCode]]
        .join(' ')
        .toLowerCase()
        .includes(q);
    });
  }, [rows, query, statusFilter]);

  const closeOverride = () => {
    setOverridingId(null);
    setDateInput('');
    setReasonInput('');
  };

  const approve = async (id: string) => {
    await apiApproveVuDate(id);
    load();
  };
  const saveOverride = async (id: string) => {
    // Both halves are required: a date with no reason is exactly the unaudited edit #245 removed.
    if (!dateInput.trim() || !reasonInput.trim()) return;
    await apiOverrideVuDate(id, new Date(dateInput).toISOString(), reasonInput.trim());
    closeOverride();
    load();
  };
  const resume = async (id: string) => {
    await apiResumeVuSla(id);
    load();
  };
  const showHistory = async (id: string) => {
    setHistoryId(id);
    setHistoryRows(await apiVuHistory(id));
  };

  const columns: Column<VehicleUnavailRow>[] = [
    {
      key: 'report',
      header: 'Report / Ticket',
      render: (row) => (
        <div className="leading-tight">
          <div className="font-mono text-xs text-ink-strong">VUR-{row.id}</div>
          <button
            type="button"
            onClick={() => navigate(`/tickets/${row.ticketId}`)}
            className="font-mono text-[11px] text-link hover:underline"
          >
            {row.ticketId.slice(0, 8)}
          </button>
        </div>
      ),
    },
    {
      key: 'plant',
      header: 'Vehicle / Plant',
      render: (row) => (
        <div className="leading-tight">
          <PlantName code={row.plantName} className="text-ink-strong" />
          {row.transporterContacted && <div className="text-[11px] text-ink-muted">transporter contacted</div>}
        </div>
      ),
    },
    { key: 'reason', header: 'Reason', render: (row) => <span className="text-ink">{REASON_LABELS[row.reasonCode]}</span> },
    {
      key: 'filedby',
      header: 'Filed by',
      render: (row) => <span className="font-mono text-xs text-ink">{row.seId.slice(0, 8)}</span>,
    },
    {
      key: 'expected',
      header: 'Expected back',
      render: (row) => (
        <div data-testid={`vu-expected-${row.id}`} className="leading-tight">
          <div className="text-ink-strong">{fmtDate(row.expectedFrom)}</div>
          <div className="text-[11px] text-ink-muted">
            {row.proposedFrom !== row.expectedFrom ? `SE proposed ${fmtDate(row.proposedFrom)}` : 'as proposed by SE'}
          </div>
        </div>
      ),
    },
    {
      key: 'primary',
      header: 'Primary SLA',
      render: (row) => (
        <div className="leading-tight">
          <div data-testid={`vu-primary-${row.id}`} className="font-medium text-warning">
            {fmtDuration(row.primarySlaSeconds)}
            {row.slaPaused && <span className="ml-1 text-xs text-warning/70">(paused)</span>}
          </div>
          <div data-testid={`vu-secondary-${row.id}`} className="text-[11px] text-critical">
            {fmtDuration(row.secondarySlaSeconds)} true
          </div>
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (row) => (
        <div data-testid={`vu-status-${row.id}`} className="leading-tight">
          <StatusPill status={displayStatus(row)} />
          {row.decision && (
            <div className="mt-1 text-[11px] text-ink-muted">
              {row.decision === 'APPROVED' ? 'Approved' : 'Overridden'} by {row.decidedByRole ?? 'a manager'}
              {row.decidedAt ? ` · ${fmtDate(row.decidedAt)}` : ''}
            </div>
          )}
        </div>
      ),
    },
    {
      key: 'actions',
      header: 'Actions',
      exportable: false,
      render: (row) => {
        if (row.status !== 'OPEN') {
          return (
            <Button type="button" size="sm" variant="ghost" onClick={() => showHistory(row.id)}>
              History
            </Button>
          );
        }
        return overridingId !== row.id ? (
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" onClick={() => approve(row.id)}>
              Approve
            </Button>
            <Button type="button" size="sm" variant="secondary" onClick={() => setOverridingId(row.id)}>
              Override
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => resume(row.id)}>
              Resume SLA
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => showHistory(row.id)}>
              History
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-1">
            <Field label="Expected date" htmlFor={`date-${row.id}`}>
              <Input
                id={`date-${row.id}`}
                type="datetime-local"
                value={dateInput}
                onChange={(e) => setDateInput(e.target.value)}
                className="text-xs"
              />
            </Field>
            <Field label="Override reason" htmlFor={`reason-${row.id}`}>
              <Input
                id={`reason-${row.id}`}
                value={reasonInput}
                onChange={(e) => setReasonInput(e.target.value)}
                placeholder="Why the SE's date is being replaced"
                className="text-xs"
              />
            </Field>
            <div className="flex gap-2">
              <Button type="button" size="sm" onClick={() => saveOverride(row.id)}>
                Save override
              </Button>
              <Button type="button" size="sm" variant="secondary" onClick={closeOverride}>
                Cancel
              </Button>
            </div>
          </div>
        );
      },
    },
  ];

  return (
    <div>
      <PageHeader
        title="Vehicle Unavailability Reports"
        subtitle="SE-filed reports when a vehicle is not at plant — the sanctioned path that pauses the primary SLA clock. Approve the SE's expected-availability date, override it with a reason, or resume the SLA once the vehicle is back."
      />

      {error && (
        <p role="alert" className="mb-4 text-sm text-critical">
          {error}
        </p>
      )}

      <div data-testid="vu-metric-strip" className="mb-5 grid grid-cols-4 gap-3">
        <div data-testid="vu-metric-open">
          <MetricCard label="Open reports" value={openRows.length} hint="Awaiting window confirmation" tone="info" />
        </div>
        <div data-testid="vu-metric-paused">
          <MetricCard label="SLA paused" value={pausedCount} hint="Primary clock paused (secondary runs)" tone="warning" />
        </div>
        <div data-testid="vu-metric-ontrip">
          <MetricCard label="Vehicle on-trip" value={onTripCount} hint="Dispatched on an active LR" tone="critical" />
        </div>
        <div data-testid="vu-metric-resumed">
          <MetricCard label="Resumed" value={resumedCount} hint="SLA resumed by manager" tone="success" />
        </div>
      </div>

      <DataTable
        ariaLabel="Vehicle Unavailability Reports"
        rowKey={(r) => r.id}
        rowTestId={(r) => `vu-row-${r.id}`}
        rowAccent={(r) => (r.slaPaused ? 'border-l-warning' : undefined)}
        columns={columns}
        rows={visible}
        loading={loading}
        empty="No vehicle-unavailability reports."
        toolbar={
          <>
            <SearchInput
              aria-label="Search reports"
              placeholder="Search report, ticket, vehicle, SE…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="w-72"
            />
            <FilterSelect aria-label="Status" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
              {STATUS_FILTERS.map((s) => (
                <option key={s} value={s}>
                  {s === 'All statuses' ? s : s.charAt(0) + s.slice(1).toLowerCase()}
                </option>
              ))}
            </FilterSelect>
            <span data-testid="vu-result-count" className="text-[11px] text-ink-muted">
              {visible.length} / {rows.length} results
            </span>
          </>
        }
      />

      {historyId && (
        <Card className="mt-4 p-4">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-[11px] font-semibold uppercase tracking-wider text-ink-caps">
              Report history for this ticket
            </h2>
            <Button type="button" size="sm" variant="ghost" onClick={() => setHistoryId(null)}>
              Close
            </Button>
          </div>
          <ul data-testid={`vu-history-${historyId}`} className="space-y-1 text-[13px]">
            {historyRows.map((h) => (
              <li key={h.id} className="text-ink">
                <span className="font-mono text-xs text-ink-strong">VUR-{h.id}</span> · {displayStatus(h)} · filed{' '}
                {fmtDate(h.createdAt)} · proposed {fmtDate(h.proposedFrom)} · authoritative {fmtDate(h.expectedFrom)}
                {h.overrideReason ? ` · ${h.overrideReason}` : ''}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
