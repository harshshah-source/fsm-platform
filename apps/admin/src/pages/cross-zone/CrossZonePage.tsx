import { useEffect, useState } from 'react';
import { useAuth } from '../../auth/AuthProvider';
import {
  apiCrossZoneApprove,
  apiCrossZoneDefer,
  apiCrossZoneDeny,
  apiCrossZoneHistory,
  apiCrossZoneList,
  apiCrossZoneReEscalate,
  apiCrossZoneSweep,
  type CrossZoneHistoryRow,
  type CrossZoneRow,
} from '../../api/crossZone';
import { apiEngineers, type EngineerListRow } from '../../api/engineers';
import { listZones, type ZoneView } from '../../api/org';
import { DataTable, MetricCard, PageHeader, type Column } from '../../components/data';
import { SLABadge, StatusPill, TierBadge } from '../../components/domain';
import { Modal } from '../../components/overlay/Modal';
import { Badge, Button, Select } from '../../components/ui';
import { cn } from '../../lib/cn';

/** Whole-days elapsed since an ISO timestamp (for the AgeChip-style age column). */
function daysSince(iso: string): number {
  const ms = Date.now() - new Date(iso).getTime();
  return Math.max(0, Math.floor(ms / 86_400_000));
}

const asDate = (iso: string | null): string => (iso ? new Date(iso).toLocaleDateString() : '—');

/** The action verb behind an audited history row, for a reader who thinks in decisions not enum names. */
const HISTORY_LABEL: Record<string, string> = {
  CROSS_ZONE_AUTO_ESCALATION: 'Auto-escalated',
  CROSS_ZONE_MANUAL_FLAG: 'Flagged',
  CROSS_ZONE_APPROVE: 'Approved',
  CROSS_ZONE_DENIED: 'Denied',
  CROSS_ZONE_DEFERRED: 'Deferred',
  CROSS_ZONE_REVIEW_DUE: 'Returned on review date',
  CROSS_ZONE_RE_ESCALATE_OPS: 'Re-escalated to Ops Head',
};

type Tab = 'queue' | 'history';

/** The decision a Modal is open for — one piece of state, because only one dialog is ever open. */
type Dialog =
  | { kind: 'approve'; escalationId: string }
  | { kind: 'deny'; escalationId: string }
  | { kind: 'defer'; escalationId: string }
  | null;

/**
 * Issue 78 — Admin Cross-Zone page (`/cross-zone`, over the Issue 32 backend). Managers see the
 * cross-zone escalation queue split into Auto-Escalations (Platinum, system-swept) and Manual Flags
 * (Gold/Silver, ZM-raised). CSM / Operations Head resolve each via Approve / Deny / Defer; a ZM sees
 * their home-zone queue. Presentation-only — the backend owns all scope + business rules.
 *
 * #355 completes it. The queue was the whole page, which made every escalation's life end at its first
 * decision: a denied AUTO escalation left the ZM's queue although only that ZM may re-escalate it, a
 * deferral's review date was never shown, an approval was three `window.prompt`s in which the zone and
 * the engineer were typed independently and never checked against each other, and no decision could be
 * read back afterwards at all. So: decisions are Modals with real pickers, the review date is a column,
 * Re-escalate is a row action for the home ZM, and History is a second tab.
 */
