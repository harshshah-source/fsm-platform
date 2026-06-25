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

/**
 * Non-Operational dual-confirmation queue (Issue 35, `/readiness/non-operational`). Manager roles see
 * markings awaiting confirmation sorted by `awaiting_since` asc (server-ordered) with a state badge +
 * a days-elapsed badge, perform the manager confirmation leg, and (Operations Head) override-confirm
 * after 7 days. The Mark-Non-Operational modal warns — with an explicit acknowledgement — that a
 * RECURRING device with a physical-retrieval reason auto-creates a Recovery Ticket on confirmation.
 * No v2 reference image exists for this page; it follows the sibling queue pages' house style.
 */
const STATE_LABEL: Record<NonOpState, string> = {
  AWAITING_ZM_CONFIRMATION: 'Awaiting Manager',
  AWAITING_CUSTOMER_CONFIRMATION: 'Awaiting Customer',
  CONFIRMED: 'Confirmed',
};
const STATE_CLASS: Record<NonOpState, string> = {
  AWAITING_ZM_CONFIRMATION: 'bg-amber-100 text-amber-800',
  AWAITING_CUSTOMER_CONFIRMATION: 'bg-blue-100 text-blue-800',
  CONFIRMED: 'bg-emerald-100 text-emerald-800',
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

function daysClass(days: number): string {
  if (days >= 7) return 'bg-rose-100 text-rose-800';
  if (days >= 3) return 'bg-amber-100 text-amber-800';
  return 'bg-slate-100 text-slate-600';
}

export function NonOperationalQueuePage() {
  const { session } = useAuth();
  const isOpsHead = session?.role === 'OPERATIONS_HEAD';
  const [rows, setRows] = useState<NonOpQueueRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showModal, setShowModal] = useState(false);

  const load = () => {
    apiNonOpQueue()
      .then(setRows)
      .catch(() => setError('Failed to load the Non-Operational queue'));
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

  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <h2 className="text-xl font-semibold">Non-Operational — Dual Confirmation</h2>
        <button
          type="button"
          onClick={() => setShowModal(true)}
          className="rounded bg-slate-800 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-700"
        >
          Mark Non-Operational
        </button>
      </div>
      <p className="mb-4 text-sm text-slate-500">
        Devices awaiting dual confirmation (manager + customer) before going Non-Operational. Oldest
        wait first. On confirmation, in-flight tickets close and a RECURRING device with a
        physical-retrieval reason gets a Recovery Ticket.
      </p>

      {error && (
        <p role="alert" className="mb-4 text-sm text-red-700">
          {error}
        </p>
      )}

      <table aria-label="Non-Operational dual confirmation" className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b text-left text-slate-500">
            <th className="py-2 pr-3">Device</th>
            <th className="py-2 pr-3">Reason</th>
            <th className="py-2 pr-3">Deal Type</th>
            <th className="py-2 pr-3">State</th>
            <th className="py-2 pr-3">Awaiting</th>
            <th className="py-2 pr-3">Actions</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={6} className="py-4 text-slate-400">
                Nothing awaiting confirmation.
              </td>
            </tr>
          )}
          {rows.map((row) => (
            <tr key={row.markingId} data-testid={`nonop-row-${row.markingId}`} className="border-b align-top hover:bg-slate-50">
              <td className="py-2 pr-3 font-mono text-xs">{row.deviceId}</td>
              <td className="py-2 pr-3">{row.reasonCode ?? '—'}</td>
              <td className="py-2 pr-3 text-xs">{row.dealTypeAtMarking ?? '—'}</td>
              <td className="py-2 pr-3">
                <span className={`rounded px-2 py-0.5 text-xs ${STATE_CLASS[row.state]}`}>{STATE_LABEL[row.state]}</span>
                {row.recoveryTicketId && (
                  <span className="ml-2 font-mono text-[11px] text-emerald-700" title="Recovery Ticket">
                    ↻ {row.recoveryTicketId.slice(0, 8)}
                  </span>
                )}
              </td>
              <td className="py-2 pr-3">
                <span className={`rounded px-2 py-0.5 text-xs ${daysClass(row.daysElapsed)}`}>{row.daysElapsed}d</span>
              </td>
              <td className="py-2 pr-3">
                {row.state === 'AWAITING_ZM_CONFIRMATION' && (
                  <button
                    type="button"
                    data-testid={`nonop-confirm-${row.markingId}`}
                    onClick={() => confirm(row.markingId)}
                    className="mr-2 rounded border px-2 py-0.5 text-xs hover:bg-slate-100"
                  >
                    Confirm
                  </button>
                )}
                {isOpsHead && row.state !== 'CONFIRMED' && (
                  <button
                    type="button"
                    data-testid={`nonop-override-${row.markingId}`}
                    onClick={() => override(row.markingId)}
                    className="rounded border px-2 py-0.5 text-xs text-rose-700 hover:bg-rose-50"
                  >
                    Override-confirm
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

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
    // `valid` implies reason !== '' — TS narrows reason to NonOpReason here (aliased-condition analysis).
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
    <div role="dialog" aria-label="Mark Non-Operational" className="fixed inset-0 flex items-center justify-center bg-black/30">
      <div className="w-[28rem] rounded bg-white p-5 shadow-lg">
        <h3 className="mb-3 text-lg font-semibold">Mark device Non-Operational</h3>

        <label className="mb-1 block text-sm" htmlFor="nonop-device">Device ID</label>
        <input id="nonop-device" value={deviceId} onChange={(e) => setDeviceId(e.target.value)} className="mb-3 w-full rounded border px-2 py-1 text-sm" />

        <label className="mb-1 block text-sm" htmlFor="nonop-reason">Reason</label>
        <select id="nonop-reason" value={reason} onChange={(e) => setReason(e.target.value as NonOpReason)} className="mb-3 w-full rounded border px-2 py-1 text-sm">
          <option value="">Select a reason…</option>
          {REASONS.map((r) => (
            <option key={r} value={r}>{r}</option>
          ))}
        </select>

        {reason === 'OTHER' && (
          <>
            <label className="mb-1 block text-sm" htmlFor="nonop-details">Free-text details</label>
            <textarea id="nonop-details" value={reasonText} onChange={(e) => setReasonText(e.target.value)} className="mb-3 w-full rounded border px-2 py-1 text-sm" />
          </>
        )}

        {showWarning && (
          <div role="alert" className="mb-3 rounded border border-amber-300 bg-amber-50 p-2 text-sm text-amber-900">
            <p className="mb-2">A Recovery Ticket will be auto-created for this RECURRING device on confirmation.</p>
            <label className="flex items-center gap-2 text-xs">
              <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} aria-label="Acknowledge Recovery Ticket creation" />
              I acknowledge a Recovery Ticket will be created.
            </label>
          </div>
        )}

        {error && <p role="alert" className="mb-2 text-sm text-red-700">{error}</p>}

        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded border px-3 py-1 text-sm">Cancel</button>
          <button
            type="button"
            onClick={submit}
            disabled={!valid || submitting}
            className="rounded bg-slate-800 px-3 py-1 text-sm font-medium text-white disabled:opacity-40"
          >
            Mark device Non-Operational
          </button>
        </div>
      </div>
    </div>
  );
}
