import { useEffect, useState } from 'react';
import { useAuth } from '../../auth/AuthProvider';
import {
  apiConfirmNonOp,
  apiGetDeviceDealType,
  apiNonOpQueue,
  apiOverrideConfirmNonOp,
  apiRequestNonOp,
  RECOVERY_REASONS,
  type NonOpQueueRow,
  type NonOpReason,
  type NonOpState,
} from '../../api/nonOp';
import { DataTable, MetricCard, PageHeader, FilterSelect, type Column } from '../../components/data';
import { Badge, Button, Field, Input } from '../../components/ui';
import type { BadgeTone } from '../../components/ui/Badge';

/**
 * Non-Operational dual-confirmation queue (Issue 35 · FE-16 recipe, `/readiness/non-operational`).
 * Manager roles see markings awaiting confirmation sorted by `awaiting_since` asc (server-ordered) with a
 * state badge + a days-elapsed badge, perform the manager confirmation leg, and (Operations Head)
 * override-confirm after 7 days. The Mark-Non-Operational dual-confirmation modal warns — with an
 * explicit acknowledgement — that a RECURRING device with a physical-retrieval reason auto-creates a
 * Recovery Ticket on confirmation.
 *
 * FE-16 applies the canonical queue recipe + re-skins the Mark dual-confirmation modal onto the tokens.
 * The `Non-Operational dual confirmation` aria-label, the `nonop-row-*` / `nonop-confirm-*` /
 * `nonop-override-*` test ids, the Mark-modal labels (Device ID / Reason / acknowledge / submit), and the
 * action behaviour are preserved. The override `window.prompt` leg is scheduled for a `Modal` (#72).
 */
const STATE_LABEL: Record<NonOpState, string> = {
  AWAITING_ZM_CONFIRMATION: 'Awaiting Manager',
  AWAITING_CUSTOMER_CONFIRMATION: 'Awaiting Customer',
  CONFIRMED: 'Confirmed',
};
const STATE_TONE: Record<NonOpState, BadgeTone> = {
  AWAITING_ZM_CONFIRMATION: 'warning',
  AWAITING_CUSTOMER_CONFIRMATION: 'info',
  CONFIRMED: 'success',
};

const REASONS: NonOpReason[] = [
  'VEHICLE_SCRAPPED',
  'VEHICLE_SOLD',
  'VEHICLE_ACCIDENT',
  'COMPANY_PAUSED',
  'DEVICE_REPLACEMENT_PENDING',
  'COMPLIANCE_HOLD',
  'OTHER',
];

function daysTone(days: number): BadgeTone {
  if (days >= 7) return 'critical';
  if (days >= 3) return 'warning';
  return 'neutral';
}