export function CrossZonePage() {
  const { session } = useAuth();
  const [tab, setTab] = useState<Tab>('queue');
  const [rows, setRows] = useState<CrossZoneRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [history, setHistory] = useState<CrossZoneHistoryRow[] | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);

  const [dialog, setDialog] = useState<Dialog>(null);
  const [zones, setZones] = useState<ZoneView[]>([]);
  const [engineers, setEngineers] = useState<EngineerListRow[]>([]);
  const [targetZoneId, setTargetZoneId] = useState('');
  const [seId, setSeId] = useState('');
  const [reason, setReason] = useState('');
  const [reviewDate, setReviewDate] = useState('');

  const load = () => {
    setLoading(true);
    apiCrossZoneList()
      .then(setRows)
      .catch(() => setError('Failed to load the cross-zone escalation queue'))
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  // The history is a second read, so it is fetched when the tab is opened rather than on every page
  // load: a decision log nobody has asked to see is not worth a request on the queue's critical path.
  useEffect(() => {
    if (tab !== 'history' || history !== null || historyLoading) return;
    setHistoryLoading(true);
    apiCrossZoneHistory()
      .then(setHistory)
      .catch(() => setError('Failed to load the cross-zone decision history'))
      .finally(() => setHistoryLoading(false));
  }, [tab, history, historyLoading]);

  // Cross-zone deciders (CSM / Operations Head) resolve escalations; a ZM sees the queue read-only,
  // except for the one door that is theirs alone — re-escalating a denied AUTO escalation.
  const isDecider =
    session?.role === 'CENTRAL_SERVICE_MANAGER' || session?.role === 'OPERATIONS_HEAD';
  const isZm = session?.role === 'ZONAL_MANAGER';

  const run = async (fn: () => Promise<unknown>, failMsg: string) => {
    try {
      await fn();
      setDialog(null);
      load();
    } catch {
      setError(failMsg);
      setDialog(null);
    }
  };

  /**
   * The approve dialog's two lists. Loaded when it first opens, not on page load: a ZM never opens it,
   * and `/org/zones` is a CSM/OH read, so fetching it eagerly would be a guaranteed 403 on every ZM's
   * page view. Failures are silent by design — the dialog degrades to empty pickers and the operator
   * sees the page's own alert, rather than an error about a list they have not asked for yet.
   */
  const openApprove = (escalationId: string) => {
    setTargetZoneId('');
    setSeId('');
    setDialog({ kind: 'approve', escalationId });
    if (zones.length === 0) listZones().then(setZones).catch(() => undefined);
    if (engineers.length === 0) apiEngineers().then(setEngineers).catch(() => undefined);
  };

  const openDeny = (escalationId: string) => {
    setReason('');
    setDialog({ kind: 'deny', escalationId });
  };

  const openDefer = (escalationId: string) => {
    setReason('');
    setReviewDate('');
    setDialog({ kind: 'defer', escalationId });
  };

  const sweep = () => void run(() => apiCrossZoneSweep(), 'Auto-escalation sweep failed');

  const auto = rows.filter((r) => r.escalationType === 'AUTO_PLATINUM');
  const manual = rows.filter((r) => r.escalationType === 'MANUAL_FLAG');

  // The engineers of the chosen zone, and only those. This is what makes the pair the operator sends
  // agree by construction: the backend refuses a zone/SE mismatch with a 400, and a picker that could
  // offer another zone's engineer would exist only to produce that 400.
  const zoneEngineers = engineers.filter((e) => String(e.zoneId) === targetZoneId && e.isActive);

  const baseColumns: Column<CrossZoneRow>[] = [
    {
      key: 'ticket',
      header: 'Ticket',
      render: (r) => (
        <span className="flex items-center gap-2">
          <span className="font-mono text-xs text-ink-muted">{r.ticketId.slice(0, 8)}</span>
          {/* #354 — work assigned INTO this zone. Without it the receiving ZM's queue looked identical
              to the work they sent out, which is the read that made incoming work invisible. */}
          {r.direction === 'incoming' && (
            <Badge tone="info" data-testid={`cz-incoming-${r.escalationId}`}>
              Incoming
            </Badge>
          )}
        </span>
      ),
    },
    {
      key: 'company',
      header: 'Company',
      render: (r) => (
        <span className="flex items-center gap-2">
          <span className="font-mono text-xs text-ink-strong">{r.companyId}</span>
          <TierBadge tier={r.companyTier} />
        </span>
      ),
    },
    { key: 'bucket', header: 'Bucket', render: (r) => <SLABadge bucket={r.triggerBucket} /> },
    { key: 'status', header: 'Status', render: (r) => <StatusPill status={r.status} /> },
    // #355 — a deferral is a postponement to a date, and the date was nowhere on the page. The sweep
    // now brings the row back on it, so this column is also what makes that return predictable.
    {
      key: 'reviewDate',
      header: 'Review date',
      render: (r) => (
        <span data-testid={`cz-review-date-${r.escalationId}`} className="text-xs text-ink">
          {asDate(r.reviewDate)}
        </span>
      ),
      exportValue: (r) => r.reviewDate ?? '',
    },
    { key: 'age', header: 'Age', render: (r) => `${daysSince(r.createdAt)}d` },
  ];

  const actionsColumn: Column<CrossZoneRow> = {
    key: 'actions',
    header: 'Actions',
    exportable: false,
    // #354 — a decided row has nothing left to decide. It can only reach this table as a target zone's
    // incoming work (the ZM read now carries APPROVED rows for the zone doing the work), and offering
    // Approve on it would send a call the backend answers with `ESCALATION_NOT_ACTIONABLE`.
    render: (r) =>
      r.status === 'APPROVED' ? (
        <span className="text-xs text-ink-muted">—</span>
      ) : (
        <div className="flex gap-2">
          <Button type="button" size="sm" variant="primary" data-testid={`cz-approve-${r.escalationId}`} onClick={() => openApprove(r.escalationId)}>
            Approve
          </Button>
          <Button type="button" size="sm" variant="danger" data-testid={`cz-deny-${r.escalationId}`} onClick={() => openDeny(r.escalationId)}>
            Deny
          </Button>
          <Button type="button" size="sm" variant="secondary" data-testid={`cz-defer-${r.escalationId}`} onClick={() => openDefer(r.escalationId)}>
            Defer
          </Button>
        </div>
      ),
  };

  /**
   * #355 (#93) — the home ZM's own door. `POST /cross-zone/:id/re-escalate` has existed since Issue 32
   * with no button anywhere, and the row it acts on had itself dropped out of the ZM's queue: a denied
   * Platinum escalation was a decision with an appeal route nobody could reach.
   */
  const zmActionsColumn: Column<CrossZoneRow> = {
    key: 'zm-actions',
    header: 'Actions',
    exportable: false,
    render: (r) =>
      r.status === 'DENIED' && r.escalationType === 'AUTO_PLATINUM' ? (
        <Button
          type="button"
          size="sm"
          variant="secondary"
          data-testid={`cz-re-escalate-${r.escalationId}`}
          onClick={() => void run(() => apiCrossZoneReEscalate(r.escalationId), 'Re-escalation failed')}
        >
          Re-escalate to Ops Head
        </Button>
      ) : (
        <span className="text-xs text-ink-muted">—</span>
      ),
  };

  const columns = isDecider ? [...baseColumns, actionsColumn] : isZm ? [...baseColumns, zmActionsColumn] : baseColumns;

  const historyColumns: Column<CrossZoneHistoryRow>[] = [
    { key: 'at', header: 'When', render: (r) => <span className="text-xs text-ink">{new Date(r.at).toLocaleString()}</span> },
    { key: 'ticket', header: 'Ticket', render: (r) => <span className="font-mono text-xs text-ink-muted">{r.ticketId.slice(0, 8)}</span> },
    {
      key: 'action',
      header: 'Decision',
      render: (r) => <span className="font-medium text-ink-strong">{HISTORY_LABEL[r.action] ?? r.action}</span>,
    },
    {
      key: 'by',
      header: 'By',
      render: (r) => (
        <span className="flex flex-wrap items-center gap-1.5">
          <span className="text-ink-strong">{r.decidedByName ?? r.decidedByRole ?? 'system'}</span>
          {r.decidedByRole && <span className="text-xs text-ink-muted">{r.decidedByRole}</span>}
          {/* The acting tag is the whole reason this column is not just a name: a CSM deciding under a
              ZM's backup authority is not the ZM's own decision, and #340 is what makes it readable. */}
          {r.actedAsRole && (
            <Badge tone="warning" title="Taken under backup authority">
              acting as {r.actedAsRole}
            </Badge>
          )}
        </span>
      ),
    },
    { key: 'reason', header: 'Reason', render: (r) => <span className="text-xs text-ink">{r.reason ?? '—'}</span> },
    { key: 'outcome', header: 'Now', render: (r) => <StatusPill status={r.currentStatus} /> },
  ];

  const tabBtn = (t: Tab, label: string, count: number | null) => (
    <button
      type="button"
      role="tab"
      aria-selected={tab === t}
      onClick={() => setTab(t)}
      className={cn(
        'rounded-md px-2.5 py-1 text-[13px] font-medium transition-colors',
        tab === t ? 'bg-surface-card text-ink-strong shadow-sm' : 'text-ink-muted hover:text-ink-strong',
      )}
    >
      {label}
      {count !== null && <span className="ml-1.5 text-xs tabular-nums text-ink-muted">{count}</span>}
    </button>
  );

  return (
    <div>
      <PageHeader
        title="Cross-Zone Escalations"
        subtitle="Platinum tickets auto-swept from an uncovered home zone, and Gold/Silver tickets a ZM manually flagged for cross-zone help. Approve, deny, or defer each."
      />

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div role="tablist" aria-label="Cross-zone tabs" className="flex gap-1 rounded-md bg-surface-sunken p-0.5">
          {tabBtn('queue', 'Queue', rows.length)}
          {tabBtn('history', 'History', history?.length ?? null)}
        </div>
        {isDecider && tab === 'queue' && (
          <Button type="button" size="sm" variant="secondary" data-testid="cz-sweep" onClick={sweep}>
            Run auto-escalation sweep
          </Button>
        )}
      </div>

      {error && (
        <p role="alert" className="mb-4 text-sm text-critical">
          {error}
        </p>
      )}

      {tab === 'queue' && (
        <>
          <div className="mb-5 grid grid-cols-2 gap-3 sm:max-w-md">
            <MetricCard label="Auto-Escalations" value={auto.length} tone="critical" />
            <MetricCard label="Manual Flags" value={manual.length} tone="warning" />
          </div>

          {(
            [
              { heading: 'Auto-Escalations (Platinum)', ariaLabel: 'Cross-Zone Auto-Escalations', rows: auto, empty: 'No auto-escalations pending.' },
              { heading: 'Manual Flags (Gold/Silver)', ariaLabel: 'Cross-Zone Manual Flags', rows: manual, empty: 'No manual flags pending.' },
            ] as const
          ).map((section) => (
            <section key={section.ariaLabel} className="mb-8 last:mb-0">
              <h3 className="mb-2 text-sm font-semibold text-ink-strong">{section.heading}</h3>
              <DataTable
                ariaLabel={section.ariaLabel}
                rowKey={(r) => r.escalationId}
                rowTestId={(r) => `cz-row-${r.escalationId}`}
                columns={columns}
                rows={section.rows}
                loading={loading}
                empty={section.empty}
              />
            </section>
          ))}
        </>
      )}

      {tab === 'history' && (
        <section>
          <h3 className="mb-2 text-sm font-semibold text-ink-strong">Decision history (last 30 days)</h3>
          <DataTable
            ariaLabel="Cross-Zone Decision History"
            rowKey={(r) => r.auditId}
            rowTestId={(r) => `cz-history-${r.auditId}`}
            columns={historyColumns}
            rows={history ?? []}
            loading={historyLoading}
            empty="No cross-zone decisions in this window."
          />
        </section>
      )}

      {/* #355 AC3 — approve is a Modal with real pickers. The zone chooses the SE list, so the pair
          sent to the backend cannot be the mismatch it 400s on. */}
      <Modal
        open={dialog?.kind === 'approve'}
        onClose={() => setDialog(null)}
        title="Approve cross-zone escalation"
        footer={
          <>
            <Button variant="secondary" size="sm" onClick={() => setDialog(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              data-testid="cz-approve-confirm"
              disabled={!targetZoneId || !seId}
              onClick={() => {
                if (!dialog || dialog.kind !== 'approve' || !targetZoneId || !seId) return;
                void run(
                  () => apiCrossZoneApprove(dialog.escalationId, Number(targetZoneId), seId),
                  'Approve failed — the escalation was not assigned',
                );
              }}
            >
              Approve &amp; assign
            </Button>
          </>
        }
      >
        <label htmlFor="cz-approve-zone" className="mb-1 block text-xs font-medium text-ink-muted">
          Target zone
        </label>
        <Select
          id="cz-approve-zone"
          data-testid="cz-approve-zone"
          value={targetZoneId}
          onChange={(e) => {
            setTargetZoneId(e.target.value);
            // The engineer belongs to the zone, so changing the zone cannot leave the old pick behind.
            setSeId('');
          }}
        >
          <option value="">Select a zone…</option>
          {zones.map((z) => (
            <option key={z.zoneId} value={String(z.zoneId)}>
              {z.name}
            </option>
          ))}
        </Select>

        <label htmlFor="cz-approve-se" className="mb-1 mt-4 block text-xs font-medium text-ink-muted">
          Assign to engineer
        </label>
        <Select
          id="cz-approve-se"
          data-testid="cz-approve-se"
          value={seId}
          disabled={!targetZoneId}
          onChange={(e) => setSeId(e.target.value)}
        >
          <option value="">{targetZoneId ? 'Select an engineer…' : 'Choose a zone first'}</option>
          {zoneEngineers.map((e) => (
            <option key={e.seId} value={e.seId}>
              {e.name} · {e.activeTicketCount}/{e.dailyCapacity}
            </option>
          ))}
        </Select>
        {targetZoneId && zoneEngineers.length === 0 && (
          <p className="mt-2 text-xs text-warning">No active engineers in this zone.</p>
        )}
      </Modal>

      {/* The reason is mandatory on the backend; Confirm stays disabled until there is one, so a
          refusal is never the way an operator discovers that. */}
      <Modal
        open={dialog?.kind === 'deny'}
        onClose={() => setDialog(null)}
        title="Deny cross-zone escalation"
        footer={
          <>
            <Button variant="secondary" size="sm" onClick={() => setDialog(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              size="sm"
              data-testid="cz-deny-confirm"
              disabled={!reason.trim()}
              onClick={() => {
                if (!dialog || dialog.kind !== 'deny' || !reason.trim()) return;
                void run(() => apiCrossZoneDeny(dialog.escalationId, reason.trim()), 'Deny failed');
              }}
            >
              Deny
            </Button>
          </>
        }
      >
        <label htmlFor="cz-deny-reason" className="mb-1 block text-xs font-medium text-ink-muted">
          Reason (mandatory) — the home ZM is told this
        </label>
        <textarea
          id="cz-deny-reason"
          data-testid="cz-deny-reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          className="min-h-[5rem] w-full rounded-md border border-line bg-surface-card px-3 py-2 text-sm text-ink-strong"
          placeholder="Why can this not be covered cross-zone?"
        />
      </Modal>

      <Modal
        open={dialog?.kind === 'defer'}
        onClose={() => setDialog(null)}
        title="Defer cross-zone escalation"
        footer={
          <>
            <Button variant="secondary" size="sm" onClick={() => setDialog(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              data-testid="cz-defer-confirm"
              disabled={!reviewDate || !reason.trim()}
              onClick={() => {
                if (!dialog || dialog.kind !== 'defer' || !reviewDate || !reason.trim()) return;
                void run(() => apiCrossZoneDefer(dialog.escalationId, reviewDate, reason.trim()), 'Defer failed');
              }}
            >
              Defer
            </Button>
          </>
        }
      >
        <label htmlFor="cz-defer-date" className="mb-1 block text-xs font-medium text-ink-muted">
          Review date — the escalation returns to this queue on it
        </label>
        <input
          id="cz-defer-date"
          type="date"
          data-testid="cz-defer-date"
          value={reviewDate}
          onChange={(e) => setReviewDate(e.target.value)}
          className="h-10 w-full rounded-md border border-line bg-surface-card px-3 text-sm text-ink-strong"
        />
        <label htmlFor="cz-defer-reason" className="mb-1 mt-4 block text-xs font-medium text-ink-muted">
          Reason (mandatory)
        </label>
        <textarea
          id="cz-defer-reason"
          data-testid="cz-defer-reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          className="min-h-[5rem] w-full rounded-md border border-line bg-surface-card px-3 py-2 text-sm text-ink-strong"
          placeholder="Why is this being held until then?"
        />
      </Modal>
    </div>
  );
}
