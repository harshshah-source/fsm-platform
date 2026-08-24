import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { apiListSchedules, apiZoneEngineers, type ScheduleRow, type ZoneEngineer } from '../../api/schedules';
import {
  DataTable,
  EmptyState,
  MetricStrip,
  PageHeader,
  type Column,
  type Metric,
} from '../../components/data';
import { DispatchTimelineNote } from '../../components/domain';
import { Badge, LoadBadge } from '../../components/ui';
import type { BadgeTone } from '../../components/ui/Badge';
import { IconCalendar } from '../../components/ui/icons';
import { addIsoDays, istIsoDate } from '../../lib/datetime';

/**
 * ZM Batch-Schedule list (Issue 13b AC#1 · FE-12 parity, reference 12). One row per SE Work Schedule with
 * batch/ticket counts and an AUTO_ASSIGNED / OVERRIDDEN status badge. Monitoring only: system batches
 * auto-dispatch to the SE Day Plan, so there is **no Approve action and no approval countdown** (the gate
 * was removed — CONTEXT.md Decisions §7, ADR-0019 superseded). Zone scope is enforced server-side.
 *
 * FE-12 is a presentation-only refactor onto `PageHeader` + `MetricStrip` + the canonical `DataTable`;
 * the monitoring fetch, the `Batch Schedules` aria-label, the `schedule-status-*` test ids, the
 * row→`/schedules/:seId` navigation, and the absence of any Approve gate are all preserved.
 *
 * **#281 — the present tense of the dispatch timeline** (#280 R1/R3). The page says so itself now,
 * because `PageHeader` renders screen-reader-only and its subtitle reached nobody looking at the
 * screen. The per-row link out is the contextual, per-record mechanism #280 R8 ruled: this SE, on the
 * projection for the next run. It is not a switcher — this page lists every SE's day plan and is not
 * a single-date view, which is exactly why R8 rejected a shared date-anchored control.
 */
// Work-schedule statuses as the list returns them: ACTIVE (auto-dispatched, untouched) or
// OVERRIDDEN (a ZM adjusted it). Labels are operator-facing; test ids keep the raw status.
const STATUS_TONE: Record<string, BadgeTone> = {
  ACTIVE: 'success',
  AUTO_ASSIGNED: 'neutral',
  OVERRIDDEN: 'warning',
};

/**
 * The date a "what would the next run do for them" link should open. Tomorrow in IST — the same day
 * `SchedulerPreviewPage` defaults to, derived through the same IST helpers (CONTEXT.md Decisions §19)
 * rather than a device-local date, which disagrees with the backend for every session before 05:30.
 */
function nextRunDate(now: Date = new Date()): string {
  return addIsoDays(istIsoDate(now), 1);
}