export function NonOperationalQueuePage() {
  const { session } = useAuth();
  const isOpsHead = session?.role === 'OPERATIONS_HEAD';
  const [rows, setRows] = useState<NonOpQueueRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showModal, setShowModal] = useState(false);

  const load = () => {
    setLoading(true);
    apiNonOpQueue()
      .then(setRows)
      .catch(() => setError('Failed to load the Non-Operational queue'))
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  const confirm = async (id: string) => {
    try {
      await apiConfirmNonOp(id);
      load();
    } catch {
      setError('Confirmation failed');
    }
  };

  const override = async (id: string) => {
    const reason = window.prompt('Override-confirm reason (mandatory):');
    if (!reason?.trim()) return;
    try {
      await apiOverrideConfirmNonOp(id, reason.trim());
      load();
    } catch {
      setError('Override-confirm failed');
    }
  };

  const columns: Column<NonOpQueueRow>[] = [
    { key: 'device', header: 'Device', render: (row) => <span className="font-mono text-xs text-ink-strong">{row.deviceId}</span> },
    { key: 'reason', header: 'Reason', render: (row) => <span className="text-ink">{row.reasonCode ?? '—'}</span> },
    { key: 'deal', header: 'Deal Type', render: (row) => <span className="text-xs text-ink-muted">{row.dealTypeAtMarking ?? '—'}</span> },
    {
      key: 'state',
      header: 'State',
      render: (row) => (
        <span className="flex items-center gap-2">
          <Badge tone={STATE_TONE[row.state]}>{STATE_LABEL[row.state]}</Badge>
          {row.recoveryTicketId && (
            <span className="font-mono text-[11px] text-success" title="Recovery Ticket">
              ↻ {row.recoveryTicketId.slice(0, 8)}
            </span>
          )}
        </span>
      ),
    },
    {
      key: 'awaiting',
      header: 'Awaiting',
      render: (row) => <Badge tone={daysTone(row.daysElapsed)}>{row.daysElapsed}d</Badge>,
    },
    {
      key: 'actions',
      header: 'Actions',
      render: (row) => (
        <div className="flex gap-2">
          {row.state === 'AWAITING_ZM_CONFIRMATION' && (
            <Button type="button" size="sm" variant="secondary" data-testid={`nonop-confirm-${row.markingId}`} onClick={() => confirm(row.markingId)}>
              Confirm
            </Button>
          )}
          {isOpsHead && row.state !== 'CONFIRMED' && (
            <Button type="button" size="sm" variant="danger" data-testid={`nonop-override-${row.markingId}`} onClick={() => override(row.markingId)}>
              Override-confirm
            </Button>
          )}
        </div>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        title="Non-Operational — Dual Confirmation"
        subtitle="Devices awaiting dual confirmation (manager + customer) before going Non-Operational. Oldest wait first. On confirmation, in-flight tickets close and a RECURRING device with a physical-retrieval reason gets a Recovery Ticket."
        actions={
          <Button type="button" onClick={() => setShowModal(true)}>
            Mark Non-Operational
          </Button>
        }
      />

      {error && (
        <p role="alert" className="mb-4 text-sm text-critical">
          {error}
        </p>
      )}

      <div className="mb-5 grid grid-cols-3 gap-3">
        <div>
          <MetricCard label="Awaiting Confirmation" value={rows.length} tone="warning" />
        </div>
      </div>

      <DataTable
        ariaLabel="Non-Operational dual confirmation"
        rowKey={(r) => r.markingId}
        rowTestId={(r) => `nonop-row-${r.markingId}`}
        columns={columns}
        rows={rows}
        loading={loading}
        empty="Nothing awaiting confirmation."
      />

      {showModal && (
        <MarkNonOperationalModal
          onClose={() => setShowModal(false)}
          onMarked={() => {
            setShowModal(false);
            load();
          }}
        />
      )}
    </div>
  );
}

function MarkNonOperationalModal({ onClose, onMarked }: { onClose: () => void; onMarked: () => void }) {
  const [deviceId, setDeviceId] = useState('');
  const [reason, setReason] = useState<NonOpReason | ''>('');
  const [reasonText, setReasonText] = useState('');
  const [dealType, setDealType] = useState<string | null>(null);
  const [ack, setAck] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const qualifyingReason = reason !== '' && RECOVERY_REASONS.includes(reason);

  // Fetch the device's deal type so the Recovery-Ticket warning can be shown for a RECURRING device.
  useEffect(() => {
    setDealType(null);
    if (!/^\d+$/.test(deviceId) || !qualifyingReason) return;
    let live = true;
    apiGetDeviceDealType(deviceId)
      .then((d) => { if (live) setDealType(d.dealType); })
      .catch(() => { if (live) setDealType(null); });
    return () => { live = false; };
  }, [deviceId, qualifyingReason]);

  const showWarning = qualifyingReason && dealType === 'RECURRING';
  const valid =
    /^\d+$/.test(deviceId) &&
    reason !== '' &&
    (reason !== 'OTHER' || reasonText.trim() !== '') &&
    (!showWarning || ack);

  const submit = async () => {
    if (!valid) return;
    setSubmitting(true);
    try {
      await apiRequestNonOp({ deviceId, reasonCode: reason, reasonText: reason === 'OTHER' ? reasonText.trim() : null });
      onMarked();
    } catch {
      setError('Failed to mark Non-Operational');
      setSubmitting(false);
    }
  };

  return (
    <div role="dialog" aria-label="Mark Non-Operational" className="fixed inset-0 z-50 flex items-center justify-center bg-chrome-900/40 p-4">
      <div className="w-[28rem] rounded-card border border-line bg-surface-card p-5 shadow-lg">
        <h3 className="mb-4 text-base font-semibold text-ink-strong">Mark device Non-Operational</h3>

        <div className="flex flex-col gap-3">
          <Field label="Device ID" htmlFor="nonop-device">
            <Input id="nonop-device" value={deviceId} onChange={(e) => setDeviceId(e.target.value)} />
          </Field>

          <Field label="Reason" htmlFor="nonop-reason">
            <FilterSelect id="nonop-reason" value={reason} onChange={(e) => setReason(e.target.value as NonOpReason)} className="w-full">
              <option value="">Select a reason…</option>
              {REASONS.map((r) => (
                <option key={r} value={r}>{r}</option>
              ))}
            </FilterSelect>
          </Field>

          {reason === 'OTHER' && (
            <Field label="Free-text details" htmlFor="nonop-details">
              <textarea
                id="nonop-details"
                value={reasonText}
                onChange={(e) => setReasonText(e.target.value)}
                className="w-full rounded-md border border-line bg-surface-card px-3 py-2 text-sm text-ink-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600/40"
              />
            </Field>
          )}

          {showWarning && (
            <div role="alert" className="rounded-card border border-warning/40 bg-warning-bg p-3 text-sm text-warning">
              <p className="mb-2">A Recovery Ticket will be auto-created for this RECURRING device on confirmation.</p>
              <label className="flex items-center gap-2 text-xs">
                <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} aria-label="Acknowledge Recovery Ticket creation" />
                I acknowledge a Recovery Ticket will be created.
              </label>
            </div>
          )}

          {error && <p role="alert" className="text-sm text-critical">{error}</p>}
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <Button type="button" variant="secondary" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" size="sm" onClick={submit} disabled={!valid || submitting}>
            Mark device Non-Operational
          </Button>
        </div>
      </div>
    </div>
  );
}
