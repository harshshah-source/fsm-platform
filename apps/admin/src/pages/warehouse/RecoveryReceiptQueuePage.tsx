import { useEffect, useState } from 'react';
import { apiConfirmRecoveryReceipt, apiRecoveryAwaitingReceipt, type RecoveryRow } from '../../api/recovery';

/**
 * Recovery "Awaiting Warehouse Receipt" queue (Issue 36, `/warehouse/recovery-receipt`). The Warehouse
 * Manager physically checks the returned device + serial against the Collection-Form data and confirms
 * receipt — which auto-closes the Recovery Ticket (`AUTO_CLOSED_ON_WAREHOUSE_RECEIPT`, no ZM approval).
 * Follows the sibling warehouse queue pages' house style (no dedicated v2 reference image).
 */
export function RecoveryReceiptQueuePage() {
  const [rows, setRows] = useState<RecoveryRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    apiRecoveryAwaitingReceipt()
      .then(setRows)
      .catch(() => setError('Failed to load the Recovery receipt queue'));
  };
  useEffect(load, []);

  const confirm = async (ticketId: string) => {
    try {
      await apiConfirmRecoveryReceipt(ticketId);
      load();
    } catch {
      setError('Confirm receipt failed');
    }
  };

  return (
    <div>
      <h2 className="mb-1 text-xl font-semibold">Recovery — Awaiting Warehouse Receipt</h2>
      <p className="mb-4 text-sm text-slate-500">
        Devices collected in the field, awaiting your physical check + serial confirmation. Confirming
        receipt auto-closes the Recovery Ticket.
      </p>

      {error && (
        <p role="alert" className="mb-4 text-sm text-red-700">
          {error}
        </p>
      )}

      <table aria-label="Awaiting Warehouse Receipt" className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b text-left text-slate-500">
            <th className="py-2 pr-3">Ticket</th>
            <th className="py-2 pr-3">Device</th>
            <th className="py-2 pr-3">Confirmed serial</th>
            <th className="py-2 pr-3">Condition notes</th>
            <th className="py-2 pr-3">Actions</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={5} className="py-4 text-slate-400">
                Nothing awaiting receipt.
              </td>
            </tr>
          )}
          {rows.map((row) => (
            <tr key={row.ticketId} data-testid={`rcv-row-${row.ticketId}`} className="border-b align-top hover:bg-slate-50">
              <td className="py-2 pr-3 font-mono text-xs">{row.ticketId.slice(0, 8)}</td>
              <td className="py-2 pr-3 font-mono text-xs">{row.deviceId}</td>
              <td className="py-2 pr-3 font-mono text-xs">{row.collectedDeviceSerial ?? '—'}</td>
              <td className="py-2 pr-3 text-slate-600">{row.collectionConditionNotes ?? '—'}</td>
              <td className="py-2 pr-3">
                <button
                  type="button"
                  data-testid={`rcv-receipt-${row.ticketId}`}
                  onClick={() => confirm(row.ticketId)}
                  className="rounded bg-emerald-700 px-2 py-0.5 text-xs font-medium text-white hover:bg-emerald-600"
                >
                  Confirm Receipt
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
