import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  apiConfirmVuDate,
  apiResumeVuSla,
  apiVehicleUnavailability,
  type VehicleUnavailReason,
  type VehicleUnavailRow,
} from '../../api/vehicleUnavailability';
import {
  DataTable,
  DateRangeChips,
  MetricCard,
  PageHeader,
  type Column,
} from '../../components/data';
import { StatusPill } from '../../components/domain';
import { Button, Field, Input } from '../../components/ui';

/**
 * ZM Vehicle Unavailability Review (Issue 28 · FE-14 parity, `/readiness/vehicle-unavailability`,
 * reference 11). Lists OPEN reports newest-first with a metric strip and a table carrying BOTH SLA
 * clocks — the **secondary** (true-elapsed, never-pausing) clock is manager-only by living on this
 * manager-gated surface, never the SE. Per-row ZM legs: Confirm date (edit/confirm the
 * expected-availability window) and Resume SLA (manually resume the primary SLA, resolving the report).
 *
 * FE-14 is a presentation-only refactor onto `PageHeader` + `MetricCard` + `DataTable` with dual-clock
 * cells + `StatusPill`; the `vu-metric-*` / `vu-row-*` / `vu-primary-*` / `vu-secondary-*` test ids, the
 * `Vehicle Unavailability Reports` aria-label, the Confirm-date / Resume-SLA actions, and the ticket
 * navigation are preserved. `EXPECTED_BACK` is omitted (removed — documented deviation, §9.2).
 */
const REASON_LABELS: Record<VehicleUnavailReason, string> = {
  VEHICLE_ON_TRIP: 'Vehicle on trip',
  VEHICLE_NOT_AT_PLANT: 'Vehicle not at plant',
  DRIVER_NOT_AVAILABLE: 'Driver not available',
  CUSTOMER_REFUSED: 'Customer refused',
  OTHER: 'Other',
};

/** Humanise an elapsed-seconds clock as "Hh Mm" (the SLA-clock display in ref 11). */
function fmtDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

function fmtDate(iso: string): string {
  return iso.slice(0, 10);
}

export function VehicleUnavailabilityPage() {
  const navigate = useNavigate();
  const [rows, setRows] = useState<VehicleUnavailRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [dateInput, setDateInput] = useState('');

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

  const pausedCount = rows.filter((r) => r.slaPaused).length;
  const contactedCount = rows.filter((r) => r.transporterContacted).length;

  const saveDate = async (id: string) => {
    if (!dateInput.trim()) return;
    const iso = new Date(dateInput).toISOString();
    await apiConfirmVuDate(id, iso);
    setEditingId(null);
    setDateInput('');
    load();
  };
  const resume = async (id: string) => {
    await apiResumeVuSla(id);
    load();
  };

  const columns: Column<VehicleUnavailRow>[] = [
    {
      key: 'report',
      header: 'Report',
      render: (row) => <span className="font-mono text-xs text-ink-muted">{row.id.slice(0, 8)}</span>,
    },
    {
      key: 'ticket',
      header: 'Ticket',
      render: (row) => (
        <button
          type="button"
          onClick={() => navigate(`/tickets/${row.ticketId}`)}
          className="font-mono text-xs text-brand-700 hover:underline"
        >
          {row.ticketId.slice(0, 8)}
        </button>
      ),
    },
    { key: 'plant', header: 'Vehicle & Plant', render: (row) => <span className="text-ink-strong">{row.plantName}</span> },
    {
      key: 'reason',
      header: 'Reason',
      render: (row) => (
        <span className="text-ink">
          {REASON_LABELS[row.reasonCode]}
          {row.transporterContacted && (
            <span className="ml-1 text-xs text-ink-muted">· transporter contacted</span>
          )}
        </span>
      ),
    },
    { key: 'filedby', header: 'Filed by', render: (row) => <span className="font-mono text-xs text-ink">{row.seId.slice(0, 8)}</span> },
    { key: 'expected', header: 'Expected date', render: (row) => <span className="text-ink-muted">{fmtDate(row.expectedFrom)}</span> },
    {
      key: 'primary',
      header: 'Primary SLA',
      render: (row) => (
        <span data-testid={`vu-primary-${row.id}`} className="font-medium text-warning">
          {fmtDuration(row.primarySlaSeconds)}
          {row.slaPaused && <span className="ml-1 text-xs text-warning/70">(paused)</span>}
        </span>
      ),
    },
    {
      key: 'secondary',
      header: 'Secondary SLA',
      render: (row) => (
        <span data-testid={`vu-secondary-${row.id}`} className="font-medium text-critical">
          {fmtDuration(row.secondarySlaSeconds)}
        </span>
      ),
    },
    { key: 'status', header: 'Status', render: (row) => <StatusPill status={row.status} /> },
    {
      key: 'actions',
      header: 'Actions',
      render: (row) =>
        editingId !== row.id ? (
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={() => {
                setEditingId(row.id);
                setDateInput('');
              }}
            >
              Confirm date
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => resume(row.id)}>
              Resume SLA
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
            <div className="flex gap-2">
              <Button type="button" size="sm" onClick={() => saveDate(row.id)}>
                Save date
              </Button>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={() => {
                  setEditingId(null);
                  setDateInput('');
                }}
              >
                Cancel
              </Button>
            </div>
          </div>
        ),
    },
  ];

  return (
    <div>
      <PageHeader
        title="Vehicle Unavailability Reports"
        subtitle="Open reports where an SE could not work the vehicle. The primary SLA is paused while the vehicle is unavailable; the secondary clock keeps counting true elapsed time. Confirm the expected-availability date, or manually resume the SLA once the vehicle is back."
        actions={<DateRangeChips />}
      />

      {error && (
        <p role="alert" className="mb-4 text-sm text-critical">
          {error}
        </p>
      )}

      <div data-testid="vu-metric-strip" className="mb-5 grid grid-cols-3 gap-3">
        <div data-testid="vu-metric-open">
          <MetricCard label="Open reports" value={rows.length} tone="info" />
        </div>
        <div data-testid="vu-metric-paused">
          <MetricCard label="SLA paused" value={pausedCount} tone="warning" />
        </div>
        <div data-testid="vu-metric-contacted">
          <MetricCard label="Transporter contacted" value={contactedCount} tone="neutral" />
        </div>
      </div>

      <DataTable
        ariaLabel="Vehicle Unavailability Reports"
        rowKey={(r) => r.id}
        rowTestId={(r) => `vu-row-${r.id}`}
        rowAccent={(r) => (r.slaPaused ? 'border-l-warning' : undefined)}
        columns={columns}
        rows={rows}
        loading={loading}
        empty="No open vehicle-unavailability reports."
      />
    </div>
  );
}
