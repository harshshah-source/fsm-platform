import { useEffect, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useAuth } from '../../auth/AuthProvider';
import { apiComponentRequestsByTicket, type ComponentRequestRow } from '../../api/componentRequests';
import { apiManualCloseRecovery } from '../../api/recovery';
import { apiTicketDetail, apiTicketForms, type TicketDetail, type TicketForm } from '../../api/tickets';
import { apiTicketVerification, type TicketVerification } from '../../api/verification';
import { Button } from '../../components/ui';
import { Modal } from '../../components/overlay/Modal';
import { formatPlantDisplayName } from '../../lib/plantNames';
import { BucketBadge, InlineBadges } from './ticketBadges';

const RECOVERY_TERMINAL = new Set(['CLOSED', 'FAILED_RECOVERY']);

type TabId = 'Overview' | 'Lifecycle' | 'Forms' | 'Verification' | 'Components' | 'Assignment History';
const TABS: TabId[] = ['Overview', 'Lifecycle', 'Forms', 'Verification', 'Components', 'Assignment History'];

// Every tab now renders real data; no stub tabs remain.

const CR_STATUS_CLASS: Record<string, string> = {
  REQUESTED: 'bg-amber-100 text-amber-800',
  APPROVED: 'bg-blue-100 text-blue-800',
  SHIPPED: 'bg-violet-100 text-violet-800',
  RECEIVED: 'bg-green-100 text-green-800',
  REJECTED: 'bg-rose-100 text-rose-800',
};

