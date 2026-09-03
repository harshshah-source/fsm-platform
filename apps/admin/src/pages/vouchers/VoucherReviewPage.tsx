import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  apiExportVouchers,
  apiMarkVouchersPaid,
  apiReviewVoucher,
  apiVouchers,
  type ReviewAction,
  type VoucherItem,
  type VoucherRow,
} from '../../api/vouchers';
import { useAuth } from '../../auth/AuthProvider';
import { DataTable, MetricCard, PageHeader, type Column } from '../../components/data';
import { StatusPill } from '../../components/domain';
import { Modal } from '../../components/overlay';
import { Button, Field, Input } from '../../components/ui';
import { downloadCsv } from '../../lib/csv';

/**
 * Expense Voucher review (Issue 38, `/vouchers`). The ZM review queue (status = ZONAL_MANAGER_REVIEW,
 * sorted by submitted_at) on the canonical queue recipe (`MetricCard` strip + `DataTable` + `StatusPill`):
 * the activity check (linked Ticket the ZM verifies against, or a warning when none), over-limit line
 * items in red, photo thumbnails with a full-screen lightbox, and the Approve / Reject (mandatory reason) /
 * Needs Clarification (comment) actions — all of which notify the SE on the backend.
 *
 * The Operations Head additionally gets the APPROVED Finance view: Export Finance (monthly CSV of all
 * APPROVED vouchers) + multi-select Mark PAID (after Finance confirms the batch). No selector contract to
 * preserve — this is the issue's first admin surface; ids are `voucher-row-*` / `voucher-metric-*` for the
 * later FE parity pass. ZM/CSM review own/all zones; export + mark-paid are Operations-Head only.
 *
 * Issue 359 adds the money-path controls to this same layout (no reference exists in the v2 set for
 * vouchers; the page is its own authority, so this extends rather than redraws): the activity cell now
 * carries the ticket-match warnings, and Mark PAID reports its batch back — which ids were paid, which
 * were skipped and why, which failed — because the batch is deliberately not all-or-nothing on the
 * backend and a silent partial result would be unreadable.
 */
type View = 'review' | 'approved';

/**
 * The activity-check warning vocabulary (`vouchers.service.ts`). Every one is a review cue, not a
 * refusal, so they are rendered as flags beside the row rather than as blocking errors.
 */
const ACTIVITY_WARNING_LABELS: Record<string, { label: string; tone: 'warning' | 'critical'; title: string }> = {
  NO_ACTIVITY_LINK: {
    label: 'No activity link',
    tone: 'warning',
    title: 'This claim names neither a ticket nor a plant — there is no work record to verify it against.',
  },
  LINKED_TICKET_NOT_FOUND: {
    label: 'Ticket not found',
    tone: 'critical',
    title: 'The linked ticket does not exist. Usually a mis-keyed reference — confirm with the SE.',
  },
  TICKET_NOT_ASSIGNED_TO_SE: {
    label: 'Not this SE’s ticket',
    tone: 'warning',
    title: 'The linked ticket was never assigned to this Service Engineer. Check who actually did the work.',
  },
  TICKET_PLANT_MISMATCH: {
    label: 'Plant mismatch',
    tone: 'warning',
    title: 'The claimed plant is not the plant the linked ticket belongs to.',
  },
};

const MARK_PAID_SKIP_LABELS: Record<string, string> = {
  SAME_APPROVER: 'you approved this voucher — a second person must mark it paid',
  NOT_APPROVED: 'not approved yet',
  NOT_FOUND: 'no such voucher',
};

/**
 * The mark-PAID batch result. Widened locally over the client's declared return type: the backend
 * reports `reason` on each skip and a `failed[]` channel (#359), and `apps/admin/src/api/vouchers.ts`
 * is owned by another slice this cycle — the optional fields keep this page honest without editing it.
 */
interface MarkPaidOutcome {
  paid: string[];
  skipped: { voucherId: string; status: string; reason?: string }[];
  failed?: { voucherId: string; reason: string }[];
}

const currentMonth = () => {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};

const inr = (n: number) => `₹${n.toLocaleString('en-IN')}`;
const shortDate = (iso: string | null) => (iso ? iso.slice(0, 10) : '—');