export function SchedulesPage() {
  const navigate = useNavigate();
  const [rows, setRows] = useState<ScheduleRow[]>([]);
  /**
   * #269 — the SEs' committed day load, keyed by seId. Joined from `/schedules/engineers` rather than
   * derived from `ScheduleRow.ticketCount`, which counts one *schedule*: a floating SE working two
   * zones has two of them, so that figure beside a whole-day cap would understate the load on exactly
   * the engineers most at risk of being overloaded. One definition, everywhere.
   *
   * A failure here is deliberately not a page error — the schedule list is the primary content and
   * still reads correctly without the column.
   */
  const [engineers, setEngineers] = useState<ZoneEngineer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    apiListSchedules()
      .then((r) => alive && setRows(r))
      .catch(() => alive && setError('Failed to load schedules'))
      .finally(() => alive && setLoading(false));
    apiZoneEngineers()
      .then((e) => alive && setEngineers(e))
      .catch(() => alive && setEngineers([]));
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => load(), [load]);

  const metrics: Metric[] = useMemo(() => {
    const overridden = rows.filter((r) => r.status === 'OVERRIDDEN').length;
    const tickets = rows.reduce((s, r) => s + r.ticketCount, 0);
    const batches = rows.reduce((s, r) => s + r.batchCount, 0);
    return [
      { label: 'Schedules', value: rows.length, hint: 'SEs with a day plan', tone: 'info' },
      { label: 'Auto-Assigned', value: rows.length - overridden, hint: 'no gate', tone: 'success' },
      { label: 'Overridden', value: overridden, hint: 'ZM adjusted', tone: 'warning' },
      { label: 'Tickets', value: tickets, hint: `${batches} batches`, tone: 'brand' },
    ];
  }, [rows]);

  const columns: Column<ScheduleRow>[] = [
    {
      key: 'engineer',
      header: 'Service Engineer',
      render: (r) => (
        <div className="min-w-0">
          <div className="font-medium text-link">{r.seName ?? 'Unknown SE'}</div>
          <div className="font-mono text-[10px] text-ink-muted">{r.seId.slice(0, 8)}</div>
        </div>
      ),
      sortable: true,
      sortValue: (r) => r.seName ?? '',
    },
    {
      key: 'zone',
      header: 'Zone',
      render: (r) => <span className="text-ink">{r.zoneName ?? `Zone ${r.zoneId}`}</span>,
      sortable: true,
      sortValue: (r) => r.zoneName ?? r.zoneId,
    },
    {
      key: 'dates',
      header: 'Plan Date',
      render: (r) => (
        <span className="text-ink tabular-nums">
          {r.dateFrom === r.dateTo ? r.dateFrom : `${r.dateFrom} – ${r.dateTo}`}
        </span>
      ),
    },
    {
      key: 'batches',
      header: 'Plant Stops',
      align: 'right',
      render: (r) => <span className="tabular-nums">{r.batchCount}</span>,
      sortable: true,
      sortValue: (r) => r.batchCount,
    },
    {
      key: 'tickets',
      header: 'Tickets',
      align: 'right',
      render: (r) => <span className="tabular-nums">{r.ticketCount}</span>,
      sortable: true,
      sortValue: (r) => r.ticketCount,
    },
    {
      key: 'load',
      header: 'Load / Cap',
      align: 'right',
      render: (r) => {
        const eng = engineers.find((e) => e.engineerId === r.seId);
        return eng ? (
          <LoadBadge seId={r.seId} committed={eng.committed ?? 0} dailyCapacity={eng.dailyCapacity} />
        ) : (
          <span className="text-ink-muted">—</span>
        );
      },
    },
    {
      /*
       * #281 AC8 (#280 R8) — the per-record cross-view link. `stopPropagation` because the row itself
       * navigates to the day plan: the row is "what is committed for them", this link is "what the
       * next run would do for them", and the two must not fire together.
       */
      key: 'next-run',
      header: '',
      exportable: false,
      render: (r) => (
        <Link
          to={`/schedules/preview?date=${nextRunDate()}&se=${r.seId}`}
          data-testid={`schedule-to-preview-${r.seId}`}
          onClick={(e) => e.stopPropagation()}
          className="whitespace-nowrap text-xs text-link hover:underline"
        >
          What the next run would do →
        </Link>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (r) => (
        <span data-testid={`schedule-status-${r.status}`}>
          <Badge tone={STATUS_TONE[r.status] ?? 'neutral'}>
            {r.status === 'OVERRIDDEN' ? 'ZM Adjusted' : r.status === 'ACTIVE' ? 'Auto-Dispatched' : r.status}
          </Badge>
        </span>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        title="Batch Schedule"
        subtitle="Each row is one Service Engineer's day plan: the plant stops and tickets the system auto-dispatched to them. Click a row to see the ordered stops. Monitoring only — batches dispatch automatically, no approval step."
      />
      <DispatchTimelineNote position="present" />
      <MetricStrip metrics={metrics} />
      <DataTable
        ariaLabel="Batch Schedules"
        rowKey={(r) => r.scheduleId}
        columns={columns}
        rows={rows}
        loading={loading}
        error={error}
        onRetry={load}
        stickyHeader
        onRowClick={(r) => navigate(`/schedules/${r.seId}`)}
        empty={
          <EmptyState
            icon={<IconCalendar />}
            message="No SE day plans in scope yet. Auto-assigned batches will appear here as they dispatch."
          />
        }
      />
    </div>
  );
}