/**
 * Ticket Detail Drawer (Issue 07, `/tickets/:ticketId`). Slides in over the list (the list stays
 * mounted via its parent route). Overview + Lifecycle render real data from `/api/tickets/:id`; the
 * remaining tabs are graceful stubs that fill in as their owning issues land.
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
      className="ml-4 w-96 shrink-0 border-l bg-white p-4 shadow-lg"
    >
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-lg font-semibold">Ticket detail</h3>
        <button
          type="button"
          onClick={() => navigate('/tickets')}
          aria-label="Close ticket detail"
          className="rounded border px-2 py-0.5 text-sm"
        >
          ✕
        </button>
      </div>

      {error && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}

      <div role="tablist" aria-label="Ticket detail tabs" className="mb-3 flex flex-wrap gap-1 border-b text-sm">
        {TABS.map((t) => (
          <button
            key={t}
            role="tab"
            type="button"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={`px-2 py-1 ${tab === t ? 'border-b-2 border-slate-800 font-medium' : 'text-slate-500'}`}
          >
            {t}
          </button>
        ))}
      </div>

      {!ticket && !error && <p className="text-sm text-slate-500">Loading…</p>}

      {ticket && (
        <div role="tabpanel">
          {tab === 'Overview' && (
            <dl className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-1 text-sm">
              <dt className="text-slate-500">Device</dt>
              <dd className="font-medium">{ticket.deviceId}</dd>
              {ticket.vehicleNo && (
                <>
                  <dt className="text-slate-500">Vehicle</dt>
                  <dd className="font-mono text-xs">{ticket.vehicleNo}</dd>
                </>
              )}
              <dt className="text-slate-500">Work type</dt>
              <dd>{ticket.workType}</dd>
              <dt className="text-slate-500">Status</dt>
              <dd>{ticket.status}</dd>
              <dt className="text-slate-500">Company</dt>
              <dd>
                {ticket.companyName ?? `#${ticket.companyId}`}{' '}
                <span className="text-xs text-slate-400">({ticket.companyTier})</span>
              </dd>
              <dt className="text-slate-500">Plant</dt>
              <dd>{ticket.plantName ? formatPlantDisplayName(ticket.plantName) : `#${ticket.plantId}`}</dd>
              {/* Live assignment context (Issue 122b): who holds the ticket, and through which batch. */}
              <dt className="text-slate-500">Assigned SE</dt>
              <dd data-testid="drawer-assigned-se">
                {ticket.assignmentState === 'FORMALLY_ASSIGNED' ? (
                  <span>
                    <span className="font-medium">{ticket.assignedSeName ?? ticket.assignedSeId ?? '—'}</span>
                    {ticket.overridden && (
                      <span className="ml-1.5 rounded bg-blue-100 px-1.5 py-0.5 text-[10px] font-semibold text-blue-800">
                        OVERRIDDEN
                      </span>
                    )}
                    {ticket.batchId && (
                      <span className="block text-xs text-slate-400">
                        Batch #{ticket.batchId}
                        {ticket.scheduleId ? ` · Schedule #${ticket.scheduleId}` : ''}
                      </span>
                    )}
                  </span>
                ) : (
                  <span className="text-amber-700">Unassigned</span>
                )}
              </dd>
              <dt className="text-slate-500">Inactive for</dt>
              <dd>
                <BucketBadge bucket={ticket.slaBucket} latestGpsDatetime={ticket.latestGpsDatetime} />
              </dd>
              <dt className="text-slate-500">Created</dt>
              <dd className="text-xs">{new Date(ticket.createdAt).toLocaleString()}</dd>
              <dt className="text-slate-500">Flags</dt>
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
                className="mt-4 rounded border border-rose-300 px-2 py-1 text-xs text-rose-700 hover:bg-rose-50"
              >
                Manually close Recovery Ticket
              </button>
            )}

          {tab === 'Lifecycle' && (
            <ol className="flex flex-col gap-2 text-sm">
              {ticket.lifecycle.length === 0 && <li className="text-slate-500">No transitions yet.</li>}
              {ticket.lifecycle.map((e, i) => (
                <li key={i} className="border-l-2 border-slate-200 pl-2">
                  <div className="font-medium">{e.toState}</div>
                  <div className="text-xs text-slate-500">
                    {e.fromState ? `from ${e.fromState} · ` : ''}
                    {e.actorRole ?? 'system'} · {new Date(e.at).toLocaleString()}
                  </div>
                </li>
              ))}
            </ol>
          )}

          {tab === 'Components' && (
            <div className="flex flex-col gap-3 text-sm">
              {ticket.failureCycleState === 'WAITING_COMPONENT' && (
                <div
                  data-testid="waiting-component-badge"
                  className="rounded border border-amber-300 bg-amber-50 px-2 py-1 text-xs text-amber-800"
                >
                  WAITING_COMPONENT — primary SLA paused
                  {ticket.waitingComponentSince
                    ? ` since ${new Date(ticket.waitingComponentSince).toLocaleString()}`
                    : ''}
                </div>
              )}

              {components === null && <p className="text-slate-500">Loading…</p>}
              {components !== null && components.length === 0 && (
                <p className="text-slate-400">No component requests on this ticket.</p>
              )}
              {components?.map((c) => (
                <div key={c.requestId} data-testid={`cr-${c.requestId}`} className="rounded border p-2">
                  <div className="mb-1 flex items-center justify-between">
                    <span className="font-medium">{c.componentName ?? 'Component'}</span>
                    <span className={`rounded px-2 py-0.5 text-xs ${CR_STATUS_CLASS[c.status] ?? 'bg-slate-100 text-slate-700'}`}>
                      {c.status}
                    </span>
                  </div>
                  {c.status === 'SHIPPED' && (
                    <div className="text-xs text-slate-600">
                      Shipped to {c.deliveryDestination ?? '—'}
                      {c.trackingRef ? ` · tracking ${c.trackingRef}` : ''}
                    </div>
                  )}
                  {c.status === 'REJECTED' && c.rejectionReason && (
                    <div className="text-xs text-rose-700">Rejected: {c.rejectionReason}</div>
                  )}
                  <div className="mt-1 text-xs text-slate-400">{c.ageDays}d old</div>
                </div>
              ))}
            </div>
          )}

          {tab === 'Forms' && (
            <div className="flex flex-col gap-3 text-sm">
              {forms === null && <p className="text-slate-500">Loading…</p>}
              {forms !== null && forms.length === 0 && (
                <p className="text-slate-400">No troubleshoot forms submitted on this ticket yet.</p>
              )}
              {forms?.map((f) => (
                <div key={f.submissionId} data-testid={`form-${f.submissionId}`} className="rounded border p-2">
                  <div className="mb-1 flex items-center justify-between">
                    <span className="font-medium">{f.rootCauseCategory}</span>
                    <span className="text-xs text-slate-400">{new Date(f.submittedAt).toLocaleString()}</span>
                  </div>
                  {f.rootCauseSubcategory && (
                    <div className="text-xs text-slate-600">Subcategory: {f.rootCauseSubcategory}</div>
                  )}
                  {f.actionTakenCategory && (
                    <div className="text-xs text-slate-600">Action: {f.actionTakenCategory}</div>
                  )}
                  {f.diagnosisNotes && <div className="mt-1 text-xs text-slate-700">{f.diagnosisNotes}</div>}
                  {f.componentUnavailable && (
                    <div className="mt-1 text-xs text-amber-700">Component unavailable at submission</div>
                  )}
                  <div className="mt-1 text-xs text-slate-400">by {f.seId}</div>
                </div>
              ))}
            </div>
          )}

          {tab === 'Verification' && (
            <div data-testid="verification-panel" className="flex flex-col gap-2 text-sm">
              {verification === null && <p className="text-slate-500">Loading…</p>}
              {verification?.run === null && verification !== null && (
                <p className="text-slate-400">No verification run for this ticket yet.</p>
              )}
              {verification?.run && (
                <dl className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-1">
                  <dt className="text-slate-500">Outcome</dt>
                  <dd className="font-medium">{verification.run.badge}</dd>
                  <dt className="text-slate-500">Phase</dt>
                  <dd>{verification.run.phase}</dd>
                  <dt className="text-slate-500">Pings received</dt>
                  <dd>{verification.run.pingsReceivedCount}</dd>
                  {verification.run.fraudFlag && (
                    <>
                      <dt className="text-slate-500">Fraud flag</dt>
                      <dd className="text-rose-700">
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
            <div data-testid="assignment-history-panel" className="flex flex-col gap-2 text-sm">
              {assignmentEvents.length === 0 && (
                <p className="text-slate-400">No assignment or override actions recorded.</p>
              )}
              {assignmentEvents.map((e, i) => (
                <div key={i} className="border-l-2 border-slate-200 pl-2">
                  <div className="font-medium">{e.reasonCode ?? e.toState}</div>
                  <div className="text-xs text-slate-500">
                    {e.actorRole ?? 'system'}
                    {e.actedAsRole ? ` (acting ${e.actedAsRole})` : ''} · {new Date(e.at).toLocaleString()}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

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
