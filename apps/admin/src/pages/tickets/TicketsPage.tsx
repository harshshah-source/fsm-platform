import { useEffect, useState } from 'react';
import { Outlet, useNavigate } from 'react-router-dom';
import { apiTicketsList, type TicketFilters, type TicketRow } from '../../api/tickets';
import { BUCKET_LABEL, SLA_BUCKETS } from '../../lib/slaBucket';
import { BucketBadge, InlineBadges } from './ticketBadges';

const WORK_TYPES = ['TROUBLESHOOT', 'INSTALL', 'RECOVERY'];
const STATUSES = [
  'OPEN', 'SUBMITTED', 'VERIFICATION_PENDING', 'CLOSED', 'CLOSED_AUTO_RECOVERY',
  'FAILED_VERIFICATION', 'ESCALATED', 'CLOSED_NON_OPERATIONAL',
];
const ASSIGNMENT_STATES = ['UNASSIGNED', 'FORMALLY_ASSIGNED'];

/**
 * Ticket List (Issue 07, `/tickets`). Filterable by work type, status, company, plant, SLA bucket,
 * and assignment state; the server returns rows already sorted SLA-bucket-descending and zone-scoped.
 * A row click opens the Detail Drawer (`/tickets/:ticketId`) inline via the nested route Outlet.
 */
export function TicketsPage() {
  const navigate = useNavigate();
  const [filters, setFilters] = useState<TicketFilters>({});
  const [rows, setRows] = useState<TicketRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    apiTicketsList(filters)
      .then((r) => alive && setRows(r))
      .catch(() => alive && setError('Failed to load tickets'));
    return () => {
      alive = false;
    };
  }, [filters]);

  const set =
    (key: keyof TicketFilters) => (e: React.ChangeEvent<HTMLSelectElement | HTMLInputElement>) =>
      setFilters((f) => ({ ...f, [key]: e.target.value || undefined }));

  return (
    <div className="flex">
      <div className="flex-1">
        <h2 className="mb-4 text-xl font-semibold">Tickets</h2>
        {error && (
          <p role="alert" className="mb-2 text-sm text-red-700">
            {error}
          </p>
        )}

        <div className="mb-3 flex flex-wrap gap-2 text-sm">
          <select aria-label="Work type" onChange={set('workType')} className="rounded border px-2 py-1">
            <option value="">All work types</option>
            {WORK_TYPES.map((w) => (
              <option key={w} value={w}>{w}</option>
            ))}
          </select>
          <select aria-label="Status" onChange={set('status')} className="rounded border px-2 py-1">
            <option value="">All statuses</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
          <select aria-label="SLA bucket" onChange={set('bucket')} className="rounded border px-2 py-1">
            <option value="">All buckets</option>
            {SLA_BUCKETS.map((b) => (
              <option key={b} value={b}>{BUCKET_LABEL[b]}</option>
            ))}
          </select>
          <select
            aria-label="Assignment state"
            onChange={set('assignmentState')}
            className="rounded border px-2 py-1"
          >
            <option value="">All assignment states</option>
            {ASSIGNMENT_STATES.map((a) => (
              <option key={a} value={a}>{a}</option>
            ))}
          </select>
          <input
            aria-label="Company ID"
            placeholder="Company ID"
            onChange={set('companyId')}
            className="w-28 rounded border px-2 py-1"
          />
          <input
            aria-label="Plant ID"
            placeholder="Plant ID"
            onChange={set('plantId')}
            className="w-24 rounded border px-2 py-1"
          />
        </div>

        <table aria-label="Tickets" className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b text-left">
              <th className="py-1 pr-3">Device</th>
              <th className="py-1 pr-3">Plant</th>
              <th className="py-1 pr-3">Tier</th>
              <th className="py-1 pr-3">Status</th>
              <th className="py-1 pr-3">Bucket</th>
              <th className="py-1 pr-3">Flags</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((t) => (
              <tr
                key={t.ticketId}
                onClick={() => navigate(`/tickets/${t.ticketId}`)}
                className="cursor-pointer border-b hover:bg-slate-50"
              >
                <td className="py-1 pr-3 font-medium">{t.deviceId}</td>
                <td className="py-1 pr-3">{t.plantId}</td>
                <td className="py-1 pr-3">{t.companyTier}</td>
                <td className="py-1 pr-3">{t.status}</td>
                <td className="py-1 pr-3">
                  <BucketBadge bucket={t.slaBucket} />
                </td>
                <td className="py-1 pr-3">
                  <InlineBadges ticket={t} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {/* Detail Drawer renders here (nested route /tickets/:ticketId) over the list. */}
      <Outlet />
    </div>
  );
}
