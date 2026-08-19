import { useEffect, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useAuth } from '../../auth/AuthProvider';
import { apiComponentRequestsByTicket, type ComponentRequestRow } from '../../api/componentRequests';
import { apiManualCloseRecovery } from '../../api/recovery';
import {
  apiTicketAttempts,
  apiTicketDetail,
  apiTicketForms,
  type TicketAttemptHistory,
  type TicketDetail,
  type TicketForm,
} from '../../api/tickets';
import { apiTicketVerification, type TicketVerification } from '../../api/verification';
import { Badge, Button, type BadgeTone } from '../../components/ui';
import { IconClose } from '../../components/ui/icons';
import { Modal } from '../../components/overlay/Modal';
import { StatusPill, TierBadge } from '../../components/domain';
import { formatPlantDisplayName } from '../../lib/plantNames';
import { BucketBadge, InlineBadges } from './ticketBadges';

const RECOVERY_TERMINAL = new Set(['CLOSED', 'FAILED_RECOVERY']);

type TabId = 'Overview' | 'Lifecycle' | 'Forms' | 'Verification' | 'Components' | 'Assignment History';
const TABS: TabId[] = ['Overview', 'Lifecycle', 'Forms', 'Verification', 'Components', 'Assignment History'];

// Every tab now renders real data; no stub tabs remain.

const CR_STATUS_TONE: Record<string, BadgeTone> = {
  REQUESTED: 'warning',
  APPROVED: 'info',
  SHIPPED: 'verified',
  RECEIVED: 'success',
  REJECTED: 'critical',
};

/** Shared shell for the per-item cards (component requests / form submissions). */
const ITEM_CARD =
  'rounded-md border border-line bg-surface-raised p-3 transition-shadow duration-200 hover:shadow-card';

/** Timeline entry — brand dot + connecting rail, used by Lifecycle and Assignment History. */
function TimelineItem({ title, meta }: { title: string; meta: string }) {
  return (
    <li className="relative pb-1 pl-5 last:pb-0">
      <span
        aria-hidden
        className="absolute left-0 top-1 h-2.5 w-2.5 rounded-full border-2 border-brand-600 bg-surface-card"
      />
      <span aria-hidden className="absolute bottom-0 left-[4px] top-4 w-px bg-line-strong" />
      <div className="text-sm font-semibold text-ink-strong">{title}</div>
      <div className="text-xs text-ink-muted">{meta}</div>
    </li>
  );
}

/**
 * Ticket Detail Drawer (Issue 07, `/tickets/:ticketId`). Slides in over the list (the list stays
 * mounted via its parent route). Overview + Lifecycle render real data from `/api/tickets/:id`; the
 * remaining tabs lazy-load their data when opened.
 */
