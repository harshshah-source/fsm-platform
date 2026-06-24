import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth } from '../../auth/AuthProvider';
import {
  apiEngineerDetail,
  apiEngineers,
  apiSetAvailability,
  type EngineerDetail,
  type EngineerListRow,
  type SettableStatus,
} from '../../api/engineers';

/** The five derived Activity Status buckets surfaced as metric cards (v2-reference/15-se-activity). */
const METRIC_STATUSES = ['BUSY', 'ON_SITE', 'AVAILABLE', 'OFFLINE', 'SHIFT_ENDING'] as const;
const SETTABLE: SettableStatus[] = ['ON_LEAVE', 'OFF_SHIFT', 'WEEKLY_OFF', 'SOFT_UNAVAILABLE'];

const BADGE_TONE: Record<string, string> = {
  BUSY: 'bg-amber-100 text-amber-800',
  ON_SITE: 'bg-blue-100 text-blue-800',
  AVAILABLE: 'bg-emerald-100 text-emerald-800',
  OFFLINE: 'bg-slate-100 text-slate-600',
  SHIFT_ENDING: 'bg-violet-100 text-violet-800',
};
const tone = (s: string) => BADGE_TONE[s] ?? 'bg-rose-100 text-rose-800';

/**
 * SE Management page (Issue 25, `/engineers`, v2-reference/15-se-activity). The zone-scoped SE list
 * with the render-time derived Activity Status, coverage, today's ticket count and Common-Kit chip;
 * selecting a row opens the detail panel (Day Plan, per-component Van Stock with shortages in red,
 * availability windows) and — for ZM / CSM, never Operations Head — the Set Availability action.
 */