export function VoucherReviewPage() {
  const { session } = useAuth();
  const navigate = useNavigate();
  const isOpsHead = session?.role === 'OPERATIONS_HEAD';

  const [view, setView] = useState<View>('review');
  const [rows, setRows] = useState<VoucherRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // per-row inline review state
  const [reasonFor, setReasonFor] = useState<{ id: string; action: Exclude<ReviewAction, 'APPROVE'> } | null>(null);
  const [reason, setReason] = useState('');

  // OH Finance view state
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [batchRef, setBatchRef] = useState('');
  const [month, setMonth] = useState(currentMonth());
  const [markPaidOutcome, setMarkPaidOutcome] = useState<MarkPaidOutcome | null>(null);

  // photo lightbox
  const [lightbox, setLightbox] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    apiVouchers(view === 'approved' ? 'APPROVED' : 'ZONAL_MANAGER_REVIEW')
      .then(setRows)
      .catch(() => setError('Failed to load Expense Vouchers'))
      .finally(() => setLoading(false));
  }, [view]);

  useEffect(() => {
    setSelected(new Set());
    setReasonFor(null);
    setReason('');
    setMarkPaidOutcome(null);
    load();
  }, [load]);

  const overLimitCount = useMemo(() => rows.filter((r) => r.hasOverLimit).length, [rows]);

  const review = async (id: string, action: ReviewAction, notes?: string) => {
    await apiReviewVoucher(id, action, notes);
    setReasonFor(null);
    setReason('');
    load();
  };

  const confirmReason = async () => {
    if (!reasonFor || !reason.trim()) return;
    await review(reasonFor.id, reasonFor.action, reason.trim());
  };

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const markPaid = async () => {
    if (selected.size === 0) return;
    const outcome: MarkPaidOutcome = await apiMarkVouchersPaid([...selected], batchRef.trim() || undefined);
    setMarkPaidOutcome(outcome);
    // Only the ids that actually moved leave the selection: a skipped or failed voucher stays picked so
    // the operator can act on it (hand a SAME_APPROVER row to a second approver, retry a failed one).
    setSelected((prev) => new Set([...prev].filter((id) => !outcome.paid.includes(id))));
    setBatchRef('');
    load();
  };

  const exportFinance = async () => {
    const out = await apiExportVouchers(month);
    downloadCsv(out.filename, out.csv);
  };

  const itemsCell = (row: VoucherRow) => (
    <div className="flex flex-col gap-0.5">
      {row.items.map((it: VoucherItem) => (
        <span
          key={it.itemId}
          {...(it.overLimit ? { 'data-testid': `voucher-overlimit-${it.itemId}` } : {})}
          className={it.overLimit ? 'text-xs font-semibold text-critical' : 'text-xs text-ink'}
          title={it.overLimit ? `Over the ${inr(it.limit)} ${it.category} limit` : undefined}
        >
          {it.category} {inr(it.amount)}
          {it.photoRef && (
            <button
              type="button"
              aria-label="View photo"
              onClick={() => setLightbox(it.photoRef)}
              className="ml-1 text-link hover:underline"
            >
              📎
            </button>
          )}
        </span>
      ))}
    </div>
  );

  const activityCell = (row: VoucherRow) => {
    // `warnings` is the #359 list; `warning` is the single headline code the queue has always sent.
    // Read the list when it is there and fall back to the headline so an older payload still renders.
    const check = row.activityCheck as typeof row.activityCheck & { warnings?: string[] };
    const warnings = check.warnings ?? (check.warning ? [check.warning] : []);
    return (
      <div data-testid={`voucher-activity-${row.voucherId}`} className="flex flex-col gap-0.5 text-xs">
        {check.linkedTicketId ? (
          <button
            type="button"
            onClick={() => navigate(`/tickets/${check.linkedTicketId}`)}
            className="self-start font-mono text-link hover:underline"
          >
            {check.linkedTicketId.slice(0, 8)}
          </button>
        ) : (
          <span className="text-ink-muted">No ticket linked</span>
        )}
        {warnings.map((code) => {
          const w = ACTIVITY_WARNING_LABELS[code];
          return (
            <span
              key={code}
              data-testid={`voucher-activity-warning-${row.voucherId}-${code}`}
              title={w?.title ?? code}
              className={w?.tone === 'critical' ? 'text-critical' : 'text-warning'}
            >
              ⚠ {w?.label ?? code}
            </span>
          );
        })}
      </div>
    );
  };

  const reviewActions = (row: VoucherRow) => {
    if (reasonFor && reasonFor.id === row.voucherId) {
      const isReject = reasonFor.action === 'REJECT';
      return (
        <div className="flex flex-col gap-1">
          <Field label={isReject ? 'Rejection reason' : 'Clarification comment'} htmlFor={`reason-${row.voucherId}`}>
            <Input id={`reason-${row.voucherId}`} value={reason} onChange={(e) => setReason(e.target.value)} className="text-xs" />
          </Field>
          <div className="flex gap-2">
            <Button type="button" size="sm" variant={isReject ? 'danger' : 'secondary'} onClick={confirmReason}>
              {isReject ? 'Confirm reject' : 'Send clarification'}
            </Button>
            <Button type="button" size="sm" variant="secondary" onClick={() => { setReasonFor(null); setReason(''); }}>
              Cancel
            </Button>
          </div>
        </div>
      );
    }
    return (
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" onClick={() => review(row.voucherId, 'APPROVE')}>
          Approve
        </Button>
        <Button type="button" size="sm" variant="danger" onClick={() => { setReasonFor({ id: row.voucherId, action: 'REJECT' }); setReason(''); }}>
          Reject
        </Button>
        <Button type="button" size="sm" variant="secondary" onClick={() => { setReasonFor({ id: row.voucherId, action: 'NEEDS_CLARIFICATION' }); setReason(''); }}>
          Needs clarification
        </Button>
      </div>
    );
  };

  const columns: Column<VoucherRow>[] = [
    ...(view === 'approved'
      ? [
          {
            key: 'select',
            header: '',
            render: (r: VoucherRow) => (
              <input
                type="checkbox"
                aria-label={`Select voucher ${r.voucherId}`}
                checked={selected.has(r.voucherId)}
                onChange={() => toggleSelect(r.voucherId)}
              />
            ),
          } satisfies Column<VoucherRow>,
        ]
      : []),
    { key: 'voucher', header: 'Voucher', render: (r) => <span className="font-mono text-xs text-ink-muted">{r.voucherId.slice(0, 8)}</span> },
    { key: 'se', header: 'SE', render: (r) => <span className="text-ink-strong">{r.seName}</span> },
    { key: 'zone', header: 'Zone', render: (r) => <span className="text-ink-muted">{r.zoneId}</span> },
    { key: 'items', header: 'Items', render: itemsCell },
    ...(view === 'review' ? [{ key: 'activity', header: 'Activity', render: activityCell } satisfies Column<VoucherRow>] : []),
    { key: 'total', header: 'Total', align: 'right', render: (r) => <span className="font-medium text-ink-strong">{inr(r.totalAmount)}</span> },
    { key: 'submitted', header: 'Submitted', render: (r) => <span className="text-xs text-ink-muted">{shortDate(r.submittedAt)}</span> },
    ...(view === 'review'
      ? [{ key: 'status', header: 'Status', render: (r: VoucherRow) => <StatusPill status={r.status} /> } satisfies Column<VoucherRow>]
      : []),
    ...(view === 'review'
      ? [{ key: 'actions', header: 'Actions', exportable: false, render: reviewActions } satisfies Column<VoucherRow>]
      : []),
  ];

  return (
    <div>
      <PageHeader
        title="Expense Vouchers"
        subtitle="SE reimbursement claims for review. Verify the activity record and proof, then Approve, Reject (with a reason), or request Clarification — the SE is notified. Over-limit line items are flagged in red."
      />

      {error && (
        <p role="alert" className="mb-4 text-sm text-critical">
          {error}
        </p>
      )}

      {isOpsHead && (
        <div className="mb-4 flex flex-wrap items-end gap-2">
          <div className="flex gap-1">
            <Button type="button" size="sm" variant={view === 'review' ? 'primary' : 'secondary'} onClick={() => setView('review')}>
              To review
            </Button>
            <Button type="button" size="sm" variant={view === 'approved' ? 'primary' : 'secondary'} onClick={() => setView('approved')}>
              Approved (Finance)
            </Button>
          </div>
          {view === 'approved' && (
            <>
              <Field label="Finance month" htmlFor="voucher-month">
                <Input id="voucher-month" value={month} onChange={(e) => setMonth(e.target.value)} className="w-28 text-xs" placeholder="YYYY-MM" />
              </Field>
              <Button type="button" size="sm" variant="secondary" onClick={exportFinance}>
                Export Finance
              </Button>
              <Field label="Batch ref" htmlFor="voucher-batch">
                <Input id="voucher-batch" value={batchRef} onChange={(e) => setBatchRef(e.target.value)} className="w-32 text-xs" />
              </Field>
              <Button type="button" size="sm" onClick={markPaid} disabled={selected.size === 0}>
                Mark PAID
              </Button>
            </>
          )}
        </div>
      )}

      {markPaidOutcome && (
        <div
          role="status"
          data-testid="voucher-markpaid-outcome"
          className="mb-4 rounded-md border border-line bg-surface-sunken p-3 text-xs"
        >
          <p className="font-semibold text-ink-strong">
            Marked PAID: {markPaidOutcome.paid.length} of{' '}
            {markPaidOutcome.paid.length + markPaidOutcome.skipped.length + (markPaidOutcome.failed?.length ?? 0)}
          </p>
          <ul className="mt-1 flex flex-col gap-0.5">
            {markPaidOutcome.skipped.map((s) => (
              <li key={s.voucherId} data-testid={`voucher-markpaid-skipped-${s.voucherId}`} className="text-warning">
                <span className="font-mono">{s.voucherId.slice(0, 8)}</span> skipped —{' '}
                {s.reason ? (MARK_PAID_SKIP_LABELS[s.reason] ?? s.reason) : `status ${s.status}`}
              </li>
            ))}
            {(markPaidOutcome.failed ?? []).map((f) => (
              <li key={f.voucherId} data-testid={`voucher-markpaid-failed-${f.voucherId}`} className="text-critical">
                <span className="font-mono">{f.voucherId.slice(0, 8)}</span> failed — {f.reason}
              </li>
            ))}
          </ul>
          {(markPaidOutcome.skipped.length > 0 || (markPaidOutcome.failed?.length ?? 0) > 0) && (
            <p className="mt-1 text-ink-muted">
              The rest of the batch was paid. Skipped and failed vouchers stay selected so they can be retried
              or handed to a second approver.
            </p>
          )}
          <button type="button" onClick={() => setMarkPaidOutcome(null)} className="mt-1 text-link hover:underline">
            Dismiss
          </button>
        </div>
      )}

      <div data-testid="voucher-metric-strip" className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-3">
        <div data-testid="voucher-metric-count">
          <MetricCard label={view === 'approved' ? 'Approved (Finance)' : 'In review'} value={rows.length} tone="info" />
        </div>
        <div data-testid="voucher-metric-overlimit">
          <MetricCard label="Over limit" value={overLimitCount} tone={overLimitCount > 0 ? 'critical' : 'neutral'} />
        </div>
        {view === 'approved' && (
          <div data-testid="voucher-metric-selected">
            <MetricCard label="Selected" value={selected.size} tone="brand" />
          </div>
        )}
      </div>

      <DataTable
        ariaLabel="Expense Vouchers"
        rowKey={(r) => r.voucherId}
        rowTestId={(r) => `voucher-row-${r.voucherId}`}
        columns={columns}
        rows={rows}
        loading={loading}
        empty={view === 'approved' ? 'No approved vouchers awaiting payment.' : 'No vouchers awaiting review.'}
      />

      <Modal open={lightbox !== null} onClose={() => setLightbox(null)} title="Expense proof" className="max-w-2xl">
        {lightbox && <img src={lightbox} alt="Expense proof" className="max-h-[70vh] w-full object-contain" />}
      </Modal>
    </div>
  );
}