export function TicketDetailDrawer() {
  const { ticketId } = useParams();
  const navigate = useNavigate();
  const { session } = useAuth();
  const isManager =
    session?.role === 'ZONAL_MANAGER' ||
    session?.role === 'CENTRAL_SERVICE_MANAGER' ||
    session?.role === 'OPERATIONS_HEAD';
  const [searchParams] = useSearchParams();
  const [ticket, setTicket] = useState<TicketDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [components, setComponents] = useState<ComponentRequestRow[] | null>(null);
  const [forms, setForms] = useState<TicketForm[] | null>(null);
  // Verification state: null = not loaded; { run } once fetched (run null = no verification run yet).
  const [verification, setVerification] = useState<{ run: TicketVerification | null } | null>(null);
  // #244 — the assignment windows behind the Special verdict. Lazy, like every other tab's data.
  const [attempts, setAttempts] = useState<TicketAttemptHistory | null>(null);
  const [recoveryCloseOpen, setRecoveryCloseOpen] = useState(false);
  const [recoveryReason, setRecoveryReason] = useState('');
  // The Verification Review page (Issue 19) deep-links to a specific tab via `?tab=Verification`.
  const initialTab = searchParams.get('tab');
  const [tab, setTab] = useState<TabId>(
    initialTab && (TABS as string[]).includes(initialTab) ? (initialTab as TabId) : 'Overview',
  );

  useEffect(() => {
    if (!ticketId) return;
    let alive = true;
    apiTicketDetail(ticketId)
      .then((t) => alive && setTicket(t))
      .catch(() => alive && setError('Failed to load ticket'));
    return () => {
      alive = false;
    };
  }, [ticketId]);

  // Lazy-load the ticket's Component Requests when the Components tab is opened (Issue 62).
  useEffect(() => {
    if (!ticketId || tab !== 'Components' || components !== null) return;
    let alive = true;
    apiComponentRequestsByTicket(ticketId)
      .then((rows) => alive && setComponents(rows))
      .catch(() => alive && setComponents([]));
    return () => {
      alive = false;
    };
  }, [ticketId, tab, components]);

  // #244 — lazy-load the attempt history when the Assignment History tab is opened. This tab used to
  // show only lifecycle *events*; the windows are the substance it was missing, and the thing a
  // SPECIAL badge has to be checkable against.
  useEffect(() => {
    if (!ticketId || tab !== 'Assignment History' || attempts !== null) return;
    let alive = true;
    apiTicketAttempts(ticketId)
      .then((h) => alive && setAttempts(h))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [ticketId, tab, attempts]);

  // Lazy-load the ticket's SE troubleshoot-form submissions when the Forms tab is opened (Issue 70).
  useEffect(() => {
    if (!ticketId || tab !== 'Forms' || forms !== null) return;
    let alive = true;
    apiTicketForms(ticketId)
      .then((res) => alive && setForms(res.forms))
      .catch(() => alive && setForms([]));
    return () => {
      alive = false;
    };
  }, [ticketId, tab, forms]);

  // Lazy-load the ticket's latest verification run when the Verification tab is opened (Issue 18).
  useEffect(() => {
    if (!ticketId || tab !== 'Verification' || verification !== null) return;
    let alive = true;
    apiTicketVerification(ticketId)
      .then((run) => alive && setVerification({ run }))
      .catch(() => alive && setVerification({ run: null }));
    return () => {
      alive = false;
    };
  }, [ticketId, tab, verification]);

  // Assignment History is derived from the already-loaded lifecycle: the human-actor transitions
  // (reassign / override / manual actions carry an actorRole), distinct from system state changes.
  const assignmentEvents = (ticket?.lifecycle ?? []).filter((e) => e.actorRole !== null);

  return (
    <aside
      aria-label="Ticket detail"
      className="animate-drawer-in sticky top-[5.25rem] ml-4 flex max-h-[calc(100vh-6.25rem)] w-96 shrink-0 flex-col self-start overflow-hidden rounded-card border border-line bg-surface-card shadow-floating"
    >
      {/* Header — eyebrow + ticket id + live status, on a raised band. */}
      <div className="flex items-start justify-between gap-3 border-b border-line bg-surface-raised px-4 py-3">
        <div className="min-w-0">
          <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-caps">
            Ticket detail
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <h3 className="font-mono text-sm font-semibold text-ink-strong">
              #{ticketId ? ticketId.slice(0, 8) : '—'}
            </h3>
            {ticket && <StatusPill status={ticket.status} />}
          </div>
        </div>
        <button
          type="button"
          onClick={() => navigate('/tickets')}
          aria-label="Close ticket detail"
          className="rounded-full border border-line bg-surface-card p-1.5 text-ink-muted transition-colors hover:border-line-strong hover:bg-surface-sunken hover:text-ink-strong"
        >
          <IconClose className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Tab pills. */}
      <div
        role="tablist"
        aria-label="Ticket detail tabs"
        className="flex flex-wrap gap-1 border-b border-line px-3 py-2"
      >
        {TABS.map((t) => (
          <button
            key={t}
            role="tab"
            type="button"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={`rounded-full px-2.5 py-1 text-xs font-medium transition-colors duration-150 ${
              tab === t
                ? 'bg-chrome-900 text-chrome-text shadow-card'
                : 'text-ink-muted hover:bg-surface-sunken hover:text-ink-strong'
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {/* Scrollable body — header + tabs stay pinned. */}
      <div className="flex-1 overflow-y-auto p-4">
        {error && (
          <p role="alert" className="rounded-md border border-critical/30 bg-critical-bg px-3 py-2 text-sm text-critical">
            {error}
          </p>
        )}

        {!ticket && !error && (
          <div aria-label="Loading" className="flex flex-col gap-2">
            <p className="sr-only">Loading…</p>
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="h-4 animate-pulse rounded bg-surface-sunken" style={{ width: `${88 - i * 14}%` }} />
            ))}
          </div>
        )}

        {ticket && (
          <div role="tabpanel">
            {tab === 'Overview' && (
              <dl className="grid grid-cols-[6.5rem_1fr] items-baseline gap-x-3 gap-y-2.5 text-sm">
                <dt className="text-xs text-ink-muted">Device</dt>
                <dd className="font-semibold text-ink-strong">{ticket.deviceId}</dd>
                {ticket.vehicleNo && (
                  <>
                    <dt className="text-xs text-ink-muted">Vehicle</dt>
                    <dd className="font-mono text-xs text-ink">{ticket.vehicleNo}</dd>
                  </>
                )}
                <dt className="text-xs text-ink-muted">Work type</dt>
                <dd className="text-ink">{ticket.workType}</dd>
                <dt className="text-xs text-ink-muted">Status</dt>
                <dd>
                  <StatusPill status={ticket.status} />
                </dd>
                <dt className="text-xs text-ink-muted">Company</dt>
                <dd className="text-ink">
                  {ticket.companyName ?? `#${ticket.companyId}`}{' '}
                  <TierBadge tier={ticket.companyTier} className="ml-0.5 align-middle" />
                </dd>
                <dt className="text-xs text-ink-muted">Plant</dt>
                <dd className="text-ink">
                  {ticket.plantName ? formatPlantDisplayName(ticket.plantName) : `#${ticket.plantId}`}
                </dd>
                {/* Live assignment context (Issue 122b): who holds the ticket, and through which batch. */}
                <dt className="text-xs text-ink-muted">Assigned SE</dt>
                <dd data-testid="drawer-assigned-se">
                  {ticket.assignmentState === 'FORMALLY_ASSIGNED' ? (
                    <span>
                      <span className="font-semibold text-ink-strong">
                        {ticket.assignedSeName ?? ticket.assignedSeId ?? '—'}
                      </span>
                      {ticket.overridden && (
                        <Badge tone="info" className="ml-1.5 align-middle">
                          Overridden
                        </Badge>
                      )}
                      {ticket.batchId && (
                        <span className="block text-xs text-ink-muted">
                          Batch #{ticket.batchId}
                          {ticket.scheduleId ? ` · Schedule #${ticket.scheduleId}` : ''}
                        </span>
                      )}
                    </span>
                  ) : (
                    <span className="font-medium text-warning">Unassigned</span>
                  )}
                </dd>
                <dt className="text-xs text-ink-muted">Inactive for</dt>
                <dd>
                  <BucketBadge bucket={ticket.slaBucket} latestGpsDatetime={ticket.latestGpsDatetime} />
                </dd>
                <dt className="text-xs text-ink-muted">Created</dt>
                <dd className="text-xs text-ink">{new Date(ticket.createdAt).toLocaleString()}</dd>
                <dt className="text-xs text-ink-muted">Flags</dt>
                <dd>
                  <InlineBadges ticket={ticket} />
                </dd>
              </dl>
            )}

            {/* Manual close (web-only exception path) for an open Recovery Ticket — ZM / OH / CSM-acting.
                The backend stamps the closure_type by acting role + full audit (Issue 37 AC#2/#3). */}
            {tab === 'Overview' &&
              isManager &&
              ticket.workType === 'RECOVERY' &&
              !RECOVERY_TERMINAL.has(ticket.status) && (
                <button
                  type="button"
                  data-testid="recovery-manual-close"
                  onClick={() => setRecoveryCloseOpen(true)}
                  className="mt-4 rounded-md border border-critical/30 px-2.5 py-1.5 text-xs font-medium text-critical transition-colors hover:bg-critical-bg"
                >
                  Manually close Recovery Ticket
                </button>
              )}

            {tab === 'Lifecycle' && (
              <ol className="flex flex-col text-sm">
                {ticket.lifecycle.length === 0 && (
                  <li className="text-ink-muted">No transitions yet.</li>
                )}
                {ticket.lifecycle.map((e, i) => (
                  <TimelineItem
                    key={i}
                    title={e.toState}
                    meta={`${e.fromState ? `from ${e.fromState} · ` : ''}${e.actorRole ?? 'system'} · ${new Date(e.at).toLocaleString()}`}
                  />
                ))}
              </ol>
            )}

            {tab === 'Components' && (
              <div className="flex flex-col gap-3 text-sm">
                {ticket.failureCycleState === 'WAITING_COMPONENT' && (
                  <div
                    data-testid="waiting-component-badge"
                    className="rounded-md border border-warning/30 bg-warning-bg px-3 py-2 text-xs font-medium text-warning"
                  >
                    WAITING_COMPONENT — primary SLA paused
                    {ticket.waitingComponentSince
                      ? ` since ${new Date(ticket.waitingComponentSince).toLocaleString()}`
                      : ''}
                  </div>
                )}

                {components === null && <p className="text-ink-muted">Loading…</p>}
                {components !== null && components.length === 0 && (
                  <p className="text-ink-muted">No component requests on this ticket.</p>
                )}
                {components?.map((c) => (
                  <div key={c.requestId} data-testid={`cr-${c.requestId}`} className={ITEM_CARD}>
                    <div className="mb-1 flex items-center justify-between gap-2">
                      <span className="font-semibold text-ink-strong">{c.componentName ?? 'Component'}</span>
                      <Badge tone={CR_STATUS_TONE[c.status] ?? 'neutral'}>{c.status}</Badge>
                    </div>
                    {c.status === 'SHIPPED' && (
                      <div className="text-xs text-ink">
                        Shipped to {c.deliveryDestination ?? '—'}
                        {c.trackingRef ? ` · tracking ${c.trackingRef}` : ''}
                      </div>
                    )}
                    {c.status === 'REJECTED' && c.rejectionReason && (
                      <div className="text-xs text-critical">Rejected: {c.rejectionReason}</div>
                    )}
                    <div className="mt-1 text-xs text-ink-muted">{c.ageDays}d old</div>
                  </div>
                ))}
              </div>
            )}

            {tab === 'Forms' && (
              <div className="flex flex-col gap-3 text-sm">
                {forms === null && <p className="text-ink-muted">Loading…</p>}
                {forms !== null && forms.length === 0 && (
                  <p className="text-ink-muted">No troubleshoot forms submitted on this ticket yet.</p>
                )}
                {forms?.map((f) => (
                  <div key={f.submissionId} data-testid={`form-${f.submissionId}`} className={ITEM_CARD}>
                    <div className="mb-1 flex items-center justify-between gap-2">
                      <span className="font-semibold text-ink-strong">{f.rootCauseCategory}</span>
                      <span className="text-xs text-ink-muted">{new Date(f.submittedAt).toLocaleString()}</span>
                    </div>
                    {f.rootCauseSubcategory && (
                      <div className="text-xs text-ink">Subcategory: {f.rootCauseSubcategory}</div>
                    )}
                    {f.actionTakenCategory && (
                      <div className="text-xs text-ink">Action: {f.actionTakenCategory}</div>
                    )}
                    {f.diagnosisNotes && <div className="mt-1 text-xs text-ink">{f.diagnosisNotes}</div>}
                    {f.componentUnavailable && (
                      <div className="mt-1 text-xs font-medium text-warning">
                        Component unavailable at submission
                      </div>
                    )}
                    <div className="mt-1 text-xs text-ink-muted">by {f.seId}</div>
                  </div>
                ))}
              </div>
            )}

            {tab === 'Verification' && (
              <div data-testid="verification-panel" className="flex flex-col gap-2 text-sm">
                {verification === null && <p className="text-ink-muted">Loading…</p>}
                {verification?.run === null && verification !== null && (
                  <p className="text-ink-muted">No verification run for this ticket yet.</p>
                )}
                {verification?.run && (
                  <dl className="grid grid-cols-[6.5rem_1fr] items-baseline gap-x-3 gap-y-2.5">
                    <dt className="text-xs text-ink-muted">Outcome</dt>
                    <dd>
                      <Badge tone={verification.run.fraudFlag ? 'critical' : 'verified'}>
                        {verification.run.badge}
                      </Badge>
                    </dd>
                    <dt className="text-xs text-ink-muted">Phase</dt>
                    <dd className="text-ink">{verification.run.phase}</dd>
                    <dt className="text-xs text-ink-muted">Pings received</dt>
                    <dd className="font-semibold text-ink-strong">{verification.run.pingsReceivedCount}</dd>
                    {verification.run.fraudFlag && (
                      <>
                        <dt className="text-xs text-ink-muted">Fraud flag</dt>
                        <dd className="font-medium text-critical">
                          Yes
                          {verification.run.firstPingDistanceMeters != null
                            ? ` · Δ${verification.run.firstPingDistanceMeters}m`
                            : ''}
                        </dd>
                      </>
                    )}
                  </dl>
                )}
              </div>
            )}

            {tab === 'Assignment History' && (
              <div data-testid="assignment-history-panel" className="text-sm">
                {/* #244 — the attempt windows, above the event timeline. The verdict is stated against
                    the live threshold because "SPECIAL" without the number it was judged against is
                    not checkable, and every window is listed (withdrawals and the live one included)
                    so the count can be reconciled against the ledger rather than taken on trust. */}
                {attempts && (
                  <div data-testid="attempt-history" className="mb-4">
                    <div className="mb-2 flex items-center justify-between">
                      <h4 className="text-xs font-semibold uppercase tracking-wide text-ink-muted">
                        Assignment attempts
                      </h4>
                      <span
                        data-testid="special-verdict"
                        className={`rounded px-1.5 py-0.5 text-xs font-medium ${
                          attempts.isSpecial ? 'bg-violet-100 text-violet-800' : 'bg-neutral-bg text-neutral'
                        }`}
                      >
                        {attempts.isSpecial ? 'SPECIAL' : 'Not special'} · {attempts.countableAttempts}/
                        {attempts.threshold} reached and unresolved
                      </span>
                    </div>
                    {attempts.attempts.length === 0 && (
                      <p className="text-ink-muted">This ticket has never been dispatched.</p>
                    )}
                    <ul className="flex flex-col gap-1">
                      {attempts.attempts.map((a) => (
                        <li
                          key={a.attemptId}
                          data-testid={`attempt-row-${a.attemptId}`}
                          className="flex flex-wrap items-baseline gap-x-2 rounded border border-line px-2 py-1"
                        >
                          <span className="text-ink-strong">{new Date(a.openedAt).toLocaleDateString()}</span>
                          <span className="text-xs text-ink-muted">{a.seName ?? a.seId ?? 'unassigned'}</span>
                          {/* A live window is in progress, not a failed attempt — saying so is the
                              difference between a history and an accusation. */}
                          {a.closedAt === null ? (
                            <span className="text-xs text-ink">in progress</span>
                          ) : (
                            <span className="font-mono text-xs text-ink">{a.removalReason}</span>
                          )}
                          <span className="text-xs text-ink-muted">
                            {a.reached ? 'reached' : 'never opened'}
                            {a.submitted ? ' · submitted' : ''}
                          </span>
                          {a.countable && (
                            <span className="rounded bg-violet-100 px-1 text-xs text-violet-800">counted</span>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {assignmentEvents.length === 0 && (
                  <p className="text-ink-muted">No assignment or override actions recorded.</p>
                )}
                <ol className="flex flex-col">
                  {assignmentEvents.map((e, i) => (
                    <TimelineItem
                      key={i}
                      title={e.reasonCode ?? e.toState}
                      meta={`${e.actorRole ?? 'system'}${e.actedAsRole ? ` (acting ${e.actedAsRole})` : ''} · ${new Date(e.at).toLocaleString()}`}
                    />
                  ))}
                </ol>
              </div>
            )}
          </div>
        )}
      </div>

      {/* FE-09 AC#3 — the recovery manual-close reason capture is a Modal (was window.prompt). */}
      <Modal
        open={recoveryCloseOpen}
        onClose={() => setRecoveryCloseOpen(false)}
        title="Manually close Recovery Ticket"
        footer={
          <>
            <Button variant="secondary" size="sm" onClick={() => setRecoveryCloseOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              size="sm"
              data-testid="recovery-close-confirm"
              disabled={!recoveryReason.trim()}
              onClick={async () => {
                if (!recoveryReason.trim() || !ticketId) return;
                try {
                  await apiManualCloseRecovery(ticketId, recoveryReason.trim());
                  setRecoveryCloseOpen(false);
                  navigate('/tickets');
                } catch {
                  setError('Manual close failed');
                  setRecoveryCloseOpen(false);
                }
              }}
            >
              Close ticket
            </Button>
          </>
        }
      >
        <label htmlFor="recovery-close-reason" className="mb-1 block text-xs font-medium text-ink-muted">
          Reason (mandatory)
        </label>
        <textarea
          id="recovery-close-reason"
          data-testid="recovery-close-reason"
          value={recoveryReason}
          onChange={(e) => setRecoveryReason(e.target.value)}
          className="min-h-[5rem] w-full rounded-md border border-line bg-surface-card px-3 py-2 text-sm text-ink-strong"
          placeholder="Why is this Recovery Ticket being closed manually?"
        />
      </Modal>
    </aside>
  );
}
