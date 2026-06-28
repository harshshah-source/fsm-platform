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
import {
  DataTable,
  DateRangeChips,
  MetricCard,
  PageHeader,
  type Column,
} from '../../components/data';
import { Badge, Button, Field, Input } from '../../components/ui';
import { FilterSelect } from '../../components/data';
import type { BadgeTone } from '../../components/ui/Badge';
import type { MetricTone } from '../../components/data';

/** The five derived Activity Status buckets surfaced as metric cards (v2-reference/15-se-activity). */
const METRIC_STATUSES = ['BUSY', 'ON_SITE', 'AVAILABLE', 'OFFLINE', 'SHIFT_ENDING'] as const;
const SETTABLE: SettableStatus[] = ['ON_LEAVE', 'OFF_SHIFT', 'WEEKLY_OFF', 'SOFT_UNAVAILABLE'];

/** Activity-status → semantic tone (shared by the metric cards and the row pills). */
const ACTIVITY_TONE: Record<string, BadgeTone> = {
  BUSY: 'warning',
  ON_SITE: 'info',
  AVAILABLE: 'success',
  OFFLINE: 'neutral',
  SHIFT_ENDING: 'verified',
};
const activityTone = (s: string): BadgeTone => ACTIVITY_TONE[s] ?? 'critical';

/**
 * SE Management page (Issue 25 · FE-10 parity, `/engineers`, reference 15). The zone-scoped SE list with
 * the render-time derived Activity Status, coverage, today's ticket count and Common-Kit chip; selecting
 * a row opens the detail panel (Day Plan, per-component Van Stock with shortages in red, availability
 * windows) and — for ZM / CSM, never Operations Head — the Set Availability action.
 *
 * FE-10 is a presentation-only refactor onto `PageHeader` + `MetricCard` + `DataTable`; the engineers
 * fetch, the derived-status counts, the `se-metric-*` / `se-row-*` test ids, the `SE Management` /
 * `SE detail` labels, the literal status text, and the Set-Availability flow are all preserved.
 */