export function SeManagementPage() {
  const { session } = useAuth();
  const canSet = session?.role === 'ZONAL_MANAGER' || session?.role === 'CENTRAL_SERVICE_MANAGER';

  const [rows, setRows] = useState<EngineerListRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<EngineerDetail | null>(null);

  const [status, setStatus] = useState<SettableStatus>('OFF_SHIFT');
  const [windowStart, setWindowStart] = useState('');
  const [windowEnd, setWindowEnd] = useState('');
  const [reason, setReason] = useState('');

  const load = useCallback(() => {
    apiEngineers()
      .then(setRows)
      .catch(() => setError('Failed to load engineers'));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const openDetail = async (seId: string) => {
    setSelectedId(seId);
    setDetail(null);
    try {
      setDetail(await apiEngineerDetail(seId));
    } catch {
      setError('Failed to load the SE detail');
    }
  };

  const submitAvailability = async () => {
    if (!selectedId || !windowStart) return;
    await apiSetAvailability(selectedId, {
      status,
      windowStart: new Date(windowStart).toISOString(),
      windowEnd: windowEnd ? new Date(windowEnd).toISOString() : null,
      reason: reason.trim() || null,
    });
    setWindowStart('');
    setWindowEnd('');
    setReason('');
    await openDetail(selectedId);
    load();
  };

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const r of rows) c[r.activityStatus] = (c[r.activityStatus] ?? 0) + 1;
    return c;
  }, [rows]);

  return (
    <div>
      <h2 className="mb-1 text-xl font-semibold">SE Activity</h2>
      <p className="mb-4 text-sm text-slate-500">
        Derived SE Activity Status — computed at render time from availability, soft states, and the
        last activity ping. Never stored. Set planning availability for an SE on the right.
      </p>

      {error && (
        <p role="alert" className="mb-4 text-sm text-red-700">
          {error}
        </p>
      )}

      <div className="mb-5 flex flex-wrap gap-3">
        {METRIC_STATUSES.map((s) => (
          <div key={s} data-testid={`se-metric-${s}`} className="min-w-[7rem] rounded border px-4 py-2">
            <div className="text-2xl font-semibold">{counts[s] ?? 0}</div>
            <div className="text-xs uppercase tracking-wide text-slate-500">{s.replace('_', ' ')}</div>
          </div>
        ))}
      </div>

      <div className="flex gap-6">
        <table aria-label="SE Management" className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b text-left text-slate-500">
              <th className="py-2 pr-3">Service Engineer</th>
              <th className="py-2 pr-3">Activity</th>
              <th className="py-2 pr-3">Coverage</th>
              <th className="py-2 pr-3">Availability</th>
              <th className="py-2 pr-3">Active Tickets</th>
              <th className="py-2 pr-3">Kit</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="py-4 text-slate-400">
                  No engineers in scope.
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <tr
                key={r.seId}
                data-testid={`se-row-${r.seId}`}
                className={`border-b align-top hover:bg-slate-50 ${selectedId === r.seId ? 'bg-slate-50' : ''}`}
              >
                <td className="py-2 pr-3">
                  <button type="button" onClick={() => openDetail(r.seId)} className="font-medium text-blue-700 hover:underline">
                    {r.name}
                  </button>
                </td>
                <td className="py-2 pr-3">
                  <span className={`rounded px-2 py-0.5 text-xs font-medium ${tone(r.activityStatus)}`}>{r.activityStatus}</span>
                </td>
                <td className="py-2 pr-3 text-slate-600">{r.coverageType}</td>
                <td className="py-2 pr-3 text-slate-600">{r.availabilityStatus}</td>
                <td className="py-2 pr-3">{r.activeTicketCount}</td>
                <td className="py-2 pr-3">
                  {r.kitComplete ? (
                    <span className="text-xs text-emerald-700">Kit OK</span>
                  ) : (
                    <span className="text-xs text-rose-700">Kit short</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {selectedId && (
          <section aria-label="SE detail" className="w-80 shrink-0 rounded border p-4 text-sm">
            {!detail && <p className="text-slate-400">Loading…</p>}
            {detail && (
              <>
                <h3 className="mb-1 text-base font-semibold">{detail.name}</h3>
                <p className="mb-3 text-xs text-slate-500">
                  {detail.coverageType} · {detail.activityStatus}
                </p>

                <div className="mb-3">
                  <div className="text-xs uppercase tracking-wide text-slate-400">Day Plan</div>
                  <div>
                    {detail.dayPlan.status ?? 'No active schedule'} · {detail.dayPlan.ticketCount} ticket(s)
                  </div>
                </div>

                <div className="mb-3">
                  <div className="text-xs uppercase tracking-wide text-slate-400">Van Stock</div>
                  {detail.vanStock.length === 0 && <div className="text-slate-400">No tracked stock</div>}
                  <ul>
                    {detail.vanStock.map((v) => (
                      <li key={v.componentId}>
                        {v.name} · {v.qty}
                      </li>
                    ))}
                  </ul>
                  {detail.kit.missing.map((m) => (
                    <div key={m.componentId} className="text-rose-700">
                      {m.name} short by {m.shortBy}
                    </div>
                  ))}
                </div>

                <div className="mb-3">
                  <div className="text-xs uppercase tracking-wide text-slate-400">Availability</div>
                  {detail.availabilityRows.length === 0 && <div className="text-slate-400">No windows</div>}
                  <ul>
                    {detail.availabilityRows.map((a, i) => (
                      <li key={i} className="text-xs">
                        {a.status} · {a.windowStart.slice(0, 10)}
                        {a.windowEnd ? `–${a.windowEnd.slice(0, 10)}` : ''}
                      </li>
                    ))}
                  </ul>
                </div>

                {canSet && (
                  <div className="mt-4 border-t pt-3">
                    <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Set Availability</div>
                    <label className="block text-xs text-slate-500" htmlFor="avail-status">
                      Status
                    </label>
                    <select
                      id="avail-status"
                      value={status}
                      onChange={(e) => setStatus(e.target.value as SettableStatus)}
                      className="mb-2 w-full rounded border px-2 py-1 text-sm"
                    >
                      {SETTABLE.map((s) => (
                        <option key={s} value={s}>
                          {s}
                        </option>
                      ))}
                    </select>
                    <label className="block text-xs text-slate-500" htmlFor="avail-start">
                      Window start
                    </label>
                    <input
                      id="avail-start"
                      type="datetime-local"
                      value={windowStart}
                      onChange={(e) => setWindowStart(e.target.value)}
                      className="mb-2 w-full rounded border px-2 py-1 text-sm"
                    />
                    <label className="block text-xs text-slate-500" htmlFor="avail-end">
                      Window end (optional)
                    </label>
                    <input
                      id="avail-end"
                      type="datetime-local"
                      value={windowEnd}
                      onChange={(e) => setWindowEnd(e.target.value)}
                      className="mb-2 w-full rounded border px-2 py-1 text-sm"
                    />
                    <label className="block text-xs text-slate-500" htmlFor="avail-reason">
                      Reason
                    </label>
                    <input
                      id="avail-reason"
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                      className="mb-3 w-full rounded border px-2 py-1 text-sm"
                    />
                    <button
                      type="button"
                      onClick={submitAvailability}
                      disabled={!windowStart}
                      className="rounded bg-blue-600 px-3 py-1 text-sm text-white disabled:opacity-40"
                    >
                      Set availability
                    </button>
                  </div>
                )}
              </>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