export function SeManagementPage() {
  const { session } = useAuth();
  const canSet = session?.role === 'ZONAL_MANAGER' || session?.role === 'CENTRAL_SERVICE_MANAGER';

  const [rows, setRows] = useState<EngineerListRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<EngineerDetail | null>(null);

  const [status, setStatus] = useState<SettableStatus>('OFF_SHIFT');
  const [windowStart, setWindowStart] = useState('');
  const [windowEnd, setWindowEnd] = useState('');
  const [reason, setReason] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    apiEngineers()
      .then(setRows)
      .catch(() => setError('Failed to load engineers'))
      .finally(() => setLoading(false));
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

  const columns: Column<EngineerListRow>[] = [
    {
      key: 'name',
      header: 'Service Engineer',
      render: (r) => (
        <button
          type="button"
          onClick={() => openDetail(r.seId)}
          className="font-medium text-brand-700 hover:underline"
        >
          {r.name}
        </button>
      ),
    },
    {
      key: 'activity',
      header: 'Activity',
      render: (r) => <Badge tone={activityTone(r.activityStatus)}>{r.activityStatus}</Badge>,
    },
    {
      key: 'coverage',
      header: 'Coverage',
      render: (r) => <span className="text-ink-muted">{r.coverageType}</span>,
    },
    {
      key: 'availability',
      header: 'Availability',
      render: (r) => <span className="text-ink-muted">{r.availabilityStatus}</span>,
    },
    {
      key: 'tickets',
      header: 'Active Tickets',
      align: 'right',
      render: (r) => <span className="tabular-nums">{r.activeTicketCount}</span>,
    },
    {
      key: 'kit',
      header: 'Kit',
      render: (r) =>
        r.kitComplete ? (
          <Badge tone="success">Kit OK</Badge>
        ) : (
          <Badge tone="critical">Kit short</Badge>
        ),
    },
  ];

  return (
    <div>
      <PageHeader
        title="SE Activity"
        subtitle="Derived SE Activity Status — computed at render time from availability, soft states, and the last activity ping. Never stored. Set planning availability for an SE on the right."
        actions={<DateRangeChips />}
      />

      {error && (
        <p role="alert" className="mb-4 text-sm text-critical">
          {error}
        </p>
      )}

      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {METRIC_STATUSES.map((s) => (
          <div key={s} data-testid={`se-metric-${s}`}>
            <MetricCard
              label={s.replace('_', ' ')}
              value={counts[s] ?? 0}
              tone={activityTone(s) as MetricTone}
            />
          </div>
        ))}
      </div>

      <div className="flex gap-6">
        <div className="min-w-0 flex-1">
          <DataTable
            ariaLabel="SE Management"
            rowKey={(r) => r.seId}
            rowTestId={(r) => `se-row-${r.seId}`}
            columns={columns}
            rows={rows}
            loading={loading}
            empty="No engineers in scope."
          />
        </div>

        {selectedId && (
          <section
            aria-label="SE detail"
            className="w-80 shrink-0 rounded-card border border-line bg-surface-card p-4 text-sm shadow-sm"
          >
            {!detail && <p className="text-ink-muted">Loading…</p>}
            {detail && (
              <>
                <h3 className="mb-1 text-base font-semibold text-ink-strong">{detail.name}</h3>
                <p className="mb-3 text-xs text-ink-muted">
                  {detail.coverageType} · {detail.activityStatus}
                </p>

                <div className="mb-3">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-caps">Day Plan</div>
                  <div className="text-ink">
                    {detail.dayPlan.status ?? 'No active schedule'} · {detail.dayPlan.ticketCount} ticket(s)
                  </div>
                </div>

                <div className="mb-3">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-caps">Van Stock</div>
                  {detail.vanStock.length === 0 && <div className="text-ink-muted">No tracked stock</div>}
                  <ul className="text-ink">
                    {detail.vanStock.map((v) => (
                      <li key={v.componentId}>
                        {v.name} · {v.qty}
                      </li>
                    ))}
                  </ul>
                  {detail.kit.missing.map((m) => (
                    <div key={m.componentId} className="text-critical">
                      {m.name} short by {m.shortBy}
                    </div>
                  ))}
                </div>

                <div className="mb-3">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-caps">Availability</div>
                  {detail.availabilityRows.length === 0 && <div className="text-ink-muted">No windows</div>}
                  <ul>
                    {detail.availabilityRows.map((a, i) => (
                      <li key={i} className="text-xs text-ink-muted">
                        {a.status} · {a.windowStart.slice(0, 10)}
                        {a.windowEnd ? `–${a.windowEnd.slice(0, 10)}` : ''}
                      </li>
                    ))}
                  </ul>
                </div>

                {canSet && (
                  <div className="mt-4 flex flex-col gap-2 border-t border-line pt-3">
                    <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-caps">
                      Set Availability
                    </div>
                    <Field label="Status" htmlFor="avail-status">
                      <FilterSelect
                        id="avail-status"
                        value={status}
                        onChange={(e) => setStatus(e.target.value as SettableStatus)}
                        className="w-full"
                      >
                        {SETTABLE.map((s) => (
                          <option key={s} value={s}>
                            {s}
                          </option>
                        ))}
                      </FilterSelect>
                    </Field>
                    <Field label="Window start" htmlFor="avail-start">
                      <Input
                        id="avail-start"
                        type="datetime-local"
                        value={windowStart}
                        onChange={(e) => setWindowStart(e.target.value)}
                      />
                    </Field>
                    <Field label="Window end (optional)" htmlFor="avail-end">
                      <Input
                        id="avail-end"
                        type="datetime-local"
                        value={windowEnd}
                        onChange={(e) => setWindowEnd(e.target.value)}
                      />
                    </Field>
                    <Field label="Reason" htmlFor="avail-reason">
                      <Input
                        id="avail-reason"
                        value={reason}
                        onChange={(e) => setReason(e.target.value)}
                      />
                    </Field>
                    <Button
                      size="sm"
                      onClick={submitAvailability}
                      disabled={!windowStart}
                      className="mt-1 self-start"
                    >
                      Set availability
                    </Button>
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
